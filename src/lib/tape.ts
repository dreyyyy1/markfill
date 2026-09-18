import { STOCKS, USDC, type Stock, stockByTicker } from "./stocks.js";

const HERMES = "https://hermes.pyth.network";
const JUP = "https://lite-api.jup.ag/swap/v1";

export interface Print {
  source: string;
  price: number;
  ts: number;
  venue?: string;
}

export interface Venue {
  name: string;
  print: Print;
  vsNyseBps: number | null;
}

export interface Tape {
  ticker: string;
  name: string;
  xSymbol: string;
  mint: string;
  session: "open" | "closed";
  nextOpen?: number;
  nextClose?: number;
  nyse: Print | null;
  previousClose: number | null;
  onchain: Print | null;
  pythX: Print | null;
  ondo: Print | null;
  venues: Venue[];
  cheapest: string | null;
  premiumBps: number | null;
  overnightGapBps: number | null;
  reversionUsdPer100: number | null;
  play: string;
  verdict: "inside" | "cheap" | "rich" | "no-print";
  bandBps: number;
  actions: {
    buyFair: boolean;
    buyCheap: boolean;
    sellRich: boolean;
    lpFair: boolean;
  };
  pyth: {
    equityId?: string;
    xId?: string;
    ondoId?: string;
    hoursFromPyth: boolean;
  };
}

function pythKey() {
  return process.env.PYTH_API_KEY?.trim() || "";
}

async function getJson(url: string, headers: Record<string, string> = {}): Promise<any> {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(12_000) });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

function pythToNumber(p: { price: string; expo: number }) {
  return Number(p.price) * 10 ** p.expo;
}

function bps(a: number, b: number) {
  if (!b) return null;
  return ((a - b) / b) * 10_000;
}

async function hermesLatest(ids: string[]): Promise<Map<string, Print>> {
  const out = new Map<string, Print>();
  if (!ids.length) return out;
  const q = ids.map((id) => `ids[]=${id}`).join("&");
  const headers: Record<string, string> = {};
  if (pythKey()) headers.Authorization = `Bearer ${pythKey()}`;
  try {
    const json = await getJson(`${HERMES}/v2/updates/price/latest?${q}&parsed=true`, headers);
    const parsed = json.parsed || json;
    const rows = Array.isArray(parsed) ? parsed : [];
    for (const row of rows) {
      const id = String(row.id || row.price_feed_id || "").replace(/^0x/, "");
      const price = row.price?.price != null ? pythToNumber(row.price) : undefined;
      const ts = Number(row.price?.publish_time || Date.now() / 1000) * 1000;
      if (price && Number.isFinite(price)) out.set(id, { source: "pyth", price, ts });
    }
  } catch {
    /* Hermes latest needs a key since Aug 2026 */
  }
  return out;
}

