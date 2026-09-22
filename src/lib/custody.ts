import fs from "node:fs";
import path from "node:path";
import { createHmac } from "node:crypto";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  createTransferCheckedInstruction,
  getAccount,
  getAssociatedTokenAddress,
} from "@solana/spl-token";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { USDC } from "./stocks.js";
import { ensureUser, pinDeskWallet } from "./ledger.js";

const ENV = path.resolve(process.cwd(), ".env");

export function rpc() {
  return process.env.SOL_RPC?.trim() || "https://api.mainnet-beta.solana.com";
}

export function connection() {
  return new Connection(rpc(), "confirmed");
}

export function isLive() {
  return true;
}

export function ensureMasterSecret(): string {
  let raw = process.env.MARKFILL_SECRET?.trim();
  if (raw) return raw;
  const kp = Keypair.generate();
  raw = bs58.encode(kp.secretKey);
  process.env.MARKFILL_SECRET = raw;
  try {
    const prev = fs.existsSync(ENV) ? fs.readFileSync(ENV, "utf8") : "";
    if (!prev.includes("MARKFILL_SECRET=")) fs.appendFileSync(ENV, `\nMARKFILL_SECRET=${raw}\n`);
  } catch {
    /* set MARKFILL_SECRET on the host */
  }
  return raw;
}

/** One desk wallet per main wallet. Created once, then the stored key is reused forever. */
export function deskKeypair(owner: string): Keypair {
  if (!owner) throw new Error("owner required");
  const u = ensureUser(owner);
  if (u.deskSecret && u.deskAddress) {
    return Keypair.fromSecretKey(bs58.decode(u.deskSecret));
  }
  const seed = createHmac("sha256", ensureMasterSecret()).update(`markfill-desk:${owner}`).digest();
  const kp = Keypair.fromSeed(seed);
  pinDeskWallet(owner, kp.publicKey.toBase58(), bs58.encode(kp.secretKey));
  return kp;
}

export function deskAddress(owner: string) {
  return deskKeypair(owner).publicKey.toBase58();
}

async function mintProgram(conn: Connection, mint: PublicKey) {
  const info = await conn.getAccountInfo(mint);
  if (!info) return TOKEN_PROGRAM_ID;
  return info.owner.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
}

export async function ataFor(mint: string, owner: PublicKey) {
  const conn = connection();
  const m = new PublicKey(mint);
  const program = await mintProgram(conn, m);
  const ata = await getAssociatedTokenAddress(m, owner, false, program, ASSOCIATED_TOKEN_PROGRAM_ID);
  return { ata, program, mint: m };
}

export async function deskInfo(owner?: string) {
  const live = isLive();
  if (!owner) {
    return {
      live,
      perUser: true,
      note: "Connect your wallet to see your personal MarkFill address. Nobody else shares it.",
    };
  }
  const kp = deskKeypair(owner);
  const conn = connection();
  const sol = (await conn.getBalance(kp.publicKey)) / 1e9;
  let usdc = 0;
  try {
    const { ata, program } = await ataFor(USDC, kp.publicKey);
    const acc = await getAccount(conn, ata, "confirmed", program);
    usdc = Number(acc.amount) / 1e6;
  } catch {
    usdc = 0;
  }
  return {
    live,
    perUser: true,
    address: kp.publicKey.toBase58(),
    sol,
    usdc,
    note: "This address is only yours. Send USDC plus a little SOL for fees. Export the key if you want to control it in Phantom.",
  };
}

async function ensureAta(owner: PublicKey, mint: string, payer: Keypair) {
  const conn = connection();
  const { ata, program, mint: m } = await ataFor(mint, owner);
  const info = await conn.getAccountInfo(ata);
  if (info) return { ata, program, mint: m };
  const ix = createAssociatedTokenAccountInstruction(
    payer.publicKey,
    ata,
    owner,
    m,
    program,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  const tx = new Transaction().add(ix);
  tx.feePayer = payer.publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
  await sendAndConfirmTransaction(conn, tx, [payer]);
  return { ata, program, mint: m };
}

export async function sendTokens(opts: {
  owner: string;
  mint: string;
  to: string;
  amount: number;
  decimals: number;
}) {
  const kp = deskKeypair(opts.owner);
  const conn = connection();
  const dest = new PublicKey(opts.to);
  const from = await ensureAta(kp.publicKey, opts.mint, kp);
  const to = await ensureAta(dest, opts.mint, kp);
  const raw = BigInt(Math.round(opts.amount * 10 ** opts.decimals));
  if (raw <= 0n) throw new Error("amount too small");
  const ix = createTransferCheckedInstruction(
    from.ata,
    from.mint,
    to.ata,
    kp.publicKey,
    raw,
    opts.decimals,
    [],
    from.program,
  );
  const tx = new Transaction().add(ix);
  tx.feePayer = kp.publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
  const sig = await sendAndConfirmTransaction(conn, tx, [kp]);
  return { paper: false, signature: sig };
}

export async function scanUsdcDeposits(owner: string) {
  const kp = deskKeypair(owner);
  const conn = connection();
  const { ata } = await ataFor(USDC, kp.publicKey);
  const sigs = await conn.getSignaturesForAddress(ata, { limit: 25 });
  const hits: { owner: string; amount: number; sig: string }[] = [];
  for (const s of sigs) {
    if (s.err) continue;
    const tx = await conn.getParsedTransaction(s.signature, { maxSupportedTransactionVersion: 0 });
    if (!tx) continue;
    const ixs = [
      ...(tx.transaction.message.instructions as any[]),
      ...((tx.meta?.innerInstructions || []).flatMap((i) => i.instructions) as any[]),
    ];
    for (const ix of ixs) {
      const parsed = ix.parsed;
      if (!parsed || (parsed.type !== "transfer" && parsed.type !== "transferChecked")) continue;
      const info = parsed.info || {};
      const dest = String(info.destination || "");
      if (dest !== ata.toBase58()) continue;
      const raw = info.tokenAmount?.amount != null ? Number(info.tokenAmount.amount) : Number(info.amount);
      const decimals = info.tokenAmount?.decimals != null ? Number(info.tokenAmount.decimals) : 6;
      const amount = raw / 10 ** decimals;
      if (!amount) continue;
      hits.push({ owner, amount, sig: s.signature });
    }
  }
  return hits;
}

export function verifyOwnerSignature(owner: string, message: string, signature: string) {
  const msg = new TextEncoder().encode(message);
  let sig: Uint8Array;
  try {
    sig = bs58.decode(signature);
  } catch {
    sig = Uint8Array.from(Buffer.from(signature, "base64"));
  }
  const pub = new PublicKey(owner).toBytes();
  return nacl.sign.detached.verify(msg, sig, pub);
}

export function exportDeskSecret(owner: string) {
  return bs58.encode(deskKeypair(owner).secretKey);
}
