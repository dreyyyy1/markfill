import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PublicKey } from "@solana/web3.js";

export function oid(owner: string) {
  return new PublicKey(owner.trim()).toBase58();
}

const FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "data", "ledger.json");

export interface Holding {
  shares: number;
  costUsd: number;
}

export interface UserFill {
  t: number;
  side: "buy" | "sell";
  ticker: string;
  usd: number;
  shares: number;
  premiumBps?: number | null;
  session?: string;
  tx?: string;
  note: string;
}

export interface UserAccount {
  owner: string;
  deskAddress?: string;
  deskSecret?: string;
  usdc: number;
  holdings: Record<string, Holding>;
  fills: UserFill[];
  deposits: { t: number; amount: number; sig: string }[];
  withdrawals: { t: number; kind: string; amount: number; sig: string }[];
}

export interface ArmOrder {
  owner: string;
  ticker: string;
  usd: number;
  bandBps: number;
  side: "buy" | "sell";
  armed: boolean;
  createdAt: number;
}

export type ArmStatus = "pending" | "executed" | "failed";

/** Survives a page reload. The live `arms` list is only what the keeper may still fill. */
export interface ArmRecord {
  owner: string;
  ticker: string;
  usd: number;
  bandBps: number;
  side: "buy" | "sell";
  status: ArmStatus;
  createdAt: number;
  updatedAt: number;
  tx?: string;
  error?: string;
}

interface Ledger {
  processed: string[];
  users: Record<string, UserAccount>;
  arms: ArmOrder[];
  armRecords: ArmRecord[];
}

function empty(): Ledger {
  return { processed: [], users: {}, arms: [], armRecords: [] };
}

function load(): Ledger {
  try {
    return { ...empty(), ...JSON.parse(fs.readFileSync(FILE, "utf8")) };
  } catch {
    return empty();
  }
}

function save(l: Ledger) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(l, null, 2));
  fs.renameSync(tmp, FILE);
}

export function ensureUser(owner: string): UserAccount {
  const id = oid(owner);
  const l = load();
  if (!l.users[id]) {
    l.users[id] = { owner: id, usdc: 0, holdings: {}, fills: [], deposits: [], withdrawals: [] };
    save(l);
  }
  return l.users[id];
}

/**
 * LEGACY — REMOVE AFTER SWEEP.
 * Writes the raw desk secret in plaintext to data/ledger.json.
 * Slated for deletion once scripts/sweep-custodial.ts --live has been
 * confirmed against the live Render desks.
 * Do not add new callers. Do not delete this until that --live sweep is confirmed.
 */
export function pinDeskWallet(owner: string, address: string, secret: string) {
  const id = oid(owner);
  const l = load();
  if (!l.users[id]) {
    l.users[id] = { owner: id, usdc: 0, holdings: {}, fills: [], deposits: [], withdrawals: [] };
  }
  if (l.users[id].deskAddress && l.users[id].deskSecret) {
    return l.users[id];
  }
  l.users[id].deskAddress = address;
  l.users[id].deskSecret = secret;
  l.users[id].owner = id;
  save(l);
  return l.users[id];
}

export function getPinnedDesk(owner: string): { address: string; secret: string } | null {
  const id = oid(owner);
  const u = load().users[id];
  if (u?.deskAddress && u?.deskSecret) return { address: u.deskAddress, secret: u.deskSecret };
  return null;
}

export function listOwners() {
  const l = load();
  const fromUsers = Object.keys(l.users);
  const fromArms = l.arms.map((a) => a.owner);
  return [...new Set([...fromUsers, ...fromArms])];
}

export function listDeskPublic() {
  const l = load();
  return listOwners().map((owner) => ({
    owner,
    address: l.users[owner]?.deskAddress || null,
  }));
}

export function getUser(owner: string): UserAccount {
  return ensureUser(owner);
}

export function seenSig(sig: string) {
  return load().processed.includes(sig);
}

export function creditDeposit(owner: string, amount: number, sig: string) {
  const id = oid(owner);
  const l = load();
  if (l.processed.includes(sig)) return l.users[id];
  if (!l.users[id]) {
    l.users[id] = { owner: id, usdc: 0, holdings: {}, fills: [], deposits: [], withdrawals: [] };
  }
  l.users[id].usdc = Number((l.users[id].usdc + amount).toFixed(6));
  l.users[id].deposits.push({ t: Date.now(), amount, sig });
  l.processed.push(sig);
  l.processed = l.processed.slice(-2000);
  save(l);
  return l.users[id];
}

