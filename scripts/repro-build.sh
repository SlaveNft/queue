#!/usr/bin/env bash
# Rebuild a contract from this repository and compare it, byte for byte, with the code deployed on NEAR testnet.
# Read-only: no keys, no transactions.
#
#   scripts/repro-build.sh <contract dir> <account id>
#
# Prints the built and the deployed sha256. Exit 0 = equal; 1 = different on the deployer's platform;
# 3 = different host platform (the comparison cannot hold there).
#
# Why the extra flags. A release wasm keeps the source paths of its dependencies in its panic messages, and those
# paths start with the cargo home of whoever built it (the deployed code names its builder's crate directory; the
# script prints it as "deployed from"). The same source built under another cargo home therefore differs in those
# strings and in its hash. The build below maps this machine's crate directory onto the deployer's with
# `--remap-path-prefix` and uses the toolchain pinned in rust-toolchain.toml, so the same source gives the same bytes
# under any cargo home. The compiled output still depends on the host platform: the deployed code was built on macOS
# on Apple silicon, and a Linux host produces a different wasm from the same source. It builds into <contract dir>/target/repro and leaves the normal build alone.
set -euo pipefail
cd "$(dirname "$0")/.."
DIR="${1:?contract dir}"
ACCOUNT="${2:?account id}"

CHAIN="$(node --import tsx --input-type=module -e "
import { rpc } from './scripts/season/chain.ts';
const { createHash } = await import('node:crypto');
const c = await rpc('query', { request_type: 'view_code', finality: 'final', account_id: '$ACCOUNT' });
const code = Buffer.from(c.code_base64, 'base64');
const m = code.toString('latin1').match(/\/[A-Za-z0-9_.\/-]+?\/registry\/src\/index\.crates\.io-[0-9a-f]+/);
console.log(createHash('sha256').update(code).digest('hex') + ' ' + (m ? m[0] : '-'));
")"
ONCHAIN="${CHAIN%% *}"
DEPLOYED_SRC="${CHAIN#* }"

# --cfg near is what .cargo/config.toml sets for this target; RUSTFLAGS replaces that file's flags, so repeat it.
FLAGS="--cfg near"
if [ "$DEPLOYED_SRC" != "-" ]; then
  LOCAL_SRC="${CARGO_HOME:-$HOME/.cargo}/registry/src/${DEPLOYED_SRC##*/}"
  FLAGS="$FLAGS --remap-path-prefix=$LOCAL_SRC=$DEPLOYED_SRC"
fi

if command -v rustup >/dev/null 2>&1; then (cd "$DIR" && rustup toolchain install >/dev/null 2>&1) || true; fi
echo "toolchain     $(cd "$DIR" && rustc --version)"
echo "deployed from ${DEPLOYED_SRC%/registry/*}"
(cd "$DIR" && RUSTFLAGS="$FLAGS" CARGO_TARGET_DIR=target/repro cargo build --locked --quiet --target wasm32-unknown-unknown --release)
WASM="$(ls "$DIR"/target/repro/wasm32-unknown-unknown/release/*.wasm | head -1)"
BUILT="$(node -e 'const c=require("crypto");console.log(c.createHash("sha256").update(require("fs").readFileSync(process.argv[1])).digest("hex"))' "$WASM")"
echo "built         $BUILT ($DIR)"
echo "on chain      $ONCHAIN ($ACCOUNT)"
if [ "$BUILT" != "$ONCHAIN" ]; then
  HOST="$(uname -sm)"
  if [ "$HOST" != "Darwin arm64" ]; then
    echo "repro-build: DIFFERENT HOST: this machine is '$HOST'; the deployed code was built on 'Darwin arm64' (macOS, Apple silicon)."
    echo "repro-build: the same source compiles to a different wasm on another host platform, so this build cannot match."
    echo "repro-build: on any platform, 'npm run verify:onchain' and 'npm run verify:season' compare the hash recorded with each run to the chain."
    exit 3
  fi
  echo "repro-build: FAIL: the build differs from the deployed code (check that rustc is the version in rust-toolchain.toml)"
  exit 1
fi
echo "repro-build: OK: $DIR builds to the code deployed at $ACCOUNT, byte for byte"
