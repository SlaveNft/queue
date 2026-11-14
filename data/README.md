# Data directory

Files that may be committed:

- `deploy.json` — public testnet deployment metadata (no keys).
- `onchain-proof.json` — public proof of the complete testnet run: 27 proof
  transactions, Episode A (5/5 on time, four credits withdrawn) and Episode B
  (one real refused jump, 2/2 on time).
- `onchain-artifact.md` — the urgent job's artifact, whose SHA-256 was stored
  on-chain.
- `onchain-artifacts/` — the six other delivered artifacts (four displaced jobs
  and the two refusal-episode jobs), one Markdown file per job.
- `season/testnet.json` — public metadata of the v2 season contract (no keys).
- `season/testnet-season-4/` — the live season: every decision (`events.jsonl`),
  the jobs as the chain reports them (`jobs.json`), the comparison with FIFO and
  a blind fee (`comparison.json`), every request body and every signed response.
- `season/attestation-*.json` — NEAR AI's attestation report the model key was
  pinned from.

Files that must never be committed:

- `queue.db`, `queue.db-wal`, `queue.db-shm` — runtime state.
- `.env`, `.testnet/` — private keys (also git-ignored at the repo root).

`scripts/package.sh` builds the release archive and excludes all of the above.

The local console can be reset at any time with `POST /api/demo/reset` or
`npm run seed`.
