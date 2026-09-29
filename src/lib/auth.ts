import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import nacl from "tweetnacl";

export function oid(owner: string) {
  return new PublicKey(owner.trim()).toBase58();
}

export function verifyOwnerSignature(owner: string, message: string, signature: string) {
  const msg = new TextEncoder().encode(message);
  let sig: Uint8Array;
  try {
    sig = bs58.decode(signature);
  } catch {
    sig = Uint8Array.from(Buffer.from(signature, "base64"));
  }
  const pub = new PublicKey(oid(owner)).toBytes();
  return nacl.sign.detached.verify(msg, sig, pub);
}

/** Every state-changing API call must include a fresh owner-signed message. */
export function requireOwnerSig(opts: { owner: string; message: string; signature: string; action: string }) {
  const owner = oid(opts.owner);
  if (!opts.message.includes(opts.owner) && !opts.message.includes(owner)) {
    throw new Error("message must include your wallet");
  }
  if (!opts.message.includes(opts.action)) throw new Error("message must include the action");
  const m = opts.message.match(/ts=(\d+)/);
  const ts = m ? Number(m[1]) : 0;
  if (!ts || Math.abs(Date.now() - ts) > 5 * 60 * 1000) throw new Error("signature expired — sign again");
  if (!verifyOwnerSignature(owner, opts.message, opts.signature)) {
    throw new Error("wallet signature does not match");
  }
  return owner;
}

export function vaultMode() {
  return Boolean(process.env.MARKFILL_VAULT_PROGRAM?.trim() || process.env.MARKFILL_VAULT === "1");
}
