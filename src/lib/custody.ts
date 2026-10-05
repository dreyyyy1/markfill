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
import { STOCKS, USDC } from "./stocks.js";
import { getPinnedDesk, oid, pinDeskWallet } from "./ledger.js";

const ENV = path.resolve(process.cwd(), ".env");
const DATA = path.resolve(process.cwd(), "data");
const MASTER_FILE = path.join(DATA, "master.key");
const DESKS_FILE = path.join(DATA, "desks.json");

export function rpc() {
  return process.env.SOL_RPC?.trim() || "https://api.mainnet-beta.solana.com";
}

export function connection() {
  return new Connection(rpc(), "confirmed");
}

export function isLive() {
  return true;
}

function readEnvSecret(): string {
  const fromProc = process.env.MARKFILL_SECRET?.trim();
  if (fromProc) return fromProc;
  try {
    const text = fs.readFileSync(ENV, "utf8");
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith("MARKFILL_SECRET=")) continue;
      const v = line.slice("MARKFILL_SECRET=".length).trim();
      if (v) return v;
    }
  } catch {
    /* no .env */
  }
  try {
    const fromFile = fs.readFileSync(MASTER_FILE, "utf8").trim();
    if (fromFile) return fromFile;
  } catch {
    /* no master file */
  }
  return "";
}

function persistMaster(raw: string) {
  process.env.MARKFILL_SECRET = raw;
  try {
    fs.mkdirSync(DATA, { recursive: true });
    fs.writeFileSync(MASTER_FILE, raw);
  } catch {
    /* ignore */
  }
  try {
    let prev = fs.existsSync(ENV) ? fs.readFileSync(ENV, "utf8") : "";
    if (/^MARKFILL_SECRET=/m.test(prev)) {
      prev = prev.replace(/^MARKFILL_SECRET=.*$/m, `MARKFILL_SECRET=${raw}`);
    } else {
      prev += `\nMARKFILL_SECRET=${raw}\n`;
    }
    fs.writeFileSync(ENV, prev);
  } catch {
    /* set MARKFILL_SECRET on Render */
  }
}

// LEGACY CUSTODIAL PATH — tracked by scripts/check-no-secrets.mjs (warns, does not fail).
// Loads or creates MARKFILL_SECRET. Slated for removal with deskKeypair once
// scripts/sweep-custodial.ts has been confirmed against production.
export function ensureMasterSecret(): string {
  const existing = readEnvSecret();
  if (existing) {
    process.env.MARKFILL_SECRET = existing;
    return existing;
  }
  const raw = bs58.encode(Keypair.generate().secretKey);
  persistMaster(raw);
  return raw;
}

function loadDesks(): Record<string, { address: string; secret: string }> {
  try {
    return JSON.parse(fs.readFileSync(DESKS_FILE, "utf8"));
  } catch {
    return {};
  }
}

function saveDesks(map: Record<string, { address: string; secret: string }>) {
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(DESKS_FILE, JSON.stringify(map, null, 2));
}

/**
 * LEGACY CUSTODIAL PATH — tracked by scripts/check-no-secrets.mjs (warns, does not fail).
 * Derives a desk key from MARKFILL_SECRET and stores it in plaintext.
 * Slated for removal once scripts/sweep-custodial.ts has been confirmed against
 * production. Do not add new callers. Vault fills use keeperKeypair(), not this.
 */
export function deskKeypair(owner: string): Keypair {
  if (!owner) throw new Error("owner required");
  const id = oid(owner);
  const desks = loadDesks();
  const pinned = desks[id] || getPinnedDesk(id);
  if (pinned?.secret) {
    const kp = Keypair.fromSecretKey(bs58.decode(pinned.secret));
    if (!desks[id]) {
      desks[id] = { address: kp.publicKey.toBase58(), secret: pinned.secret };
      saveDesks(desks);
    }
    pinDeskWallet(id, kp.publicKey.toBase58(), pinned.secret);
    return kp;
  }
  const seed = createHmac("sha256", ensureMasterSecret()).update(`markfill-desk:${id}`).digest();
  const kp = Keypair.fromSeed(seed);
  const secret = bs58.encode(kp.secretKey);
  const address = kp.publicKey.toBase58();
  desks[id] = { address, secret };
  saveDesks(desks);
  pinDeskWallet(id, address, secret);
  return kp;
}

export function deskAddress(owner: string) {
  return deskKeypair(owner).publicKey.toBase58();
}

