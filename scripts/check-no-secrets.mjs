import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const skip = new Set(["node_modules", "dist", "data", ".git"]);
const hits = [];

function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (skip.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      walk(p);
      continue;
    }
    if (!/\.(ts|js|mjs|rs)$/.test(name)) continue;
    if (p.includes("scripts\\sweep-custodial") || p.includes("scripts/sweep-custodial")) continue;
    const text = readFileSync(p, "utf8");
    if (/Keypair\.fromSecretKey|Keypair\.fromSeed/.test(text)) {
      if (p.replace(/\\/g, "/").includes("src/lib/custody.ts")) continue;
      if (p.replace(/\\/g, "/").includes("scripts/sweep-custodial")) continue;
      hits.push(p.replace(root, "."));
    }
  }
}

walk(join(root, "src"));
walk(join(root, "programs"));
if (hits.length) {
  console.error("secret-material check failed:\n" + hits.join("\n"));
  process.exit(1);
}
console.log("secret-material check ok");
