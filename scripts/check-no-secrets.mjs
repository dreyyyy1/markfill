import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const skip = new Set(["node_modules", "dist", "data", ".git"]);
const hits = [];
const legacy = [];

function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (skip.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      walk(p);
      continue;
    }
    if (!/\.(ts|js|mjs|rs)$/.test(name)) continue;
    // sweep-custodial.ts legitimately holds key material for the one-time sweep.
    if (p.includes("scripts\\sweep-custodial") || p.includes("scripts/sweep-custodial")) continue;
    const text = readFileSync(p, "utf8");
    if (!/Keypair\.fromSecretKey|Keypair\.fromSeed/.test(text)) continue;
    const rel = p.replace(root, ".").replace(/\\/g, "/");
    if (rel.includes("src/lib/custody.ts")) {
      legacy.push(rel);
      continue;
    }
    hits.push(rel);
  }
}

walk(join(root, "src"));
walk(join(root, "programs"));
if (legacy.length) {
  console.warn(
    "WARNING: legacy custodial key derivation is still present (tracked, slated for removal after scripts/sweep-custodial.ts is confirmed against production):\n" +
      legacy.join("\n"),
  );
}
if (hits.length) {
  console.error("secret-material check failed:\n" + hits.join("\n"));
  process.exit(1);
}
console.log("secret-material check ok");
