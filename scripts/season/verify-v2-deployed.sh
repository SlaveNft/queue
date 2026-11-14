#!/usr/bin/env bash
# Build the season contract from this repository (contracts/queue-v2) and compare its wasm with the deployment
# record (data/season/testnet.json) and the code on chain. Read-only: no keys, no transactions.
# The build is the reproducible one from scripts/repro-build.sh, so it matches under any cargo home on the deployer's platform (macOS on Apple silicon).
set -euo pipefail
cd "$(dirname "$0")/../.."
RECORDED="$(node -e 'console.log(JSON.parse(require("fs").readFileSync("data/season/testnet.json","utf8")).wasmSha256)')"
CONTRACT="$(node -e 'console.log(JSON.parse(require("fs").readFileSync("data/season/testnet.json","utf8")).contractId)')"
scripts/repro-build.sh contracts/queue-v2 "$CONTRACT" || { echo "verify:v2-deployed: FAIL"; exit 1; }
BUILT="$(node -e 'const c=require("crypto");console.log(c.createHash("sha256").update(require("fs").readFileSync(process.argv[1])).digest("hex"))' contracts/queue-v2/target/repro/wasm32-unknown-unknown/release/queue.wasm)"
echo "recorded      $RECORDED (data/season/testnet.json)"
[ "$BUILT" = "$RECORDED" ] || { echo "verify:v2-deployed: FAIL: the build differs from the deployment record"; exit 1; }
echo "verify:v2-deployed: contracts/queue-v2 builds to the wasm deployed at $CONTRACT"
