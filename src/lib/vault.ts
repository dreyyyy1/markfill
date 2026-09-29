import { createHash } from "node:crypto";
import {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  Transaction,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress,
} from "@solana/spl-token";
import { USDC } from "./stocks.js";

/** Placeholder until `anchor deploy`. Override with MARKFILL_VAULT_PROGRAM. */
export const VAULT_PROGRAM = new PublicKey(
  process.env.MARKFILL_VAULT_PROGRAM?.trim() || "CYJsEDDTrZQ9zRjPfUrKAawjRfvofH7afeeTPVNHrrsw",
);

/** Jupiter v6 aggregator — verified 2026-09. */
export const JUPITER_V6 = new PublicKey("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");

const VAULT_SEED = Buffer.from("vault");
const ORDER_SEED = Buffer.from("order");

function disc(name: string) {
  return createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
}

function u64le(n: number | bigint) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
}

function i64le(n: number) {
  const b = Buffer.alloc(8);
  b.writeBigInt64LE(BigInt(n));
  return b;
}

export function vaultPda(owner: PublicKey) {
  return PublicKey.findProgramAddressSync([VAULT_SEED, owner.toBuffer()], VAULT_PROGRAM);
}

export function orderPda(owner: PublicKey, orderId: number | bigint) {
  return PublicKey.findProgramAddressSync(
    [ORDER_SEED, owner.toBuffer(), u64le(orderId)],
    VAULT_PROGRAM,
  );
}

export async function vaultUsdcAta(owner: PublicKey) {
  const [vault] = vaultPda(owner);
  const ata = await getAssociatedTokenAddress(new PublicKey(USDC), vault, true);
  return { vault, ata };
}

export async function vaultStockAta(owner: PublicKey, mint: PublicKey) {
  const [vault] = vaultPda(owner);
  const ata = await getAssociatedTokenAddress(mint, vault, true);
  return { vault, ata };
}

export function initializeVaultIx(user: PublicKey) {
  const [vault] = vaultPda(user);
  return new TransactionInstruction({
    programId: VAULT_PROGRAM,
    keys: [
      { pubkey: user, isSigner: true, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(disc("initialize_vault")),
  });
}

export async function depositIx(user: PublicKey, userUsdc: PublicKey, amount: bigint) {
  const { vault, ata: vaultUsdc } = await vaultUsdcAta(user);
  const data = Buffer.concat([Buffer.from(disc("deposit")), u64le(amount)]);
  return new TransactionInstruction({
    programId: VAULT_PROGRAM,
    keys: [
      { pubkey: user, isSigner: true, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: false },
      { pubkey: new PublicKey(USDC), isSigner: false, isWritable: false },
      { pubkey: userUsdc, isSigner: false, isWritable: true },
      { pubkey: vaultUsdc, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data,
  });
}

export async function placeOrderIx(opts: {
  user: PublicKey;
  stockMint: PublicKey;
  usdAmount: bigint;
  bandBps: number;
  side: 0 | 1;
  expiryTs: number;
  pythFeedId: Buffer;
  orderId: bigint;
}) {
  const [vault] = vaultPda(opts.user);
  const [order] = orderPda(opts.user, opts.orderId);
  const vaultUsdc = await getAssociatedTokenAddress(new PublicKey(USDC), vault, true);
  const vaultStock = await getAssociatedTokenAddress(opts.stockMint, vault, true);
  const data = Buffer.concat([
    Buffer.from(disc("place_order")),
    u64le(opts.usdAmount),
    (() => {
      const b = Buffer.alloc(2);
      b.writeUInt16LE(opts.bandBps);
      return b;
    })(),
    Buffer.from([opts.side]),
    i64le(opts.expiryTs),
    opts.pythFeedId.subarray(0, 32),
  ]);
  return new TransactionInstruction({
    programId: VAULT_PROGRAM,
    keys: [
      { pubkey: opts.user, isSigner: true, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: opts.stockMint, isSigner: false, isWritable: false },
      { pubkey: new PublicKey(USDC), isSigner: false, isWritable: false },
      { pubkey: vaultUsdc, isSigner: false, isWritable: false },
      { pubkey: vaultStock, isSigner: false, isWritable: false },
      { pubkey: order, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

export function cancelOrderIx(user: PublicKey, orderId: bigint) {
  const [order] = orderPda(user, orderId);
  return new TransactionInstruction({
    programId: VAULT_PROGRAM,
    keys: [
      { pubkey: user, isSigner: true, isWritable: true },
      { pubkey: order, isSigner: false, isWritable: true },
    ],
    data: Buffer.from(disc("cancel_order")),
  });
}

export async function withdrawIx(user: PublicKey, mint: PublicKey, ownerAta: PublicKey, amount: bigint) {
  const [vault] = vaultPda(user);
  const vaultAta = await getAssociatedTokenAddress(mint, vault, true);
  const data = Buffer.concat([Buffer.from(disc("withdraw")), u64le(amount)]);
  return new TransactionInstruction({
    programId: VAULT_PROGRAM,
    keys: [
      { pubkey: user, isSigner: true, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: vaultAta, isSigner: false, isWritable: true },
      { pubkey: ownerAta, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data,
  });
}

export function txToB64(tx: Transaction) {
  return Buffer.from(tx.serialize({ requireAllSignatures: false, verifySignatures: false })).toString("base64");
}
