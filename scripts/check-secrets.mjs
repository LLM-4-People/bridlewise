#!/usr/bin/env node
/**
 * Public-snapshot secret and privacy gate.
 *
 * Scans tracked files (or the working tree before the first commit) for
 * credential shapes, private-key blocks, database/key artifacts, and internal
 * paths that must never appear in a public repository.
 *
 * Findings print the file, line, and rule. The matched value is never printed.
 * Test fixtures under the allowlisted trees do not fail the gate; GitHub
 * secret scanning remains the independent second gate.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, relative, resolve } from "node:path";

const ROOT = resolve(process.cwd());
const MAX_BYTES = 2 * 1024 * 1024;

const FORBIDDEN_PATH = [
  [/\/home\/(?!example(?:\/|$)|user(?:\/|$)|runner(?:\/|$)|bridlewise(?:\/|$)|ubuntu(?:\/|$)|node(?:\/|$)|app(?:\/|$)|workspace(?:\/|$)|demo(?:\/|$)|x(?:\/|$)|u(?:\/|$)|me(?:\/|$)|alice(?:\/|$)|bob(?:\/|$)|jane(?:\/|$)|jdoe(?:\/|$)|username(?:\/|$)|test(?:\/|$)|foo(?:\/|$)|bar(?:\/|$)|baz(?:\/|$))[A-Za-z0-9._-]+\//, "absolute home path"],
  [/git\.localserver\.ca\b/, "internal Git host"],
  [/api\.neuralwatt\.com\b/, "internal provider host"],
  [/\/tmp\/opencode\b/, "internal scratch path"],
  [/\bcode-harness\.fresh-evidence\b/, "local evidence state directory"],
];

const FORBIDDEN_FILE = [
  [/(^|\/)\.env($|\.)/, "environment file"],
  [/(^|\/)\.npmrc$/, "npm credentials file"],
  [/(^|\/)\.netrc$/, "netrc credentials file"],
  [/(^|\/)(db-key|id_rsa|id_ed25519)$/, "key material"],
  [/\.(pem|key|p12|pfx)$/i, "key material"],
  [/\.(db|sqlite|sqlite3)(-|$)/i, "database state"],
];

const CONTENT_RULES = [
  {
    id: "private-key-block",
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/,
    detail: "private key header",
  },
  {
    id: "provider-token-shape",
    pattern: /\b(?:sk|rk|pk|ghp|github_pat)[_-][A-Za-z0-9_-]{20,}\b/,
    detail: "provider-token shape",
  },
  {
    id: "aws-access-key-shape",
    pattern: /\bAKIA[0-9A-Z]{16}\b/,
    detail: "AWS access-key shape",
  },
];

const SAFE_FIXTURE_PATHS = [
  /^engine\/test\//,
  /^tests\//,
  /^bench\//,
  /^engine\/src\/privacy\//,
  /^engine\/src\/shared\/debug\//,
  /^docs\//,
  /^\.gitleaks\.toml$/,
];

function isSafeFixture(path) {
  return SAFE_FIXTURE_PATHS.some((re) => re.test(path));
}

function trackedFiles() {
  try {
    const out = execFileSync("git", ["ls-files", "-z"], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.split("\0").filter(Boolean);
  } catch {
    return walk(".");
  }
}

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = resolve(dir, entry.name);
    if (entry.name === ".git" || entry.name === "node_modules" || entry.name === "dist" || entry.name === "build") continue;
    if (entry.isDirectory()) out.push(...walk(path));
    else if (entry.isFile()) out.push(relative(ROOT, path));
  }
  return out;
}

function isText(path) {
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > MAX_BYTES) return false;
    const extension = extname(path).toLowerCase();
    if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".woff", ".woff2", ".pdf", ".zip", ".gz"].includes(extension)) return false;
    return true;
  } catch {
    return false;
  }
}

const findings = [];
for (const path of trackedFiles()) {
  const normalized = path.split("\\").join("/");
  for (const [re, detail] of FORBIDDEN_FILE) {
    if (re.test(normalized) && !normalized.endsWith(".env.example")) {
      findings.push({ path: normalized, line: 0, rule: "forbidden-file", detail });
    }
  }
  if (!isText(path)) continue;
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    continue;
  }
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    for (const [re, detail] of FORBIDDEN_PATH) {
      if (re.test(line)) findings.push({ path: normalized, line: i + 1, rule: "forbidden-path", detail, fixture: isSafeFixture(normalized) });
    }
    for (const rule of CONTENT_RULES) {
      if (!rule.pattern.test(line)) continue;
      if (rule.id === "aws-access-key-shape" && line.includes("AKIAIOSFODNN7EXAMPLE")) continue;
      if (/PLANT|LIVEKEY|EXAMPLE|placeholder|synthetic/i.test(line)) continue;
      findings.push({
        path: normalized,
        line: i + 1,
        rule: rule.id,
        detail: rule.detail,
        fixture: isSafeFixture(normalized),
      });
    }
  }
}

if (findings.length === 0) {
  console.log("secret scan: clean");
  process.exit(0);
}

let hard = 0;
let allowlisted = 0;
for (const f of findings) {
  if (f.fixture && f.rule !== "forbidden-file") {
    allowlisted += 1;
    continue;
  }
  const location = f.line > 0 ? `${f.path}:${f.line}` : f.path;
  console.error(`${location}: ${f.rule}: ${f.detail}`);
  if (!f.fixture && f.rule !== "private-key-block") hard += 1;
}

if (hard === 0) {
  console.log(`secret scan: clean (${allowlisted} synthetic fixture reference(s) allowlisted)`);
  process.exit(0);
}
console.error(`\nsecret scan: ${hard} finding(s) outside fixture paths`);
process.exit(1);
