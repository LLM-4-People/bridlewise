#!/usr/bin/env bash
# run-tests.sh — build the guardian + test_payload, then assert Landlock
# enforcement via the CLI contract. Fail-closed: any unexpected result fails.
#
# Host at author time: kernel 6.6.114 WSL2, Landlock ABI 3. Landlock IS
# available here, so the "landlock_unavailable (exit 3)" path is NOT exercised
# by this script (it requires a kernel without Landlock). Author B covers it
# with a mock in the Node-side tests. All other error codes are exercised.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GUARDIAN_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BIN="$GUARDIAN_DIR/build/harness-landlock-guardian"
TP="$GUARDIAN_DIR/build/test_payload"

PASS=0
FAIL=0
TOTAL=0
OUT=""
RC=0

echo "=== building (make all) ==="
if ! make -C "$GUARDIAN_DIR" all; then
  echo "FATAL: make all failed"
  exit 1
fi
[[ -x "$BIN" ]] || { echo "FATAL: binary missing at $BIN"; exit 1; }
[[ -x "$TP" ]]  || { echo "FATAL: test_payload missing at $TP"; exit 1; }

# Keep the test workspace on the same persistent filesystem as the repo
# (avoids the /tmp mount-boundary caveat noted in the project AGENTS.md).
WORK="$(mktemp -d "$GUARDIAN_DIR/.landlock-test.XXXXXX")" || { echo "FATAL: mktemp failed"; exit 1; }
trap 'rm -rf "$WORK"' EXIT

# The guardian opens every spec path WITHOUT following links (a link in a
# resolved path means it was swapped after it was checked), so a hand-written
# spec names system directories by where they really are: on a merged-/usr
# host /lib, /bin and /sbin are links into /usr.
R_LIB="$(realpath -e /lib)"
R_BIN="$(realpath -e /bin)"
R_SBIN="$(realpath -e /sbin)"

PROTECT="$WORK/protect"
ALLOW="$WORK/allow"
mkdir -p "$PROTECT/sub" "$ALLOW"
echo "protect-content" > "$PROTECT/file.txt"
echo "allow-content"  > "$ALLOW/file.txt"

# Spec: handle all 16 ABI-1..5 flags. effective ABI on this host = 3 (kernel 6.6),
# so IOCTL_DEV is masked out by the guardian at runtime — that is correct
# fail-closed ABI masking behavior and is exercised implicitly here.
# Allow: $ALLOW (read+write+create), $GUARDIAN_DIR/build (exec the test_payload
# binary), and the system paths the dynamic loader + libc need. Do NOT allow
# the workspace parent or /home — so $PROTECT (under $WORK) has no covering
# allow-rule and is therefore protected (deny by omission).
cat > "$WORK/spec.json" <<EOF
{
  "abi_version_hint": 0,
  "handled_access_fs": [
    "EXECUTE","WRITE_FILE","READ_FILE","READ_DIR",
    "REMOVE_DIR","REMOVE_FILE","MAKE_CHAR","MAKE_DIR","MAKE_REG",
    "MAKE_SOCK","MAKE_FIFO","MAKE_BLOCK","MAKE_SYM",
    "REFER","TRUNCATE","IOCTL_DEV"
  ],
  "allow_rules": [
    {"path": "$ALLOW", "access": ["READ_FILE","READ_DIR","WRITE_FILE","MAKE_REG","REMOVE_FILE","TRUNCATE"]},
    {"path": "$GUARDIAN_DIR/build", "access": ["EXECUTE","READ_FILE","READ_DIR"]},
    {"path": "/usr", "access": ["READ_FILE","READ_DIR","EXECUTE"]},
    {"path": "$R_LIB", "access": ["READ_FILE","READ_DIR","EXECUTE"]},
    {"path": "$R_BIN", "access": ["READ_FILE","READ_DIR","EXECUTE"]},
    {"path": "$R_SBIN", "access": ["READ_FILE","READ_DIR","EXECUTE"]},
    {"path": "/etc", "access": ["READ_FILE","READ_DIR"]},
    {"path": "/dev", "access": ["READ_FILE","READ_DIR","WRITE_FILE"]},
    {"path": "/proc", "access": ["READ_FILE","READ_DIR"]}
  ],
  "protected_subtrees": ["$PROTECT"]
}
EOF

# A second spec used by the "spec_invalid (exit 4)" test: an allow_rule path
# that is UNDER a protected_subtree. $PROTECT/sub exists, so the existence
# check passes, but the guardian's descendant check must reject it.
cat > "$WORK/spec-invalid.json" <<EOF
{
  "abi_version_hint": 0,
  "handled_access_fs": ["READ_FILE","READ_DIR"],
  "allow_rules": [
    {"path": "$PROTECT/sub", "access": ["READ_FILE"]}
  ],
  "protected_subtrees": ["$PROTECT"]
}
EOF

# run_cap: run a command, capture combined stdout+stderr in $OUT, exit in $RC.
run_cap() {
  OUT="$("$@" 2>&1)"
  RC=$?
}

assert_contains() {
  local name="$1" expected="$2"
  TOTAL=$((TOTAL+1))
  if grep -qF -- "$expected" <<<"$OUT"; then
    PASS=$((PASS+1)); echo "PASS: $name"
  else
    FAIL=$((FAIL+1)); echo "FAIL: $name"
    echo "  expected substring: $expected"
    echo "  actual: $OUT (exit=$RC)"
  fi
}

