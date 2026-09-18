import { stockByTicker } from "./stocks.js";
import { buildTape } from "./tape.js";

const PAIR_API = "https://dlmm-api.meteora.ag";

export async function lpPlan(ticker: string, bandBps = 50) {
  const stock = stockByTicker(ticker);
  if (!stock) throw new Error("unknown ticker");
  const tape = await buildTape(stock.ticker, bandBps);
  let pool: any = null;
  try {
    const url = `${PAIR_API}/pair/all_by_groups?page=0&limit=8&sort_key=volume&order_by=desc&search_term=${encodeURIComponent(stock.xSymbol)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(12_000) });
    if (res.ok) {
      const json: any = await res.json();
      const groups = json.groups || json.data || json.pairs || [];
      const flat = Array.isArray(groups)
        ? groups.flatMap((g: any) => g.pairs || g || [])
        : [];
      pool =
        flat.find((p: any) => String(p.name || "").toUpperCase().includes(stock.xSymbol.toUpperCase())) ||
        flat[0] ||
        null;
    }
  } catch {
    pool = null;
  }

  const binStep = Number(pool?.bin_step || 25);
  const activeId = Number(pool?.active_id ?? 0);
  const width = tape.session === "open" ? 24 : 56;
  const fromBin = Number.isFinite(activeId) && activeId ? activeId - width : null;
  const toBin = Number.isFinite(activeId) && activeId ? activeId + width : null;
  const lpOk = tape.actions.lpFair;

  return {
    tape,
    lpOk,
    sessionWidth: width,
    reason: lpOk
      ? tape.session === "open"
        ? `NYSE open — tight Spot range ±${width} bins on fair value`
        : `overnight still fair — wider ±${width} bins so you are not blown out at the open`
      : tape.verdict === "rich"
        ? "do not LP a rich tape — you are selling stock below NYSE"
        : tape.verdict === "cheap"
          ? "do not LP a cheap tape — directional flow will walk you"
          : tape.play,
    pool: pool
      ? {
          address: pool.address || pool.pair_address,
          name: pool.name,
          tvl: pool.liquidity,
          volume24h: pool.trade_volume_24h,
          binStep,
          baseFee: pool.base_fee_percentage,
        }
      : null,
    range: {
      strategy: "Spot",
      fromBinId: fromBin,
      toBinId: toBin,
      note: "width follows the cash session. open = tight. closed = wide. never when the token is off the tape.",
    },
    meteoraUrl: pool?.address
      ? `https://app.meteora.ag/dlmm/${pool.address}`
      : `https://app.meteora.ag/pools?search=${stock.xSymbol}`,
  };
}
