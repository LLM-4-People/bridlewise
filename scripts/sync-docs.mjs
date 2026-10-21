#!/usr/bin/env node
/**
 * Project the development floor's documentation into this product tree.
 *
 * The floor is the source of record for every shared document. The product is
 * a projection, and a projection that is edited by hand drifts silently — the
 * roadmap count is the classic case. This script owns the copy:
 *
 *   node scripts/sync-docs.mjs --floor ../bridlewise-public-testing --check
 *   node scripts/sync-docs.mjs --floor ../bridlewise-public-testing --write
 *
 * What it does for each document the floor and the product share:
 *   - takes the floor's PROSE (the product keeps its own Jekyll front matter);
 *   - rewrites relative Markdown links to the product site URL the reader will
 *     land on (a raw `.md` link is correct on GitHub and a 404 on the site);
 *   - leaves a document the product does not publish pointing at the floor.
 *
 * Product-only documents are untouched, and a shared document whose prose
 * already matches is not rewritten.
 */
import { existsSync, readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

const args = process.argv.slice(2);
const value = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
const floor = resolve(value("--floor") ?? "../bridlewise-public-testing");
const write = args.includes("--write");
const check = args.includes("--check") || !write;
const root = process.cwd();
const floorDocs = join(floor, "docs");
const productDocs = join(root, "docs");
const BASE = "https://llm-4-people.github.io/bridlewise";

if (!existsSync(floorDocs)) {
  console.error(`sync-docs: the floor tree was not found at ${floorDocs}`);
  process.exit(2);
}

const walk = (dir, out = []) => {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (entry.endsWith(".md")) out.push(path);
  }
  return out;
};
const stripFrontMatter = (text) => {
  if (!text.startsWith("---")) return { front: "", body: text };
  const end = text.indexOf("\n---", 3);
  if (end < 0) return { front: "", body: text };
  const close = text.indexOf("\n", end + 4);
  return { front: text.slice(0, close + 1), body: text.slice(close + 1).replace(/^\n+/u, "") };
};
const prettyPath = (docsRelative) => {
  const withoutExt = docsRelative.replace(/\.md$/u, "");
  const parts = withoutExt.split("/");
  const last = parts.pop();
  if (last === "index") return `${BASE}/${parts.join("/")}`.replace(/\/$/u, "");
  if (last === "README") return `${BASE}/${parts.join("/")}`;
  return `${BASE}/${[...parts, last].join("/")}/`;
};

// Pages the PRODUCT owns, not projections: its front door and anything else
// whose subject is the product rather than the floor.
const PRODUCT_OWN = new Set(["index.md"]);

// Documents the product ADAPTS on purpose: they describe the product's own
// command set, which is smaller than the floor's (no `db-backup`, no
// `verify:public`, no `perf:profile`). Copying the floor's prose would tell a
// product reader to run commands this repository does not have.
const PRODUCT_ADAPTED = new Map([
  ["cli.md", "the product's CLI reference names only commands it ships"],
  ["testing.md", "the product's test prerequisites differ (no perf profile)"],
  ["shipping.md", "the product's release workflow differs from the floor's"],
]);

const productFiles = new Set(walk(productDocs).map((p) => relative(productDocs, p).split(sep).join("/")));
const missing = [];
const drift = [];
let updated = 0;

for (const file of walk(floorDocs)) {
  const rel = relative(floorDocs, file).split(sep).join("/");
  if (PRODUCT_OWN.has(rel) || PRODUCT_ADAPTED.has(rel)) continue;
  const target = join(productDocs, rel);
  if (!existsSync(target)) continue; // product-only or floor-only: not this script's subject
  const floorText = readFileSync(file, "utf8");
  const productText = readFileSync(target, "utf8");
  const { front } = stripFrontMatter(productText);
  // The product site runs jekyll-relative-links, so a relative `.md` link the
  // product publishes is correct on the site as well as on GitHub. A link to a
  // document the product does NOT publish must not stay relative — it would be
  // a 404 — so it points at where that document does live.
  const floorBody = stripFrontMatter(floorText).body.replace(
    /\]\(([^)\s#?]+\.md)(#[^)\s]*)?\)/gu,
    (whole, href, fragment = "") => {
      if (/^(?:https?:|\/)/u.test(href)) return whole;
      const targetRel = relative(floorDocs, resolve(dirname(file), href)).split(sep).join("/");
      if (productFiles.has(targetRel)) return whole;
      const floorPage = targetRel.startsWith("floor/") || targetRel.startsWith("trackers/");
      const url = floorPage
        ? `https://llm-4-people.github.io/bridlewise-testing/${targetRel.replace(/\.md$/u, "")}/`
        : `https://github.com/LLM-4-People/bridlewise-testing/blob/main/docs/${targetRel}`;
      return `](${url}${fragment})`;
    },
  );
  // Trailing whitespace is not drift; the prose is.
  if (floorBody.trimEnd() === stripFrontMatter(productText).body.trimEnd()) continue;
  drift.push(rel);
  if (write) {
    writeFileSync(target, `${front}${front === "" ? "" : "\n"}${floorBody.trimEnd()}\n`);
    updated += 1;
  }
}
if (missing.length > 0) {
  console.error("sync-docs: links to documents this product does not publish:");
  for (const line of missing) console.error(`  ${line}`);
}
if (check) {
  for (const [rel, why] of PRODUCT_ADAPTED) console.log(`sync-docs: ${rel} is product-adapted — ${why}`);
  if (drift.length === 0) console.log(`sync-docs: ${productFiles.size} product pages, 0 drifted`);
  else {
    console.error(`sync-docs: ${drift.length} document(s) drifted from the floor:`);
    for (const rel of drift) console.error(`  ${rel}`);
    process.exit(1);
  }
} else {
  console.log(`sync-docs: ${updated} document(s) projected from the floor`);
}
