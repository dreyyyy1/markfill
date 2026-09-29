/** Band math used by the on-chain program (Phase 5). */
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
console.log("band tests ok");
