import { USDC, stockByTicker } from "./stocks.js";
import { buildTape } from "./tape.js";
import { receiptFromTape } from "./receipts.js";

const JUP = "https://lite-api.jup.ag/swap/v1";

export async function quoteTrade(opts: {
  ticker: string;
  usd: number;
  bandBps: number;
  side: "buy" | "sell";
  slippageBps?: number;
}) {
  const stock = stockByTicker(opts.ticker);
  if (!stock) throw new Error("unknown ticker");
  const usd = Number(opts.usd);
  if (!(usd > 0)) throw new Error("enter an amount greater than 0");
  const tape = await buildTape(stock.ticker, opts.bandBps);
  const allowed =
    opts.side === "buy"
      ? tape.actions.buyFair || tape.actions.buyCheap
      : tape.actions.sellRich;
  const reason = allowed
    ? opts.side === "buy"
      ? tape.verdict === "cheap"
        ? "cheap vs NYSE — lifting the discount"
        : `inside ${opts.bandBps} bps — fair buy`
      : "rich vs NYSE — selling the premium"
    : opts.side === "buy"
      ? tape.verdict === "rich"
        ? `on-chain is ${tape.premiumBps?.toFixed(0)} bps rich — desk will not buy`
        : tape.play
      : tape.verdict === "cheap" || tape.verdict === "inside"
        ? "not rich enough to sell"
        : tape.play;

  let inMint = USDC;
  let outMint = stock.mint;
  let amount = Math.round(usd * 1_000_000);
  if (opts.side === "sell") {
    if (!tape.onchain?.price) throw new Error("no on-chain print to size a sell");
    inMint = stock.mint;
    outMint = USDC;
    amount = Math.round((usd / tape.onchain.price) * 10 ** stock.decimals);
  }

  const q = new URLSearchParams({
    inputMint: inMint,
    outputMint: outMint,
    amount: String(amount),
    slippageBps: String(opts.slippageBps ?? 100),
    restrictIntermediateTokens: "true",
  });
  const res = await fetch(`${JUP}/quote?${q}`, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`jupiter quote ${res.status}: ${await res.text()}`);
  const quote: any = await res.json();
  const outAmt = Number(quote.outAmount);
  const shares =
    opts.side === "buy" ? outAmt / 10 ** stock.decimals : amount / 10 ** stock.decimals;
  const implied =
    opts.side === "buy"
      ? shares > 0
        ? usd / shares
        : null
      : tape.onchain?.price ?? null;

  return {
    allowed,
    reason,
    side: opts.side,
    tape,
    usd,
    shares,
    implied,
    quote,
  };
}

export async function quoteBuy(opts: { ticker: string; usd: number; bandBps: number; slippageBps?: number }) {
  return quoteTrade({ ...opts, side: "buy" });
}

export async function buildSwap(opts: {
  ticker: string;
  usd: number;
  bandBps: number;
  userPublicKey: string;
  side?: "buy" | "sell";
  slippageBps?: number;
}) {
  const side = opts.side || "buy";
  const priced = await quoteTrade({ ...opts, side });
  if (!priced.allowed) {
    const err = new Error(priced.reason) as Error & { code?: string };
    err.code = "GATED";
    throw err;
  }
  const res = await fetch(`${JUP}/swap`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      quoteResponse: priced.quote,
      userPublicKey: opts.userPublicKey,
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      dynamicSlippage: { minBps: 50, maxBps: 300 },
      prioritizationFeeLamports: "auto",
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`jupiter swap ${res.status}: ${await res.text()}`);
  const body: any = await res.json();
  const receipt = receiptFromTape(priced.tape, side, priced.usd, priced.shares);
  return { ...priced, swapTransaction: body.swapTransaction as string, receipt };
}


