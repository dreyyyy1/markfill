import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Tape } from "./tape.js";

const FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "data", "receipts.json");

export interface Receipt {
  id: string;
  t: number;
  side: "buy" | "sell";
  ticker: string;
  usd: number;
  shares?: number;
  nyse?: number;
  onchain?: number;
  premiumBps?: number | null;
  session: string;
  verdict: string;
  bandBps: number;
  tx?: string;
  note: string;
}

function load(): Receipt[] {
  try {
    return JSON.parse(fs.readFileSync(FILE, "utf8")) as Receipt[];
  } catch {
    return [];
  }
}

function save(rows: Receipt[]) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(rows.slice(-80), null, 2));
}

export function addReceipt(partial: Omit<Receipt, "id" | "t">) {
  const row: Receipt = {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    t: Date.now(),
    ...partial,
  };
  const rows = load();
  rows.push(row);
  save(rows);
  return row;
}

export function listReceipts() {
  return load().slice().reverse();
}

export function stampTx(id: string, tx: string) {
  const rows = load();
  const hit = rows.find((r) => r.id === id);
  if (!hit) return null;
  hit.tx = tx;
  save(rows);
  return hit;
}

export function receiptFromTape(tape: Tape, side: "buy" | "sell", usd: number, shares?: number, tx?: string): Receipt {
  return addReceipt({
    side,
    ticker: tape.ticker,
    usd,
    shares,
    nyse: tape.nyse?.price,
    onchain: tape.onchain?.price,
    premiumBps: tape.premiumBps,
    session: tape.session,
    verdict: tape.verdict,
    bandBps: tape.bandBps,
    tx,
    note:
      side === "buy"
        ? `bought ${tape.xSymbol} at ${tape.premiumBps?.toFixed(1)} bps vs NYSE (${tape.session})`
        : `sold ${tape.xSymbol} at ${tape.premiumBps?.toFixed(1)} bps vs NYSE (${tape.session})`,
  });
}