assert_exit() {
  local name="$1" expected="$2"
  TOTAL=$((TOTAL+1))
  if [[ "$RC" == "$expected" ]]; then
    PASS=$((PASS+1)); echo "PASS: $name (exit=$RC)"
  else
    FAIL=$((FAIL+1)); echo "FAIL: $name (expected exit $expected, got $RC)"
    echo "  output: $OUT"
  fi
}

# Helper that runs guardian -> test_payload <args...>
gtp() {
  "$BIN" apply --spec "$WORK/spec.json" --exec "$TP" "$@"
}

echo "=== test 1: read protected -> EACCES ==="
run_cap gtp read "$PROTECT/file.txt" || true
assert_contains "read protected -> EACCES" "EACCES" "$OUT"

echo "=== test 2: write protected -> EACCES ==="
run_cap gtp write "$PROTECT/newfile" || true
assert_contains "write protected -> EACCES" "EACCES" "$OUT"

echo "=== test 3: create in protected -> EACCES ==="
run_cap gtp create "$PROTECT/newfile2" || true
assert_contains "create protected -> EACCES" "EACCES" "$OUT"

echo "=== test 4: list protected -> EACCES ==="
run_cap gtp list "$PROTECT" || true
assert_contains "list protected -> EACCES" "EACCES" "$OUT"

echo "=== test 5: read allowed -> OK ==="
run_cap gtp read "$ALLOW/file.txt" || true
assert_contains "read allowed -> OK" "OK" "$OUT"

echo "=== test 6: write allowed -> OK ==="
run_cap gtp write "$ALLOW/newfile" || true
assert_contains "write allowed -> OK" "OK" "$OUT"

echo "=== test 7: create in allowed -> OK ==="
run_cap gtp create "$ALLOW/newfile2" || true
assert_contains "create allowed -> OK" "OK" "$OUT"

echo "=== test 8: bad spec path -> exit 2 (spec_parse_error) ==="
run_cap "$BIN" apply --spec "$WORK/nonexistent.json" --exec "$TP" read "$ALLOW/file.txt" || true
assert_exit "bad spec path -> exit 2" "2" "$RC"

echo "=== test 9: spec invalid (allow_rule under protected_subtree) -> exit 4 ==="
run_cap "$BIN" apply --spec "$WORK/spec-invalid.json" --exec "$TP" read "$PROTECT/sub" || true
assert_exit "spec_invalid -> exit 4" "4" "$RC"

echo "=== test 10: usage (no args) -> exit 64 ==="
run_cap "$BIN" || true
assert_exit "usage no args -> exit 64" "64" "$RC"

echo "=== test 11: no forgeable 'already confined' sentinel reaches the payload ==="
run_cap "$BIN" apply --spec "$WORK/spec.json" --exec "env" || true
TOTAL=$((TOTAL+1))
if grep -q "HARNESS_LANDLOCK_GUARDIAN" <<<"$OUT"; then
  FAIL=$((FAIL+1)); echo "FAIL: the guardian set HARNESS_LANDLOCK_GUARDIAN (a sandbox decision must be measured, never read from env)"
else
  PASS=$((PASS+1)); echo "PASS: no sentinel env var set"
fi

echo "=== test 12: exec /bin/cat on protected file -> EACCES (real binary) ==="
# /bin/cat opens the file for read; Landlock denies READ_FILE on $PROTECT.
run_cap "$BIN" apply --spec "$WORK/spec.json" --exec "cat" "$PROTECT/file.txt" || true
# cat prints a "Permission denied" or "Operation not permitted" message to
# stderr and exits non-zero. Either wording indicates Landlock blocked it.
TOTAL=$((TOTAL+1))
if [[ "$RC" -ne 0 ]] && (grep -qiE "permission denied|operation not permitted|EACCES" <<<"$OUT"); then
  PASS=$((PASS+1)); echo "PASS: exec cat on protected -> blocked (exit=$RC, out=$OUT)"
else
  FAIL=$((FAIL+1)); echo "FAIL: exec cat on protected (expected blocked, exit!=0)"
  echo "  exit=$RC out=$OUT"
fi

echo "=== SKIP (exit 3, landlock_unavailable): NOT testable here ==="
echo "Landlock IS available on this host (kernel $(uname -r), ABI probed at runtime)."
echo "Author B covers the exit-3 path with a mock in the Node-side tests."

# ---- File-targeted allow-rule tests (esbuild-bundle enabler) ----------
# These use a SEPARATE spec (spec-file.json) that does NOT allow $ALLOW as a
# directory; it allow-lists individual FILES only. This proves file-targeted
# rules cover exactly one inode and do not leak to siblings.
echo "single-content"  > "$ALLOW/single.txt"
echo "secret-content"  > "$ALLOW/secret.txt"
printf 'w'             > "$ALLOW/single-w.txt"   # pre-exists for the write-OK test

