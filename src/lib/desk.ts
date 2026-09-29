import { VersionedTransaction } from "@solana/web3.js";
import { buildTape } from "./tape.js";
import { quoteTrade } from "./jupiter.js";
import { receiptFromTape } from "./receipts.js";
import {
  applyFill,
  creditDeposit,
  debitWithdraw,
  disarm,
  getUser,
  listArms,
  listOwners,
  seenSig,
  setArm,
  userArms,
  type ArmOrder,
} from "./ledger.js";
import {
  connection,
  deskInfo,
  deskKeypair,
  exportDeskSecret,
  isLive,
  onchainBalances,
  scanUsdcDeposits,
  sendTokens,
} from "./custody.js";
import { USDC, stockByTicker } from "./stocks.js";
import { oid, vaultMode } from "./auth.js";
import { txToB64, vaultUsdcAta, withdrawIx } from "./vault.js";
import { PublicKey, Transaction } from "@solana/web3.js";
import { getAssociatedTokenAddress, TOKEN_PROGRAM_ID } from "@solana/spl-token";

const JUP = "https://lite-api.jup.ag/swap/v1";

export async function publicDesk(owner?: string) {
  if (!vaultMode()) return deskInfo(owner);
  if (!owner) {
    return {
      live: true,
      perUser: true,
      vault: true,
      note: "Connect your wallet. Your vault is a PDA only you can withdraw from.",
    };
  }
  const user = new PublicKey(oid(owner));
  const { vault, ata } = await vaultUsdcAta(user);
  return {
    live: true,
    perUser: true,
    vault: true,
    address: ata.toBase58(),
    vaultPda: vault.toBase58(),
    note: "This ATA is owned by your vault PDA. You sign deposit, arm, and withdraw. The keeper cannot steal.",
  };
}

export async function ingestDeposits(owner?: string) {
  const owners = owner ? [owner] : listOwners();
  const credited = [];
  for (const o of owners) {
    const hits = await scanUsdcDeposits(o);
    for (const h of hits) {
      if (seenSig(h.sig)) continue;
      const u = creditDeposit(h.owner, h.amount, h.sig);
      credited.push({ owner: h.owner, amount: h.amount, sig: h.sig, usdc: u.usdc });
    }
  }
  return credited;
}