export function applyFill(owner: string, fill: UserFill) {
  const l = load();
  const u = l.users[oid(owner)];
  if (!u) throw new Error("no desk account");
  if (fill.side === "buy") {
    if (u.usdc + 1e-9 < fill.usd) throw new Error("not enough USDC on the desk");
    u.usdc = Number((u.usdc - fill.usd).toFixed(6));
    const h = u.holdings[fill.ticker] || { shares: 0, costUsd: 0 };
    h.shares += fill.shares;
    h.costUsd += fill.usd;
    u.holdings[fill.ticker] = h;
  } else {
    const h = u.holdings[fill.ticker];
    if (!h || h.shares + 1e-12 < fill.shares) throw new Error("not enough shares on the desk");
    const cost = h.shares ? (h.costUsd * fill.shares) / h.shares : 0;
    h.shares = Number((h.shares - fill.shares).toFixed(8));
    h.costUsd = Math.max(0, h.costUsd - cost);
    if (h.shares <= 1e-8) delete u.holdings[fill.ticker];
    else u.holdings[fill.ticker] = h;
    u.usdc = Number((u.usdc + fill.usd).toFixed(6));
  }
  u.fills.push(fill);
  u.fills = u.fills.slice(-80);
  save(l);
  return u;
}

export function debitWithdraw(owner: string, kind: string, amount: number, ticker: string | undefined, sig: string) {
  const l = load();
  const u = l.users[oid(owner)];
  if (!u) throw new Error("no desk account");
  if (kind === "usdc") {
    if (u.usdc + 1e-9 < amount) throw new Error("not enough USDC on the desk");
    u.usdc = Number((u.usdc - amount).toFixed(6));
  } else {
    const t = ticker || "";
    const h = u.holdings[t];
    if (!h || h.shares + 1e-12 < amount) throw new Error("not enough shares on the desk");
    const cost = h.shares ? (h.costUsd * amount) / h.shares : 0;
    h.shares = Number((h.shares - amount).toFixed(8));
    h.costUsd = Math.max(0, h.costUsd - cost);
    if (h.shares <= 1e-8) delete u.holdings[t];
    else u.holdings[t] = h;
  }
  u.withdrawals.push({ t: Date.now(), kind, amount, sig });
  save(l);
  return u;
}

function rememberArm(l: Ledger, order: ArmOrder, status: ArmStatus, extra?: { tx?: string; error?: string }) {
  const owner = oid(order.owner);
  const now = Date.now();
  const rows = l.armRecords || [];
  const open = rows.findIndex(
    (r) => r.owner === owner && r.ticker === order.ticker && r.side === order.side && r.status !== "executed",
  );
  const next: ArmRecord = {
    owner,
    ticker: order.ticker,
    usd: order.usd,
    bandBps: order.bandBps,
    side: order.side,
    status,
    createdAt: open >= 0 ? rows[open].createdAt : order.createdAt || now,
    updatedAt: now,
    tx: extra?.tx,
    error: status === "failed" ? extra?.error : undefined,
  };
  if (open >= 0) rows[open] = next;
  else rows.push(next);
  const mine = rows.filter((r) => r.owner === owner).slice(-30);
  l.armRecords = rows.filter((r) => r.owner !== owner).concat(mine);
}

export function setArm(order: ArmOrder) {
  const l = load();
  const owner = oid(order.owner);
  const pinned = { ...order, owner };
  l.arms = l.arms.filter((a) => !(a.owner === owner && a.ticker === order.ticker && a.side === order.side));
  if (pinned.armed) l.arms.push(pinned);
  rememberArm(l, pinned, "pending");
  save(l);
  return pinned;
}

export function recordArmResult(
  order: Pick<ArmOrder, "owner" | "ticker" | "side" | "usd" | "bandBps" | "createdAt">,
  status: "executed" | "failed",
  extra?: { tx?: string; error?: string },
) {
  const l = load();
  const current = l.arms.find((a) => a.owner === oid(order.owner) && a.ticker === order.ticker && a.side === order.side);
  rememberArm(
    l,
    {
      owner: order.owner,
      ticker: order.ticker,
      usd: current?.usd ?? order.usd,
      bandBps: current?.bandBps ?? order.bandBps,
      side: order.side,
      armed: status !== "executed",
      createdAt: current?.createdAt ?? order.createdAt,
    },
    status,
    extra,
  );
  save(l);
}

export function userArmRecords(owner: string) {
  const id = oid(owner);
  return (load().armRecords || [])
    .filter((r) => r.owner === id)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export function listArms() {
  return load().arms.filter((a) => a.armed);
}

export function userArms(owner: string) {
  const id = oid(owner);
  return load().arms.filter((a) => a.owner === id);
}

export function disarm(owner: string, ticker?: string) {
  const id = oid(owner);
  const l = load();
  l.arms = l.arms.filter((a) => a.owner !== id || (ticker && a.ticker !== ticker));
  l.armRecords = (l.armRecords || []).filter((r) => {
    if (r.owner !== id || r.status !== "pending") return true;
    if (!ticker) return false;
    return r.ticker !== ticker;
  });
  save(l);
}
