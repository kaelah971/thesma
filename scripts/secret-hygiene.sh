#!/usr/bin/env bash
# Tracked-secret hygiene gate. Fails on obvious committed secrets without
# ever printing secret contents (only file names and match locations).
#
# Allowlisted by design (never flagged):
#   .env.example, public contract addresses, transaction hashes,
#   test-only dummy keys built with generatePrivateKey() (see exclusions).
set -euo pipefail

fail=0
say() { printf '%s\n' "$*"; }

# --- 1. Tracked secret-looking filenames (.env.example explicitly allowed).
names="$(git ls-files | grep -E '(^|/)\.env(\.|$)|(^|/)\.env\.local|(^|/)\.pem$|(^|/)\.key$|(^|/)id_rsa|(^|/)\.mnemonic$' || true)"
names="$(printf '%s\n' "$names" | grep -v -E '\.env\.example$' || true)"
if [ -n "$names" ]; then
  say "FAIL: tracked secret-looking files (only names shown):"
  say "$names"
  fail=1
else
  say "PASS: no tracked secret files"
fi

# --- 2. Key material in tracked content.
# Exclusions: .env.example (documented placeholder) and two test files whose
# keys are random per-run fixtures via generatePrivateKey(), never values.
hits="$(git grep -n -E -e '-----BEGIN (RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----' -e '(THESMA|DEPLOYER|ARC)_[A-Z_]*PRIVATE_KEY\s*[:=]' -e 'sk_live_[0-9A-Za-z]+' -e 'AKIA[0-9A-Z]{16}' -e 'ghp_[0-9A-Za-z]{36}' -- . ':!.env.example' ':!tests/slice10a-rehearsal.test.ts' ':!tests/verification.test.ts' || true)"
if [ -n "$hits" ]; then
  say "FAIL: possible secret material in tracked files (locations only):"
  say "$hits" | cut -c1-160
  fail=1
else
  say "PASS: no secret material in tracked files"
fi

exit "$fail"
