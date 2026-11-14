# On-chain proof (testnet)

QUEUE ships a real NEAR testnet contract. The interactive console runs the same
rules on a local settlement ledger so judges can replay the scenario without a
wallet or a funded account. The two are deliberately separated and labelled.

## What is real

- `contracts/queue` is a Rust `near-sdk` contract with unit tests.
- `scripts/deploy.mjs` creates testnet sub-accounts from a funded parent,
  deploys the wasm, and stores public deployment metadata in `data/deploy.json`.
- `scripts/onchain-demo.ts` runs **two episodes** and writes every transaction
  hash to `data/onchain-proof.json`:
  - **Episode A (paid jump):** submits **five jobs** (four seed jobs plus
    Kestrel's urgent job), buys priority, starts the worker, waits for the real
    duration, completes the urgent job with a real artifact hash, then runs and
    completes the four displaced jobs, and **withdraws all four credits**.
  - **Episode B (refusal):** submits Orion's tight-deadline job and Kestrel's
    60-second job, records a **real failed `request_priority`** that would have
    broken Orion's deadline, then runs both jobs in order. Both deliver on time.
- The proof file contains **27 proof transactions from seven role accounts**
  (Mira, Atlas, Vale, Juno, Kestrel, the worker, Orion). Deploy/init is a
  separate transaction signed by the contract account, so the deploy plus proof
  has **eight signers in total**.
- `GET /api/onchain` serves that public proof to the console.

## What is not real

- Local ledger rows are not blockchain transactions.
- The console does not sign testnet transactions from the browser.
- The contract is not audited and holds only testnet value.
- There is no mainnet deployment, no NEAR Intents, and no production custody.
- The deployed contract is the wasm recorded in the proof, and the source in
  this tree rebuilds to the same hash.

## Deploy

```bash
cp .env.example .env
# Set QUEUE_PARENT_ACCOUNT_ID and QUEUE_PARENT_PRIVATE_KEY for a funded testnet account.
# The parent needs roughly 5 testnet NEAR free for the contract and demo agents.
npm run build:contract
npm run deploy:testnet
```

The script writes:

- `data/deploy.json` — public: contract ID, role accounts, wasm SHA-256, deploy tx.
- `.env` — private: role keys (ignored by git, mode 600).
- `.testnet/` — private key files (ignored by git, mode 700).

Never commit `.env` or `.testnet/`. The public proof file contains no keys.

## Run the proof scenario

The queue must be empty. The proof script refuses to run otherwise. If the
queue is not empty, settle or cancel those jobs first, or deploy a fresh
contract account. Redeploying code to an existing account preserves state, so a
redeploy alone is not a state reset.

```bash
npm run demo:onchain
```

The script waits for the real worker duration (12 seconds for the urgent job,
and again for each displaced job). It then checks:

- Episode A submits **five** jobs (J-1001…J-1005) and the quote displaces
  exactly four;
- every displaced account has a positive on-chain credit;
- the urgent job's final status is `DONE`;
- `finished_at <= deadline_at` for the urgent job and for all four displaced
  jobs;
- the stored artifact hash equals the locally generated SHA-256;
- **all four** `withdraw_credit` calls clear their credits;
- Episode B records a real failed `request_priority` with the contract's own
  reason, the queue order is unchanged, Orion is not moved or credited, and
  both Episode B jobs still finish before their deadlines.

Only if every check passes does it write `ok: true`. If a check fails, the proof
is not written and the command exits non-zero. The resulting contract counters
are 7 submitted, 7 completed, 0 missed.

## Independently verify

1. Open `data/onchain-proof.json`.
2. Open the contract and transaction links on
   `https://testnet.nearblocks.io`.
3. Call the views directly:

```bash
near contract call-function as-read-only market.queue-demo.testnet get_job \
  json-args '{"job_id":<id>}' network-testnet
```

or use the RPC:

```bash
curl -s https://rpc.testnet.fastnear.com -H 'content-type: application/json' -d '{
  "jsonrpc":"2.0","id":1,"method":"query","params":{
    "request_type":"call_function","account_id":"market.queue-demo.testnet",
    "method_name":"get_job","args_base64":"<base64-json>","finality":"final"
  }}'
```

The proof file includes the arguments needed to reproduce the checks. It ties
the artifact file to its SHA-256 and the on-chain hash. `npm run verify:artifact`
goes one step further: it rebuilds the Markdown from the fixture input and
compares the result with the file, the proof, and the job record (8 checks).
Do not trust a screenshot; trust the state transition, the recomputation, and
the hash.

`npm run verify:onchain` automates this and prints **41 checks** (42 once `npm run verify:v1-deployed` has built the contract locally): the
contract account and code hash, the urgent job and its artifact, four
displacements and four payments, six displaced/refusal deliveries with their
artifact files, four withdrawals, the refusal transaction and its contract
error, all 27 proof transactions, and the deploy transaction. The exact count
depends on optional local artifacts: without a local wasm the build-comparison
line is replaced by a note, and the command prints 37 checks. Exit codes:
`0` all checks passed, `1` a mismatch, `2` the RPC was unreachable (SKIP).

## Deployed build

The live contract is the wasm whose hex SHA-256 is
`10546489ceb8c1127939023e043cf15ac13e3481b708d184e828c92b516396d6`
(259,622 bytes), base58 code hash
`26kAJzTxYTiqMJcMznpsLYetzfXcyShqAWb4hLZUbCoX`. That is the build the 37-test
suite and the proof belong to. `npm run verify:v1-deployed` rebuilds this tree
reproducibly and compares the result with the live code.

## Check the deployed code hash yourself

The one-command check is `npm run verify:v1-deployed` (see `docs/TESTING.md`, Reproducible build).
NEAR reports a contract's code hash as base58(sha256(wasm)). The commands below
compare the live hash with a local build by hand; a plain `cargo build` matches only
under the deployer's cargo home, because the wasm keeps dependency source paths:

```bash
npm run build:contract
python3 -c "import hashlib;h=hashlib.sha256(open('contracts/queue/target/wasm32-unknown-unknown/release/queue.wasm','rb').read()).digest();A='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';n=int.from_bytes(h,'big');s='';exec('while n:\n n,r=divmod(n,58);s=A[r]+s');print(s)"
curl -s https://rpc.testnet.fastnear.com -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"view_account","finality":"final","account_id":"market.queue-demo.testnet"}}' \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['result']['code_hash'])"
```

Both lines print `26kAJzTxYTiqMJcMznpsLYetzfXcyShqAWb4hLZUbCoX` for this tree
(built with `rustc 1.99.1` and the committed `Cargo.lock`; a different compiler
version can change the bytes). The storage rules are visible from outside:
`get_storage_deposits` on the live contract returns `job = 0.0125 NEAR`,
`priority_base = 0.003 NEAR`, and `priority_per_displaced = 0.003 NEAR`. Read
the view before quoting a number rather than hard-coding it.
