import { readFileSync, writeFileSync } from "node:fs";

const root = new URL("../", import.meta.url);
const src = new URL("packages/pet-avatar/pet.js", root);
const dest = new URL("public/pet-embed/pet.js", root);

const source = readFileSync(src, "utf8");
let current = "";
try {
  current = readFileSync(dest, "utf8");
} catch {
  current = "";
}

if (source === current) {
  console.log("pet runtime: in sync");
  process.exit(0);
}

if (process.argv.includes("--check")) {
  console.error("pet runtime: out of sync — run `npm run pet:sync`");
  process.exit(1);
}

writeFileSync(dest, source);
console.log("pet runtime: packages/pet-avatar/pet.js -> public/pet-embed/pet.js");