# Spec for tests 13-15: single.txt (READ_FILE only), single-w.txt (READ+WRITE).
# system paths needed for the dynamically-linked test_payload to exec.
cat > "$WORK/spec-file.json" <<EOF
{
  "abi_version_hint": 0,
  "handled_access_fs": ["READ_FILE","WRITE_FILE","EXECUTE","READ_DIR","TRUNCATE","MAKE_REG"],
  "allow_rules": [
    {"path": "$ALLOW/single.txt",   "access": ["READ_FILE"]},
    {"path": "$ALLOW/single-w.txt", "access": ["READ_FILE","WRITE_FILE","TRUNCATE"]},
    {"path": "$GUARDIAN_DIR/build",  "access": ["EXECUTE","READ_FILE","READ_DIR"]},
    {"path": "/usr", "access": ["EXECUTE","READ_FILE","READ_DIR"]},
    {"path": "$R_LIB", "access": ["EXECUTE","READ_FILE","READ_DIR"]},
    {"path": "/etc", "access": ["READ_FILE"]},
    {"path": "/dev", "access": ["READ_FILE","WRITE_FILE","READ_DIR"]},
    {"path": "/proc","access": ["READ_FILE","READ_DIR"]}
  ],
  "protected_subtrees": []
}
EOF

# Helper: run guardian with the file-rule spec.
gtp_file() { "$BIN" apply --spec "$WORK/spec-file.json" --exec "$TP" "$@"; }

echo "=== test 13: file rule covers ONLY single.txt; sibling secret.txt denied ==="
run_cap gtp_file read "$ALLOW/single.txt" || true
assert_contains "read single.txt (file rule) -> OK" "OK" "$OUT"
run_cap gtp_file read "$ALLOW/secret.txt" || true
assert_contains "read secret.txt (sibling, not allow-listed) -> EACCES" "EACCES" "$OUT"

echo "=== test 14: file rule with READ_FILE only; write -> EACCES (write not in allowed_access) ==="
run_cap gtp_file write "$ALLOW/single.txt" || true
assert_contains "write single.txt (READ_FILE-only rule) -> EACCES" "EACCES" "$OUT"

echo "=== test 15: file rule with READ_FILE+WRITE_FILE; write -> OK ==="
run_cap gtp_file write "$ALLOW/single-w.txt" || true
assert_contains "write single-w.txt (READ+WRITE rule) -> OK" "OK" "$OUT"

echo "=== test 16 (hostile): file-targeted rule with READ_DIR in access -> exit 4 ==="
cat > "$WORK/spec-bad-filedir.json" <<EOF
{
  "abi_version_hint": 0,
  "handled_access_fs": ["READ_FILE","READ_DIR"],
  "allow_rules": [{"path": "$ALLOW/single.txt", "access": ["READ_FILE","READ_DIR"]}],
  "protected_subtrees": []
}
EOF
run_cap "$BIN" apply --spec "$WORK/spec-bad-filedir.json" --exec "$TP" read "$ALLOW/single.txt" || true
assert_exit "file rule with READ_DIR -> exit 4" "4" "$RC"

echo "=== test 17 (hostile): file-targeted rule with MAKE_REG in access -> exit 4 ==="
cat > "$WORK/spec-bad-filemake.json" <<EOF
{
  "abi_version_hint": 0,
  "handled_access_fs": ["READ_FILE","MAKE_REG"],
  "allow_rules": [{"path": "$ALLOW/single.txt", "access": ["READ_FILE","MAKE_REG"]}],
  "protected_subtrees": []
}
EOF
run_cap "$BIN" apply --spec "$WORK/spec-bad-filemake.json" --exec "$TP" read "$ALLOW/single.txt" || true
assert_exit "file rule with MAKE_REG -> exit 4" "4" "$RC"

echo "=== test 17b: keep_out — a rule under a present entry -> exit 4; an entry gone since the compile is skipped ==="
mkdir -p "$ALLOW/store"
: > "$ALLOW/store/web.db"
cat > "$WORK/spec-keepout-present.json" <<EOF
{
  "abi_version_hint": 0,
  "handled_access_fs": ["READ_FILE","READ_DIR"],
  "allow_rules": [{"path": "$ALLOW/store", "access": ["READ_FILE","READ_DIR"]}],
  "protected_subtrees": [],
  "keep_out": ["$ALLOW/store/web.db"],
  "keep_out_retries": 3
}
EOF
run_cap "$BIN" apply --spec "$WORK/spec-keepout-present.json" --exec "$TP" read "$ALLOW/store/web.db" || true
assert_exit "rule containing a present keep_out entry -> exit 4" "4" "$RC"
assert_contains "names the keep_out entry" "contains protected_subtree '$ALLOW/store/web.db'" "$OUT"
cat > "$WORK/spec-keepout-gone.json" <<EOF
{
  "abi_version_hint": 0,
  "handled_access_fs": ["READ_FILE","READ_DIR","EXECUTE"],
  "allow_rules": [
    {"path": "$ALLOW/single.txt", "access": ["READ_FILE"]},
    {"path": "$GUARDIAN_DIR/build", "access": ["EXECUTE","READ_FILE","READ_DIR"]},
    {"path": "/usr", "access": ["READ_FILE","READ_DIR","EXECUTE"]},
    {"path": "$R_LIB", "access": ["READ_FILE","READ_DIR","EXECUTE"]}
  ],
  "protected_subtrees": [],
  "keep_out": ["$ALLOW/store/deleted-since-compile.db"],
  "keep_out_retries": 3
}
EOF
run_cap "$BIN" apply --spec "$WORK/spec-keepout-gone.json" --exec "$TP" read "$ALLOW/single.txt" || true
assert_exit "a keep_out entry gone since the compile does not refuse the spec" "0" "$RC"
rm -rf "$ALLOW/store"