/** Fee payer for permissionless vault fills. Pays Solana fees only. Not a desk wallet. */
export function keeperKeypair(): Keypair {
  const raw = process.env.MARKFILL_KEEPER?.trim();
  if (!raw) throw new Error("MARKFILL_KEEPER is not set — vault fills need a fee-payer key");
  return Keypair.fromSecretKey(bs58.decode(raw));
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

export async function onchainBalances(owner: string) {
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
  const stocks: { ticker: string; xSymbol: string; shares: number; txs: string[] }[] = [];
  for (const s of STOCKS) {
    try {
      const { ata, program } = await ataFor(s.mint, kp.publicKey);
      const acc = await getAccount(conn, ata, "confirmed", program);
      const shares = Number(acc.amount) / 10 ** s.decimals;
      if (shares > 0) stocks.push({ ticker: s.ticker, xSymbol: s.xSymbol, shares, txs: await buySignatures(conn, ata) });
    } catch {
      /* no account yet */
    }
  }
  return { sol, usdc, stocks };
}

const buyTxCache = new Map<string, { at: number; txs: string[] }>();

/** Signatures that increased this token account. Those are the buys still sitting in the wallet. */
async function buySignatures(conn: Connection, ata: PublicKey): Promise<string[]> {
  const key = ata.toBase58();
  const hit = buyTxCache.get(key);
  if (hit && Date.now() - hit.at < 60_000) return hit.txs;
  const txs = await loadBuySignatures(conn, ata);
  buyTxCache.set(key, { at: Date.now(), txs });
  return txs;
}

async function loadBuySignatures(conn: Connection, ata: PublicKey): Promise<string[]> {
  let listed;
  try {
    listed = await conn.getSignaturesForAddress(ata, { limit: 8 });
  } catch {
    return [];
  }
  const incoming: string[] = [];
  let fallback = "";
  let parsed = 0;
  for (const row of listed) {
    if (row.err) continue;
    if (!fallback) fallback = row.signature;
    try {
      const tx = await conn.getParsedTransaction(row.signature, { maxSupportedTransactionVersion: 0 });
      if (!tx?.meta) continue;
      parsed++;
      const keys = accountKeysOf(tx);
      const idx = keys.indexOf(ata.toBase58());
      if (idx < 0) continue;
      const pre = tokenUiAt(tx.meta.preTokenBalances, idx);
      const post = tokenUiAt(tx.meta.postTokenBalances, idx);
      if (post > pre + 1e-12) incoming.push(row.signature);
    } catch {
      /* a later row may still parse */
    }
    if (incoming.length >= 5) break;
  }
  if (incoming.length) return incoming;
  return parsed ? [] : fallback ? [fallback] : [];
}

function accountKeysOf(tx: {
  transaction: { message: { accountKeys: { pubkey: PublicKey }[] } };
  meta: { loadedAddresses?: { writable: PublicKey[]; readonly: PublicKey[] } } | null;
}) {
  const meta = tx.meta;
  return [
    ...tx.transaction.message.accountKeys.map((k) => k.pubkey.toBase58()),
    ...(meta?.loadedAddresses?.writable || []).map((k) => k.toBase58()),
    ...(meta?.loadedAddresses?.readonly || []).map((k) => k.toBase58()),
  ];
}

function tokenUiAt(rows: { accountIndex: number; uiTokenAmount: { uiAmount: number | null } }[] | null | undefined, idx: number) {
  const hit = rows?.find((b) => b.accountIndex === idx);
  return Number(hit?.uiTokenAmount.uiAmount || 0);
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

/** Sends the entire token balance. The amount is the raw account balance, not a rounded float. */
export async function sendFullBalance(opts: { owner: string; mint: string; to: string; decimals: number }) {
  const kp = deskKeypair(opts.owner);
  const conn = connection();
  const from = await ataFor(opts.mint, kp.publicKey);
  let raw: bigint;
  try {
    const acc = await getAccount(conn, from.ata, "confirmed", from.program);
    raw = acc.amount;
  } catch {
    return null;
  }
  if (raw <= 0n) return null;
  const dest = await ensureAta(new PublicKey(opts.to), opts.mint, kp);
  const ix = createTransferCheckedInstruction(
    from.ata,
    from.mint,
    dest.ata,
    kp.publicKey,
    raw,
    opts.decimals,
    [],
    from.program,
  );
  const tx = new Transaction().add(ix);
  tx.feePayer = kp.publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
  const signature = await sendAndConfirmTransaction(conn, tx, [kp]);
  return { paper: false as const, signature, amount: Number(raw) / 10 ** opts.decimals };
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
