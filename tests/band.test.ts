/** Quick sanity check of the band formula. Not coverage for the on-chain program. */
function inBand(side: number, impliedE8: number, nyseE8: number, bandBps: number) {
  if (side === 0) return impliedE8 * 10_000 <= nyseE8 * (10_000 + bandBps);
  return impliedE8 * 10_000 >= nyseE8 * (10_000 - bandBps);
}

function assert(c: boolean, m: string) {
  if (!c) throw new Error(m);
}

const nyse = 100_00000000; // $100 in e8
assert(inBand(0, 100_00000000, nyse, 50), "buy at NYSE ok");
assert(inBand(0, 100_40000000, nyse, 50), "buy +40bps ok");
assert(!inBand(0, 101_00000000, nyse, 50), "buy +100bps fail");
assert(inBand(1, 100_00000000, nyse, 50), "sell at NYSE ok");
assert(!inBand(1, 99_00000000, nyse, 50), "sell -100bps fail");

/** Mirrors implied_price_e8 / max_sell_native. BigInt so 10^18 stays exact. */
function impliedE8(side, usdAmount, minOut, decimals) {
  const scale = 10n ** BigInt(decimals);
  const u = BigInt(usdAmount);
  const m = BigInt(minOut);
  if (side === 0) return (u * scale * 100n) / m;
  return (m * scale * 100n) / u;
}

assert(impliedE8(0, 100_000_000, 100_000_000, 8) === 10_000_000_000n, "buy 8dp $100");
assert(impliedE8(0, 250_000_000, 1_000_000, 6) === 25_000_000_000n, "buy 6dp $250");
assert(impliedE8(1, 50_000_000, 50_000_000, 8) === 10_000_000_000n, "sell 8dp half token");
assert(impliedE8(1, 2_000_000, 500_000_000, 6) === 25_000_000_000n, "sell 6dp two tokens");

function maxSellNative(usdAmount, nyseE8, bandBps, decimals) {
  if (bandBps >= 10_000) throw new Error("no floor");
  const floor = (BigInt(nyseE8) * BigInt(10_000 - bandBps)) / 10_000n;
  const num = BigInt(usdAmount) * 100n * 10n ** BigInt(decimals);
  return (num + floor - 1n) / floor;
}

assert(maxSellNative(100_000_000, 10_000_000_000, 50, 8) === 100_502_513n, "sell cap 8dp");
assert(maxSellNative(500_000_000, 25_000_000_000, 100, 6) === 2_020_203n, "sell cap 6dp");
assert(100_000_000n <= maxSellNative(100_000_000, 10_000_000_000, 50, 8), "honest sell inside cap");
assert(10n * 100_000_000n > maxSellNative(100_000_000, 10_000_000_000, 50, 8), "10 token sell over cap");
console.log("band tests ok");