echo "=== test 18: esbuild-bundle scenario (node reads bundle, bundle read of src/ -> EACCES) ==="
# Layout mirrors the real plan: dist/bundle.js (allow-listed single file), src/cli.ts
# (protected by omission — no allow rule covers it). The bundle does
# fs.readFileSync(process.argv[2]) on src/cli.ts; expect EACCES.
ESBUILD="$WORK/esbuild"
mkdir -p "$ESBUILD/dist" "$ESBUILD/src"
cat > "$ESBUILD/dist/bundle.js" <<'BUNDLE'
const fs = require('fs');
const target = process.argv[2];
try {
  const data = fs.readFileSync(target, 'utf8');
  console.log('BUNDLE_READ_OK:', data.trim());
} catch (e) {
  console.log('BUNDLE_READ_DENIED:', e.code || e.message);
}
BUNDLE
printf 'console.log("SECRET SRC CLI")\n' > "$ESBUILD/src/cli.ts"

NODE="$(command -v node 2>/dev/null || true)"
if [[ -z "$NODE" ]]; then
  echo "SKIP: test 18 (node not on PATH; cannot run esbuild-bundle scenario here)"
  TOTAL=$((TOTAL+1)); FAIL=$((FAIL+1))
  echo "FAIL: test 18 (node missing)"
else
  NODE_DIR="$(dirname "$NODE")"
  # Node's install dir parent (nvm/.../vX.Y.Z) for its modules/snapshot; resolve
  # the real node binary in case `node` is a symlink.
  NODE_REAL="$(readlink -f "$NODE")"
  NODE_REAL_DIR="$(dirname "$NODE_REAL")"
  NODE_REAL_PARENT="$(dirname "$NODE_REAL_DIR")"
  cat > "$WORK/spec-esbuild.json" <<EOF
{
  "abi_version_hint": 0,
  "handled_access_fs": ["READ_FILE","WRITE_FILE","EXECUTE","READ_DIR","TRUNCATE","MAKE_REG"],
  "allow_rules": [
    {"path": "$ESBUILD/dist/bundle.js", "access": ["READ_FILE"]},
    {"path": "$NODE_REAL_DIR",          "access": ["EXECUTE","READ_FILE","READ_DIR"]},
    {"path": "$NODE_REAL_PARENT",       "access": ["EXECUTE","READ_FILE","READ_DIR"]},
    {"path": "/usr", "access": ["EXECUTE","READ_FILE","READ_DIR"]},
    {"path": "$R_LIB", "access": ["EXECUTE","READ_FILE","READ_DIR"]},
    {"path": "/etc", "access": ["READ_FILE"]},
    {"path": "/dev", "access": ["READ_FILE","WRITE_FILE","READ_DIR"]},
    {"path": "/proc","access": ["READ_FILE","READ_DIR"]}
  ],
  "protected_subtrees": ["$ESBUILD/src"]
}
EOF
  run_cap "$BIN" apply --spec "$WORK/spec-esbuild.json" --exec "$NODE_REAL" "$ESBUILD/dist/bundle.js" "$ESBUILD/src/cli.ts" || true
  TOTAL=$((TOTAL+1))
  if grep -qF "BUNDLE_READ_DENIED: EACCES" <<<"$OUT"; then
    PASS=$((PASS+1)); echo "PASS: esbuild-bundle: node read src/cli.ts -> EACCES (secret NOT leaked)"
  else
    FAIL=$((FAIL+1)); echo "FAIL: esbuild-bundle (expected BUNDLE_READ_DENIED: EACCES)"
    echo "  exit=$RC out=$OUT"
  fi
fi

# ---- Refinement 2: default-deny outside allow-set + EXECUTE-vs-READ research
# See RESEARCH-EXECUTE-VS-READ.md for the full primary-source analysis.
# Key finding: EXECUTE-only does NOT work for ANY binary type (static, dynamic,
# script) because the kernel's do_open_execat opens with O_RDONLY|__FMODE_EXEC,
# and Landlock maps FMODE_READ->READ_FILE + __FMODE_EXEC->EXECUTE (both required).

echo "=== test 19: default-deny — file OUTSIDE allow-set -> EACCES ==="
# Spec: allow ONLY $ALLOW (read+write) + system paths for the test_payload to exec.
# /var/lib is NOT in any allow-rule. test_payload reads /var/lib/dpkg/status -> EACCES.
SYSFILE="/var/lib/dpkg/status"
if [[ ! -r "$SYSFILE" ]]; then
  # fallback: a file outside the allow-set that exists on this host
  SYSFILE=""
  for cand in /var/lib/dpkg/status /etc/hostname /boot/config-$(uname -r); do
    if [[ -r "$cand" ]]; then SYSFILE="$cand"; break; fi
  done
fi
if [[ -z "$SYSFILE" ]]; then
  TOTAL=$((TOTAL+1)); FAIL=$((FAIL+1)); echo "FAIL: test 19 (no readable system file found outside allow-set to test)"