async function hotSwap(opts: { ticker: string; usd: number; bandBps: number; side: "buy" | "sell"; owner: string }) {
  const priced = await quoteTrade(opts);
  if (!priced.allowed) {
    const err = new Error(priced.reason) as Error & { code?: string };
    err.code = "GATED";
    throw err;
  }
  const kp = deskKeypair(opts.owner);
  const res = await fetch(`${JUP}/swap`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      quoteResponse: priced.quote,
      userPublicKey: kp.publicKey.toBase58(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      dynamicSlippage: { minBps: 50, maxBps: 300 },
      prioritizationFeeLamports: "auto",
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`jupiter swap ${res.status}: ${await res.text()}`);
  const body: any = await res.json();
  const tx = VersionedTransaction.deserialize(Buffer.from(body.swapTransaction, "base64"));
  tx.sign([kp]);
  const signature = await connection().sendRawTransaction(tx.serialize(), { skipPreflight: false });
  const usdSettled =
    opts.side === "sell" ? Number(priced.quote.outAmount) / 1e6 : priced.usd;
  const fill = {
    t: Date.now(),
    side: opts.side,
    ticker: priced.tape.ticker,
    usd: usdSettled,
    shares: priced.shares,
    premiumBps: priced.tape.premiumBps,
    session: priced.tape.session,
    tx: signature,
    note: `${opts.side} ${priced.tape.xSymbol} from your MarkFill wallet`,
  };
  const user = applyFill(opts.owner, fill);
  receiptFromTape(priced.tape, opts.side, priced.usd, priced.shares, signature);
  return { ...priced, signature, live: true, user, fill };
}

export async function arm(order: Omit<ArmOrder, "createdAt" | "armed"> & { armed?: boolean }) {
  const owner = String(order.owner || "").trim();
  if (!owner) throw new Error("connect a wallet so we know which desk account to use");
  const stock = stockByTicker(order.ticker);
  if (!stock) throw new Error("unknown ticker");
  const usd = Number(order.usd);
  if (!(usd > 0)) throw new Error("size must be greater than 0");
  const u = getUser(owner);
  if (order.side === "buy" && u.usdc + 1e-9 < usd) {
    throw new Error(`desk balance is $${u.usdc.toFixed(2)} USDC — deposit first`);
  }
  if (order.side === "sell") {
    const h = u.holdings[stock.ticker];
    if (!h || h.shares <= 0) throw new Error("no shares of this name on the desk to sell");
  }
  return setArm({
    owner,
    ticker: stock.ticker,
    usd,
    bandBps: Number(order.bandBps || 50),
    side: order.side,
    armed: order.armed !== false,
    createdAt: Date.now(),
  });
}

export async function processArms() {
  if (vaultMode()) {
    return [];
  }
  const out = [];
  for (const a of listArms()) {
    try {
      const tape = await buildTape(a.ticker, a.bandBps);
      const ready =
        a.side === "buy" ? tape.actions.buyFair || tape.actions.buyCheap : tape.actions.sellRich;
      if (!ready) continue;
      let usd = a.usd;
      if (a.side === "sell" && tape.onchain?.price) {
        const h = getUser(a.owner).holdings[a.ticker];
        const maxUsd = (h?.shares || 0) * tape.onchain.price;
        usd = Math.min(usd, maxUsd);
        if (usd < 1) throw new Error("sell size too small");
      }
      const filled = await hotSwap({
        owner: a.owner,
        ticker: a.ticker,
        usd,
        bandBps: a.bandBps,
        side: a.side,
      });
      disarm(a.owner, a.ticker);
      out.push({ owner: a.owner, ticker: a.ticker, signature: filled.signature, live: filled.live });
    } catch (e) {
      out.push({ owner: a.owner, ticker: a.ticker, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return out;
}

export async function withdraw(opts: { owner: string; kind: "usdc" | "token"; ticker?: string; amount: number }) {
  const owner = oid(opts.owner);
  if (!owner) throw new Error("connect wallet");
  const amount = Number(opts.amount);
  if (!(amount > 0)) throw new Error("amount must be > 0");
  if (vaultMode()) {
    const user = new PublicKey(owner);
    const mint = opts.kind === "usdc" ? new PublicKey(USDC) : new PublicKey(stockByTicker(String(opts.ticker || ""))!.mint);
    const decimals = opts.kind === "usdc" ? 6 : stockByTicker(String(opts.ticker || ""))!.decimals;
    const ownerAta = await getAssociatedTokenAddress(mint, user, false, TOKEN_PROGRAM_ID);
    const ix = await withdrawIx(user, mint, ownerAta, BigInt(Math.round(amount * 10 ** decimals)));
    const tx = new Transaction().add(ix);
    tx.feePayer = user;
    tx.recentBlockhash = (await connection().getLatestBlockhash()).blockhash;
    return { needsUserSignature: true, transaction: txToB64(tx) };
  }
  const u = getUser(owner);
  if (opts.kind === "usdc") {
    if (u.usdc + 1e-9 < amount) throw new Error("not enough USDC on the desk");
    const sent = await sendTokens({ owner, mint: USDC, to: owner, amount, decimals: 6 });
    const next = debitWithdraw(owner, "usdc", amount, undefined, sent.signature);
    return { ...sent, user: next };
  }
  const stock = stockByTicker(String(opts.ticker || ""));
  if (!stock) throw new Error("pick a ticker to withdraw");
  const h = u.holdings[stock.ticker];
  if (!h || h.shares + 1e-12 < amount) throw new Error("not enough shares on the desk");
  const sent = await sendTokens({ owner, mint: stock.mint, to: owner, amount, decimals: stock.decimals });
  const next = debitWithdraw(owner, "token", amount, stock.ticker, sent.signature);
  return { ...sent, user: next };
}

export async function snapshot(owner: string) {
  const u = getUser(owner);
  const chain = vaultMode()
    ? await (async () => {
        const user = new PublicKey(oid(owner));
        const { vault, ata } = await vaultUsdcAta(user);
        const conn = connection();
        let usdc = 0;
        try {
          const acc = await conn.getTokenAccountBalance(ata);
          usdc = Number(acc.value.uiAmount || 0);
        } catch {
          usdc = 0;
        }
        return { sol: 0, usdc, stocks: [] as { ticker: string; xSymbol: string; shares: number }[], vault: vault.toBase58() };
      })()
    : await onchainBalances(owner);
  return {
    address: vaultMode() ? (chain as { vault?: string }).vault : u.deskAddress,
    live: isLive(),
    balances: chain,
    user: {
      owner: u.owner,
      deskAddress: u.deskAddress,
      usdc: u.usdc,
      holdings: u.holdings,
      fills: u.fills,
      deposits: u.deposits,
      withdrawals: u.withdrawals,
    },
    arms: userArms(owner),
  };
}

export async function exportKey(owner: string) {
  if (vaultMode()) {
    const user = new PublicKey(oid(owner));
    const { vault, ata } = await vaultUsdcAta(user);
    return { address: ata.toBase58(), vaultPda: vault.toBase58(), secret: null, note: "no private key — vault is a PDA" };
  }
  deskKeypair(owner);
  const u = getUser(owner);
  return { address: u.deskAddress, secret: null, note: "export of private keys is disabled; use withdraw" };
}

let busy = false;
export async function deskTick() {
  if (busy) return;
  busy = true;
  try {
    await ingestDeposits();
    await processArms();
  } catch (e) {
    console.warn("desk tick", e instanceof Error ? e.message : e);
  } finally {
    busy = false;
  }
}