async function yahooQuote(ticker: string): Promise<{ print: Print; previousClose: number | null } | null> {
  try {
    const json = await getJson(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1m&range=1d`,
    );
    const meta = json.chart?.result?.[0]?.meta;
    const price = Number(meta?.regularMarketPrice);
    const prev = Number(meta?.previousClose ?? meta?.chartPreviousClose);
    const ts = Number(meta?.regularMarketTime || 0) * 1000;
    if (!Number.isFinite(price) || price <= 0) return null;
    return {
      print: { source: "yahoo", price, ts: ts || Date.now(), venue: "NYSE" },
      previousClose: Number.isFinite(prev) && prev > 0 ? prev : null,
    };
  } catch {
    return null;
  }
}

async function jupiterImplied(stock: Stock): Promise<Print | null> {
  const usd = 10 * 1_000_000;
  try {
    const json = await getJson(
      `${JUP}/quote?inputMint=${USDC}&outputMint=${stock.mint}&amount=${usd}&slippageBps=50`,
    );
    const out = Number(json.outAmount);
    if (!out) return null;
    const shares = out / 10 ** stock.decimals;
    const price = 10 / shares;
    if (!Number.isFinite(price) || price <= 0) return null;
    return { source: "jupiter", price, ts: Date.now(), venue: "xStock" };
  } catch {
    return null;
  }
}

type Feeds = { equity?: string; x?: string; ondo?: string; hours?: any };
const feedCache = new Map<string, Feeds>();

async function pickFeed(query: string, want: (sym: string) => boolean) {
  const rows = await getJson(`${HERMES}/v2/price_feeds?query=${encodeURIComponent(query)}`);
  if (!Array.isArray(rows) || !rows.length) return null;
  const row = rows.find((r: any) => want(String(r.attributes?.symbol || ""))) || rows[0];
  return row;
}

async function resolveFeeds(stock: Stock): Promise<Feeds> {
  const hit = feedCache.get(stock.ticker);
  if (hit) return hit;
  const info: Feeds = { equity: stock.pythEquity, x: stock.pythX };
  try {
    const row = await pickFeed(`Equity.US.${stock.ticker}/USD`, (s) => s === `Equity.US.${stock.ticker}/USD`);
    if (row?.id) info.equity = String(row.id).replace(/^0x/, "");
    if (row?.market_hours) info.hours = row.market_hours;
  } catch {
    /* keep */
  }
  try {
    const row = await pickFeed(`Crypto.${stock.xSymbol.toUpperCase()}/USD`, (s) => s.includes("/USD") && !s.includes(".RR") && !s.includes("ON/"));
    if (row?.id) info.x = String(row.id).replace(/^0x/, "");
  } catch {
    /* keep */
  }
  try {
    const row = await pickFeed(`Crypto.${stock.ticker}ON/USD`, (s) => s.includes("ON/") && s.endsWith("/USD"));
    if (row?.id) info.ondo = String(row.id).replace(/^0x/, "");
  } catch {
    /* optional */
  }
  feedCache.set(stock.ticker, info);
  return info;
}

function nyHours(): "open" | "closed" {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "numeric",
    minute: "numeric",
    hourCycle: "h23",
  }).formatToParts(now);
  const wd = parts.find((p) => p.type === "weekday")?.value;
  const hour = Number(parts.find((p) => p.type === "hour")?.value);
  const minute = Number(parts.find((p) => p.type === "minute")?.value);
  const mins = hour * 60 + minute;
  const weekday = wd !== "Sat" && wd !== "Sun";
  return weekday && mins >= 9 * 60 + 30 && mins < 16 * 60 ? "open" : "closed";
}

export async function buildTape(ticker: string, bandBps = 50): Promise<Tape> {
  const stock = stockByTicker(ticker);
  if (!stock) throw new Error(`unknown ticker ${ticker}`);
  const feeds = await resolveFeeds(stock);
  const ids = [feeds.equity, feeds.x, feeds.ondo].filter(Boolean) as string[];
  const pyth = await hermesLatest(ids);
  const y = await yahooQuote(stock.ticker);

  const nyse = (feeds.equity && pyth.get(feeds.equity)) || y?.print || null;
  if (nyse && !nyse.venue) nyse.venue = "NYSE";
  const pythX = feeds.x ? pyth.get(feeds.x) || null : null;
  if (pythX) pythX.venue = "xStock";
  const ondo = feeds.ondo ? pyth.get(feeds.ondo) || null : null;
  if (ondo) ondo.venue = "Ondo";
  const onchain = pythX || (await jupiterImplied(stock));

  const session: "open" | "closed" =
    feeds.hours && typeof feeds.hours.is_open === "boolean" ? (feeds.hours.is_open ? "open" : "closed") : nyHours();

  const venues: Venue[] = [];
  if (onchain) venues.push({ name: "xStock", print: onchain, vsNyseBps: nyse ? bps(onchain.price, nyse.price) : null });
  if (ondo) venues.push({ name: "Ondo", print: ondo, vsNyseBps: nyse ? bps(ondo.price, nyse.price) : null });

  let cheapest: string | null = null;
  const priced = venues.filter((v) => v.vsNyseBps != null);
  if (priced.length) {
    cheapest = priced.reduce((a, b) => ((a.vsNyseBps as number) < (b.vsNyseBps as number) ? a : b)).name;
  }

  const premiumBps = onchain && nyse ? bps(onchain.price, nyse.price) : null;
  const prev = y?.previousClose ?? null;
  const overnightGapBps = onchain && prev ? bps(onchain.price, prev) : null;

  let verdict: Tape["verdict"] = "no-print";
  if (premiumBps != null) {
    if (premiumBps <= -bandBps) verdict = "cheap";
    else if (premiumBps >= bandBps) verdict = "rich";
    else verdict = "inside";
  }

  const reversionUsdPer100 = premiumBps != null ? Number(((-premiumBps / 10_000) * 100).toFixed(2)) : null;

  let play = "waiting for a print";
  if (verdict === "inside") play = session === "open" ? "fair tape — buy or LP" : "overnight still fair — you can buy without paying a Sunday tax";
  if (verdict === "cheap") {
    play =
      session === "closed"
        ? `xStock is cheap vs cash. If it snaps to NYSE at the open, about $${Math.abs(reversionUsdPer100 ?? 0).toFixed(2)} per $100 bought.`
        : "xStock is cheap vs NYSE — lift the discount, do not LP";
  }
  if (verdict === "rich") {
    play =
      session === "closed"
        ? "xStock is rich vs last cash print. Do not buy. Sell if you hold, or wait."
        : "xStock is rich vs NYSE — sell the premium, do not LP";
  }

  return {
    ticker: stock.ticker,
    name: stock.name,
    xSymbol: stock.xSymbol,
    mint: stock.mint,
    session,
    nextOpen: feeds.hours?.next_open ? Number(feeds.hours.next_open) * 1000 : undefined,
    nextClose: feeds.hours?.next_close ? Number(feeds.hours.next_close) * 1000 : undefined,
    nyse,
    previousClose: prev,
    onchain,
    pythX,
    ondo,
    venues,
    cheapest,
    premiumBps,
    overnightGapBps,
    reversionUsdPer100,
    play,
    verdict,
    bandBps,
    actions: {
      buyFair: verdict === "inside",
      buyCheap: verdict === "cheap",
      sellRich: verdict === "rich",
      lpFair: verdict === "inside",
    },
    pyth: {
      equityId: feeds.equity,
      xId: feeds.x,
      ondoId: feeds.ondo,
      hoursFromPyth: Boolean(feeds.hours),
    },
  };
}

export async function scanBoard(bandBps = 50) {
  const rows = [];
  for (const s of STOCKS) {
    try {
      const t = await buildTape(s.ticker, bandBps);
      rows.push({
        ticker: t.ticker,
        xSymbol: t.xSymbol,
        session: t.session,
        nyse: t.nyse?.price ?? null,
        onchain: t.onchain?.price ?? null,
        ondo: t.ondo?.price ?? null,
        premiumBps: t.premiumBps,
        overnightGapBps: t.overnightGapBps,
        cheapest: t.cheapest,
        verdict: t.verdict,
        play: t.play,
        actions: t.actions,
      });
    } catch {
      /* skip one name */
    }
  }
  rows.sort((a, b) => (a.premiumBps ?? 9e9) - (b.premiumBps ?? 9e9));
  return { bandBps, rows };
}

export function listStocks() {
  return STOCKS.map((s) => ({ ticker: s.ticker, name: s.name, xSymbol: s.xSymbol, mint: s.mint }));
}