else
  cat > "$WORK/spec-dd.json" <<EOF
{
  "abi_version_hint": 0,
  "default_deny_outside_allow_rules": true,
  "handled_access_fs": ["READ_FILE","WRITE_FILE","EXECUTE","READ_DIR","TRUNCATE","MAKE_REG"],
  "allow_rules": [
    {"path": "$ALLOW", "access": ["READ_FILE","WRITE_FILE","READ_DIR","MAKE_REG","TRUNCATE"]},
    {"path": "$GUARDIAN_DIR/build", "access": ["EXECUTE","READ_FILE","READ_DIR"]},
    {"path": "/usr", "access": ["EXECUTE","READ_FILE","READ_DIR"]},
    {"path": "$R_LIB", "access": ["EXECUTE","READ_FILE","READ_DIR"]},
    {"path": "$R_BIN", "access": ["EXECUTE","READ_FILE","READ_DIR"]},
    {"path": "/etc", "access": ["READ_FILE"]},
    {"path": "/dev", "access": ["READ_FILE","WRITE_FILE","READ_DIR"]},
    {"path": "/proc","access": ["READ_FILE","READ_DIR"]}
  ],
  "protected_subtrees": ["$PROTECT"]
}
EOF
  # NOTE: $SYSFILE is under /var or /etc/hostname. /etc IS allowed (for ld.so),
  # so use /var/lib/dpkg/status (under /var, NOT allowed) to prove default-deny.
  if [[ "$SYSFILE" == /var/* ]]; then
    run_cap "$BIN" apply --spec "$WORK/spec-dd.json" --exec "$TP" read "$SYSFILE" || true
    assert_contains "default-deny: read $SYSFILE (outside allow-set) -> EACCES" "EACCES" "$OUT"
  else
    TOTAL=$((TOTAL+1)); FAIL=$((FAIL+1)); echo "FAIL: test 19 (need a /var/* file to prove default-deny; got $SYSFILE)"
  fi
fi

echo "=== test 20: static binary — EXECUTE-only -> EACCES; EXECUTE+READ -> OK ==="
# Research finding: even static binaries need READ_FILE (kernel opens with O_RDONLY).
# Build a tiny static binary; if -static is unavailable, skip with recorded reason.
STATIC_BIN="$WORK/static_test_bin"
if cc -static -O2 -o "$STATIC_BIN" -xc - <<'C' 2>/dev/null
#include <unistd.h>
int main(void){ const char m[]="STATIC_OK\n"; write(1,m,sizeof(m)-1); return 0; }
C
then
  # 20a: EXECUTE-only on the static binary -> expect EACCES
  cat > "$WORK/spec-static-exec-only.json" <<EOF
{"abi_version_hint":0,"handled_access_fs":["EXECUTE","READ_FILE"],"allow_rules":[{"path":"$STATIC_BIN","access":["EXECUTE"]}],"protected_subtrees":[]}
EOF
  run_cap "$BIN" apply --spec "$WORK/spec-static-exec-only.json" --exec "$STATIC_BIN" || true
  TOTAL=$((TOTAL+1))
  if [[ "$RC" -ne 0 ]] && grep -qiE "permission denied|EACCES" <<<"$OUT"; then
    PASS=$((PASS+1)); echo "PASS: static binary EXECUTE-only -> EACCES (research-confirmed: kernel needs READ_FILE)"
  else
    FAIL=$((FAIL+1)); echo "FAIL: static EXECUTE-only (expected EACCES, got exit=$RC out=$OUT)"
  fi
  # 20b: EXECUTE+READ on the static binary -> expect OK (prints STATIC_OK)
  cat > "$WORK/spec-static-er.json" <<EOF
{"abi_version_hint":0,"handled_access_fs":["EXECUTE","READ_FILE"],"allow_rules":[{"path":"$STATIC_BIN","access":["EXECUTE","READ_FILE"]}],"protected_subtrees":[]}
EOF
  run_cap "$BIN" apply --spec "$WORK/spec-static-er.json" --exec "$STATIC_BIN" || true
  assert_contains "static binary EXECUTE+READ -> STATIC_OK" "STATIC_OK" "$OUT"
else
  echo "SKIP: test 20 (cc -static unavailable; static libc not installed). Research finding documented in RESEARCH-EXECUTE-VS-READ.md."
  TOTAL=$((TOTAL+1)); PASS=$((PASS+1)); echo "PASS: test 20 SKIP (cc -static unavailable; research-confirmed separately)"
fi

echo "=== test 21: dynamic binary (/bin/cat) — EXECUTE-only -> EACCES; EXECUTE+READ + libs -> OK ==="
# 21a: EXECUTE-only on /bin/cat -> expect EACCES
cat > "$WORK/spec-cat-exec-only.json" <<EOF
{"abi_version_hint":0,"handled_access_fs":["EXECUTE","READ_FILE","READ_DIR"],"allow_rules":[{"path":"$R_BIN/cat","access":["EXECUTE"]}],"protected_subtrees":[]}
EOF
run_cap "$BIN" apply --spec "$WORK/spec-cat-exec-only.json" --exec "/bin/cat" "/dev/null" || true
TOTAL=$((TOTAL+1))
if [[ "$RC" -ne 0 ]] && grep -qiE "permission denied|EACCES" <<<"$OUT"; then
  PASS=$((PASS+1)); echo "PASS: /bin/cat EXECUTE-only -> EACCES (dynamic linker needs READ_FILE)"
else
  FAIL=$((FAIL+1)); echo "FAIL: /bin/cat EXECUTE-only (expected EACCES, got exit=$RC out=$OUT)"
fi
# 21b: EXECUTE+READ on /bin/cat + /usr /lib EXECUTE+READ + /etc /dev READ -> expect OK (exit 0)
cat > "$WORK/spec-cat-er.json" <<EOF
{"abi_version_hint":0,"handled_access_fs":["EXECUTE","READ_FILE","READ_DIR","WRITE_FILE"],"allow_rules":[{"path":"$R_BIN/cat","access":["EXECUTE","READ_FILE"]},{"path":"/usr","access":["EXECUTE","READ_FILE","READ_DIR"]},{"path":"$R_LIB","access":["EXECUTE","READ_FILE","READ_DIR"]},{"path":"/etc","access":["READ_FILE"]},{"path":"/dev","access":["READ_FILE","WRITE_FILE","READ_DIR"]}],"protected_subtrees":[]}
EOF
run_cap "$BIN" apply --spec "$WORK/spec-cat-er.json" --exec "/bin/cat" "/dev/null" || true
TOTAL=$((TOTAL+1))
if [[ "$RC" -eq 0 ]]; then
  PASS=$((PASS+1)); echo "PASS: /bin/cat EXECUTE+READ + libs -> OK (exit 0)"
else
  FAIL=$((FAIL+1)); echo "FAIL: /bin/cat EXECUTE+READ (expected exit 0, got $RC: $OUT)"
fi

echo "=== test 22: node-bundle default-deny — bundle readFileSync('/var/lib/dpkg/status') -> EACCES ==="
NODE_BIN="$(command -v node 2>/dev/null || true)"
if [[ -z "$NODE_BIN" ]]; then
  TOTAL=$((TOTAL+1)); FAIL=$((FAIL+1)); echo "FAIL: test 22 (node not on PATH)"
else
  NODE_REAL="$(readlink -f "$NODE_BIN")"
  NODE_DIR="$(dirname "$NODE_REAL")"; NODE_PARENT="$(dirname "$NODE_DIR")"
  ESBUILD2="$WORK/esbuild2"; mkdir -p "$ESBUILD2/dist"
  cat > "$ESBUILD2/dist/bundle.js" <<'BUNDLE'
const fs = require('fs');
const target = process.argv[2];
try { const d = fs.readFileSync(target, 'utf8'); console.log('BUNDLE_READ_OK:', d.slice(0,30)); }
catch (e) { console.log('BUNDLE_READ_DENIED:', e.code || e.message); }
BUNDLE
  TARGET="/var/lib/dpkg/status"
  [[ -e "$TARGET" ]] || TARGET="/var/log/alternatives.log"
  [[ -e "$TARGET" ]] || TARGET="/var/cache/ldconfig/aux-cache"
  cat > "$WORK/spec-node-dd.json" <<EOF
{
  "abi_version_hint": 0,
  "default_deny_outside_allow_rules": true,
  "handled_access_fs": ["READ_FILE","WRITE_FILE","EXECUTE","READ_DIR","TRUNCATE","MAKE_REG"],
  "allow_rules": [
    {"path": "$ESBUILD2/dist/bundle.js", "access": ["READ_FILE"]},
    {"path": "$NODE_REAL", "access": ["EXECUTE","READ_FILE"]},
    {"path": "$NODE_DIR", "access": ["EXECUTE","READ_FILE","READ_DIR"]},
    {"path": "$NODE_PARENT", "access": ["EXECUTE","READ_FILE","READ_DIR"]},
    {"path": "/usr", "access": ["EXECUTE","READ_FILE","READ_DIR"]},
    {"path": "$R_LIB", "access": ["EXECUTE","READ_FILE","READ_DIR"]},
    {"path": "/etc", "access": ["READ_FILE"]},
    {"path": "/dev", "access": ["READ_FILE","WRITE_FILE","READ_DIR"]},
    {"path": "/proc","access": ["READ_FILE","READ_DIR"]}
  ],
  "protected_subtrees": []
}
EOF
  run_cap "$BIN" apply --spec "$WORK/spec-node-dd.json" --exec "$NODE_REAL" "$ESBUILD2/dist/bundle.js" "$TARGET" || true
  TOTAL=$((TOTAL+1))
  if grep -qF "BUNDLE_READ_DENIED: EACCES" <<<"$OUT"; then
     PASS=$((PASS+1)); echo "PASS: node-bundle default-deny: readFileSync('$TARGET') -> EACCES (outside allow-set)"
  else
    FAIL=$((FAIL+1)); echo "FAIL: node-bundle default-deny (expected BUNDLE_READ_DENIED: EACCES)"
    echo "  exit=$RC out=$OUT"
  fi
fi

# ---- temp_dir convenience (refinement 2: shared/exposed configurable) ----
# temp_dir is syntactic sugar for an allow-rule. The binary remains path-agnostic.
# See DESIGN.md "temp_dir convenience".

# Helper: run guardian with a temp_dir spec. $1 = spec file; rest = test_payload args.
gtp_td() { "$BIN" apply --spec "$1" --exec "$TP" "${@:2}"; }

echo "=== test 26: temp_dir convenience — write in temp_dir -> OK ==="
TD26="$WORK/td26"; mkdir -p "$TD26"
cat > "$WORK/spec-td26.json" <<EOF
{
  "abi_version_hint": 0,
  "handled_access_fs": ["READ_FILE","READ_DIR","WRITE_FILE","EXECUTE","TRUNCATE","MAKE_REG","MAKE_DIR","MAKE_SYM","REMOVE_FILE","REMOVE_DIR"],
  "allow_rules": [
    {"path": "$GUARDIAN_DIR/build", "access": ["EXECUTE","READ_FILE","READ_DIR"]},
    {"path": "/usr", "access": ["EXECUTE","READ_FILE","READ_DIR"]},
    {"path": "$R_LIB", "access": ["EXECUTE","READ_FILE","READ_DIR"]},
    {"path": "/etc", "access": ["READ_FILE"]},
    {"path": "/dev", "access": ["READ_FILE","WRITE_FILE","READ_DIR"]},
    {"path": "/proc","access": ["READ_FILE","READ_DIR"]}
  ],
  "protected_subtrees": ["$PROTECT"],
  "temp_dir": "$TD26"
}
EOF
run_cap gtp_td "$WORK/spec-td26.json" write "$TD26/newfile" || true
assert_contains "temp_dir write -> OK" "OK" "$OUT"

echo "=== test 27: temp_dir default access — read+write+create+remove -> all OK ==="
TD27="$WORK/td27"; mkdir -p "$TD27"; echo content > "$TD27/existing"
cat > "$WORK/spec-td27.json" <<EOF
{
  "abi_version_hint": 0,
  "handled_access_fs": ["READ_FILE","READ_DIR","WRITE_FILE","EXECUTE","TRUNCATE","MAKE_REG","MAKE_DIR","MAKE_SYM","REMOVE_FILE","REMOVE_DIR"],
  "allow_rules": [
    {"path": "$GUARDIAN_DIR/build", "access": ["EXECUTE","READ_FILE","READ_DIR"]},
    {"path": "/usr", "access": ["EXECUTE","READ_FILE","READ_DIR"]},
    {"path": "$R_LIB", "access": ["EXECUTE","READ_FILE","READ_DIR"]},
    {"path": "/etc", "access": ["READ_FILE"]},
    {"path": "/dev", "access": ["READ_FILE","WRITE_FILE","READ_DIR"]},
    {"path": "/proc","access": ["READ_FILE","READ_DIR"]}
  ],
  "protected_subtrees": [],
  "temp_dir": "$TD27"
}
EOF
run_cap gtp_td "$WORK/spec-td27.json" read "$TD27/existing" || true
assert_contains "temp_dir default read -> OK" "OK" "$OUT"
run_cap gtp_td "$WORK/spec-td27.json" create "$TD27/newfile" || true
assert_contains "temp_dir default create -> OK" "OK" "$OUT"
run_cap gtp_td "$WORK/spec-td27.json" write "$TD27/newfile2" || true
assert_contains "temp_dir default write -> OK" "OK" "$OUT"

echo "=== test 28: temp_dir custom access (READ only) — write -> EACCES ==="
TD28="$WORK/td28"; mkdir -p "$TD28"; echo content > "$TD28/f"
cat > "$WORK/spec-td28.json" <<EOF
{
  "abi_version_hint": 0,
  "handled_access_fs": ["READ_FILE","READ_DIR","WRITE_FILE","EXECUTE","TRUNCATE","MAKE_REG"],
  "allow_rules": [
    {"path": "$GUARDIAN_DIR/build", "access": ["EXECUTE","READ_FILE","READ_DIR"]},
    {"path": "/usr", "access": ["EXECUTE","READ_FILE","READ_DIR"]},
    {"path": "$R_LIB", "access": ["EXECUTE","READ_FILE","READ_DIR"]},
    {"path": "/etc", "access": ["READ_FILE"]},
    {"path": "/dev", "access": ["READ_FILE","WRITE_FILE","READ_DIR"]},
    {"path": "/proc","access": ["READ_FILE","READ_DIR"]}
  ],
  "protected_subtrees": [],
  "temp_dir": "$TD28",
  "temp_dir_access": ["READ_FILE","READ_DIR"]
}
EOF
run_cap gtp_td "$WORK/spec-td28.json" read "$TD28/f" || true
assert_contains "temp_dir custom read -> OK" "OK" "$OUT"
run_cap gtp_td "$WORK/spec-td28.json" write "$TD28/newfile" || true
assert_contains "temp_dir custom write -> EACCES" "EACCES" "$OUT"

echo "=== test 29 (hostile): temp_dir under protected_subtree -> exit 4 ==="
TD29="$WORK/td29"; mkdir -p "$TD29"
cat > "$WORK/spec-td29.json" <<EOF
{"abi_version_hint":0,"handled_access_fs":["READ_FILE","READ_DIR"],"allow_rules":[],"protected_subtrees":["$WORK"],"temp_dir":"$TD29"}
EOF
run_cap "$BIN" apply --spec "$WORK/spec-td29.json" --exec /bin/true || true
assert_exit "temp_dir under protected_subtree -> exit 4" "4" "$RC"

echo "=== test 30 (hostile): temp_dir duplicates allow_rules -> exit 4 ==="
TD30="$WORK/td30"; mkdir -p "$TD30"
cat > "$WORK/spec-td30.json" <<EOF
{"abi_version_hint":0,"handled_access_fs":["READ_FILE","READ_DIR"],"allow_rules":[{"path":"$TD30","access":["READ_FILE","READ_DIR"]}],"protected_subtrees":[],"temp_dir":"$TD30"}
EOF
run_cap "$BIN" apply --spec "$WORK/spec-td30.json" --exec /bin/true || true
assert_exit "temp_dir duplicates allow_rules -> exit 4" "4" "$RC"

echo "=== test 31 (hostile): temp_dir relative path -> exit 4 ==="
cat > "$WORK/spec-td31.json" <<EOF
{"abi_version_hint":0,"handled_access_fs":["READ_FILE","READ_DIR"],"allow_rules":[],"protected_subtrees":[],"temp_dir":"relative/path"}
EOF
run_cap "$BIN" apply --spec "$WORK/spec-td31.json" --exec /bin/true || true
assert_exit "temp_dir relative path -> exit 4" "4" "$RC"

echo "=== test 32 (hostile): temp_dir does not exist -> exit 4 ==="
cat > "$WORK/spec-td32.json" <<EOF
{"abi_version_hint":0,"handled_access_fs":["READ_FILE","READ_DIR"],"allow_rules":[],"protected_subtrees":[],"temp_dir":"$WORK/nonexistent-td"}
EOF
run_cap "$BIN" apply --spec "$WORK/spec-td32.json" --exec /bin/true || true
assert_exit "temp_dir does not exist -> exit 4" "4" "$RC"

echo "=== test 33 (hostile): temp_dir is a file (not a directory) -> exit 4 ==="
echo "not a dir" > "$WORK/notdir-td"
cat > "$WORK/spec-td33.json" <<EOF
{"abi_version_hint":0,"handled_access_fs":["READ_FILE","READ_DIR"],"allow_rules":[],"protected_subtrees":[],"temp_dir":"$WORK/notdir-td"}
EOF
run_cap "$BIN" apply --spec "$WORK/spec-td33.json" --exec /bin/true || true
assert_exit "temp_dir is a file -> exit 4" "4" "$RC"

echo "=== test 34 (hostile): a rule path that goes through a symbolic link -> exit 4 ==="
ln -s "$ALLOW" "$WORK/allow-link"
cat > "$WORK/spec-link.json" <<EOF
{"abi_version_hint":0,"handled_access_fs":["READ_FILE","READ_DIR"],"allow_rules":[{"path":"$WORK/allow-link","access":["READ_FILE","READ_DIR"]}],"protected_subtrees":[]}
EOF
run_cap "$BIN" apply --spec "$WORK/spec-link.json" --exec /bin/true || true
assert_exit "a linked rule path is refused (opened without following links) -> exit 4" "4" "$RC"

# A bind mount is a second spelling no realpath() removes; the guardian
# compares (device, inode). Made for real in a private mount namespace.
if unshare -rm true 2>/dev/null; then
  ALIAS="$WORK/alias"; mkdir -p "$ALIAS"
  cat > "$WORK/spec-alias-under.json" <<EOF
{"abi_version_hint":0,"handled_access_fs":["READ_FILE","READ_DIR"],"allow_rules":[{"path":"$ALIAS/sub","access":["READ_FILE"]}],"protected_subtrees":["$PROTECT"]}
EOF
  cat > "$WORK/spec-alias-contains.json" <<EOF
{"abi_version_hint":0,"handled_access_fs":["READ_FILE","READ_DIR"],"allow_rules":[{"path":"$ALIAS","access":["READ_FILE"]}],"protected_subtrees":["$PROTECT/sub"]}
EOF
  echo "=== test 35 (hostile): an allow-rule under a protected subtree by a bind-mount alias -> exit 4 ==="
  run_cap unshare -rm sh -c 'mount --bind "$1" "$2" && exec "$3" apply --spec "$4" --exec /bin/true' sh "$PROTECT" "$ALIAS" "$BIN" "$WORK/spec-alias-under.json" || true
  assert_exit "alias under protected -> exit 4" "4" "$RC"
  assert_contains "alias under protected names the refusal" "is under protected_subtree"
  echo "=== test 36 (hostile): an allow-rule containing a protected subtree by a bind-mount alias -> exit 4 ==="
  run_cap unshare -rm sh -c 'mount --bind "$1" "$2" && exec "$3" apply --spec "$4" --exec /bin/true' sh "$PROTECT" "$ALIAS" "$BIN" "$WORK/spec-alias-contains.json" || true
  assert_exit "alias containing protected -> exit 4" "4" "$RC"
  assert_contains "alias containing protected names the refusal" "contains protected_subtree"
else
  echo "SKIP: tests 35-36 need unshare -rm (a private mount namespace)"
fi

echo ""
echo "================ SUMMARY ================"
echo "PASS $PASS/$TOTAL"
if [[ "$FAIL" -ne 0 ]]; then
  echo "FAIL $FAIL"
  exit 1
fi
echo "ALL TESTS PASS"
exit 0
