import { useEffect, useMemo, useState } from "react";
import {
  Check,
  CircleAlert,
  Copy,
  ExternalLink,
  FileCode2,
  Loader2,
  RefreshCw,
  ShieldCheck,
  X,
} from "lucide-react";
import type { QueueState } from "@queue/core";
import { shortHash } from "@queue/core";
import { api, apiErrorMessage } from "../lib/api";
import {
  deliveredCount,
  formatGeneratedAt,
  groupProofTxs,
  normalizeProof,
} from "../lib/proof";
import { BROWSER_BACKEND } from "../lib/backend";

interface ProofProps {
  state: QueueState | null;
}

/** Where this build reads the v1 proof record from. */
const PROOF_SOURCE = BROWSER_BACKEND ? "data/onchain-proof.json" : "/api/onchain";
const DEPLOY_COMMAND = "npm run deploy:testnet";
const CHECK_COMMAND = "npm run verify:onchain";
const BUILD_COMMAND = "npm run build:contract";
const TEST_COMMAND = "cd contracts/queue && cargo test";

export function Proof({ state }: ProofProps) {
  const [proof, setProof] = useState<Record<string, unknown> | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const [retryKey, setRetryKey] = useState(0);
  const [copied, setCopied] = useState<string | null>(null);
  const [copyError, setCopyError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    setError(null);
    void (async () => {
      try {
        const next = await api.getOnchain();
        if (cancelled) return;
        setProof(next);
        setStatus("ready");
      } catch (caught) {
        if (cancelled) return;
        setProof(null);
        setError(apiErrorMessage(caught));
        setStatus("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [retryKey]);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(null), 2_000);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const view = useMemo(() => normalizeProof(proof), [proof]);
  const unavailable = status === "error";
  /** Only an explicit deployed:false in a successful response means "not deployed". */
  const notDeployed = status === "ready" && proof !== null && proof.deployed === false;
  const endpointNote =
    typeof proof?.note === "string" && proof.note.trim() ? proof.note.trim() : null;
  const sessionMode = state?.network.mode ?? null;
  const localSession = sessionMode === "local";
  const generatedAt = formatGeneratedAt(view?.generatedAt);
  const txGroups = useMemo(() => groupProofTxs(view?.txs ?? []), [view?.txs]);
  const delivered = useMemo(() => deliveredCount(view?.txs ?? []), [view?.txs]);
  const refusalUrl =
    view?.refusal?.tx && view.explorer
      ? `${view.explorer}/txns/${encodeURIComponent(view.refusal.tx)}`
      : null;

  const copy = async (value: string, key: string) => {
    setCopyError(null);
    try {
      await navigator.clipboard.writeText(value);
      setCopied(key);
    } catch {
      setCopyError("Clipboard access failed. Select the value to copy it manually.");
    }
  };

  const contractUrl =
    view?.contractId && view.explorer
      ? `${view.explorer}/address/${encodeURIComponent(view.contractId)}`
      : null;

  return (
    <section className="proof-section" id="proof" aria-labelledby="proof-heading">
      <div className="container">
        <header className="section-heading proof-heading">
          <div>
            <p className="section-kicker">
              <span>05</span> Proof
            </p>
            <h2 id="proof-heading">
              Trust is a <em>receipt.</em>
            </h2>
          </div>
          <p className="section-lede">
            Every number here comes from the ledger or the on-chain proof
            endpoint. If the endpoint is offline this page says unknown; a
            successful response with no deployment says so, with the exact
            command to change that.
          </p>
        </header>

        <div className="proof-grid">
          <div className="proof-editorial">
            <span className="proof-status-line" data-deployed={Boolean(view?.contractId)}>
              <span className="status-dot" aria-hidden="true" />
              {status === "loading"
                ? `Checking ${PROOF_SOURCE}`
                : status === "error"
                  ? "Proof endpoint unavailable"
                  : view?.contractId
                    ? "Deployment record found"
                    : notDeployed
                      ? "No deployment record"
                      : "Proof record incomplete"}
            </span>

            <h3>
              {view?.contractId ? (
                <>
                  The contract is <span className="serif-accent">live</span> on
                  testnet.
                </>
              ) : unavailable ? (
                <>
                  Proof is <span className="serif-accent">unknown.</span>
                </>
              ) : (
                <>
                  No invented hashes.
                  <br />
                  <span className="serif-accent">Proof pending.</span>
                </>
              )}
            </h3>

            <p>
              {view?.contractId
                ? "The contract account, wasm hash and transactions below were returned by the proof endpoint. Links resolve to nearblocks; nothing on this page is typed in by hand."
                : unavailable
                  ? "The proof endpoint did not answer, so this page cannot confirm or deny a deployment. The contract may still be live; read data/onchain-proof.json or run the check command below before drawing a conclusion."
                  : notDeployed
                    ? "This build can run the full scenario against the local settlement ledger without a deployed contract. That is a rehearsal, not an on-chain claim. When a real testnet deployment exists, its contract ID and transaction links appear here."
                    : "The proof endpoint answered, but it returned no deployment record. That is not evidence that the contract is absent; check data/onchain-proof.json and run the check command below."}
            </p>

            <ul className="proof-nevers">
              <li>
                <Check size={13} aria-hidden="true" />
                No simulated transaction hashes.
              </li>
              <li>
                <Check size={13} aria-hidden="true" />
                Local ledger entries are labelled local, everywhere.
              </li>
              <li>
                <Check size={13} aria-hidden="true" />
                A refused purchase stays refused in the story we tell.
              </li>
            </ul>

            <div className="proof-command-block">
              <span className="mini-label">
                {view?.contractId
                  ? "Check it yourself, no keys needed"
                  : unavailable
                    ? "Check the proof file and chain"
                    : "Deploy your own testnet proof"}
              </span>
              <div className="command-row">
                <code>
                  {view?.contractId || unavailable ? CHECK_COMMAND : DEPLOY_COMMAND}
                </code>
                <button
                  type="button"
                  className="copy-button"
                  onClick={() =>
                    void copy(
                      view?.contractId || unavailable ? CHECK_COMMAND : DEPLOY_COMMAND,
                      "deploy",
                    )
                  }
                  aria-label="Copy command"
                >
                  {copied === "deploy" ? (
                    <Check size={14} aria-hidden="true" />
                  ) : (
                    <Copy size={14} aria-hidden="true" />
                  )}
                  {copied === "deploy" ? "Copied" : "Copy"}
                </button>
              </div>
              {view?.contractId ? (
                <p>
                  Read-only. It compares every claim on this page with the live chain: the
                  code hash, each payment, each on-time delivery and the refused jump. To
                  build your own copy: <code>{BUILD_COMMAND}</code>, then <code>{DEPLOY_COMMAND}</code>.
                </p>
              ) : unavailable ? (
                <p>
                  The endpoint is offline; this command re-checks the same proof against
                  the chain without trusting the page. Build the wasm with{" "}
                  <code>{BUILD_COMMAND}</code> if you want to deploy your own copy.
                </p>
              ) : (
                <p>
                  Build the wasm with <code>{BUILD_COMMAND}</code>, then run the
                  deploy script. Testnet only. Never mainnet.
                </p>
              )}
            </div>

            <p className="proof-session-note">
              {sessionMode === null
                ? "This session has not received a network snapshot. The proof card is read directly from the proof record; no session mode is inferred."
                : localSession
                  ? "This session is in local settlement mode. That is why credits and ledger amounts are not presented as chain transactions."
                  : "This session reports testnet mode. The proof endpoint is the only source for contract and transaction identifiers."}
            </p>
          </div>

          <aside className="proof-card" aria-label="Deployment proof">
            <header className="proof-card-head">
              <div>
                <span className="panel-kicker">{PROOF_SOURCE}</span>
                <h3>
                  {view?.contractId ? "Deployment" : unavailable ? "Unknown" : "Pending"}
                </h3>
              </div>
              <span
                className="settlement-badge"
                data-local={notDeployed}
                data-unavailable={unavailable || undefined}
              >
                {unavailable ? (
                  <CircleAlert size={13} aria-hidden="true" />
                ) : (
                  <ShieldCheck size={13} aria-hidden="true" />
                )}
                {unavailable
                  ? "Proof unavailable"
                  : view?.contractId
                    ? view.network ?? "testnet"
                    : notDeployed
                      ? "Not deployed"
                      : "Proof pending"}
              </span>
            </header>

            {status === "loading" ? (
              <div className="proof-loading" aria-live="polite">
                <Loader2 className="spin" size={17} aria-hidden="true" />
                Reading proof record…
              </div>
            ) : (
              <>
                {error ? (
                  <div className="proof-endpoint-note" role="alert">
                    <CircleAlert size={14} aria-hidden="true" />
                    <div>
                      <strong>Proof endpoint unavailable.</strong>
                      <p>{error} Commands below are local and unchanged.</p>
                    </div>
                    <button
                      type="button"
                      className="text-button"
                      onClick={() => setRetryKey((value) => value + 1)}
                    >
                      <RefreshCw size={12} aria-hidden="true" />
                      Retry
                    </button>
                  </div>
                ) : null}

                <dl className="proof-rows">
                  <div>
                    <dt>Contract</dt>
                    <dd>
                      {view?.contractId ? (
                        <>
                          <span className="mono proof-contract" title={view.contractId}>
                            {view.contractId}
                          </span>
                          <span className="proof-row-actions">
                            <button
                              type="button"
                              className="icon-button"
                              onClick={() => void copy(view.contractId ?? "", "contract")}
                              aria-label="Copy contract ID"
                            >
                              {copied === "contract" ? (
                                <Check size={13} aria-hidden="true" />
                              ) : (
                                <Copy size={13} aria-hidden="true" />
                              )}
                            </button>
                            {contractUrl ? (
                              <a
                                className="icon-button"
                                href={contractUrl}
                                target="_blank"
                                rel="noreferrer"
                                aria-label="View contract on nearblocks"
                              >
                                <ExternalLink size={13} aria-hidden="true" />
                              </a>
                            ) : null}
                          </span>
                        </>
                      ) : unavailable ? (
                        <span className="proof-pending">Unknown — endpoint offline</span>
                      ) : notDeployed ? (
                        <span className="proof-pending">No contract yet</span>
                      ) : (
                        <span className="proof-pending">No contract record returned</span>
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt>Network</dt>
                    <dd>{unavailable ? "Unknown" : view?.network ?? "testnet (expected)"}</dd>
                  </div>
                  <div>
                    <dt>Wasm hash</dt>
                    <dd>
                      {view?.wasmHash ? (
                        <>
                          <span className="mono" title={view.wasmHash}>
                            {shortHash(view.wasmHash, 10, 8)}
                          </span>
                          <button
                            type="button"
                            className="icon-button"
                            onClick={() => void copy(view.wasmHash ?? "", "wasm")}
                            aria-label="Copy wasm hash"
                          >
                            {copied === "wasm" ? (
                              <Check size={13} aria-hidden="true" />
                            ) : (
                              <Copy size={13} aria-hidden="true" />
                            )}
                          </button>
                        </>
                      ) : (
                        <span className="proof-pending">
                          {unavailable ? "Unknown" : "Not returned"}
                        </span>
                      )}
                    </dd>
                  </div>
                  {generatedAt ? (
                    <div>
                      <dt>Generated</dt>
                      <dd>{generatedAt}</dd>
                    </div>
                  ) : null}
                </dl>

                {!view && endpointNote ? (
                  <p className="proof-note">{endpointNote}</p>
                ) : null}

                <div className="proof-txs">
                  <span className="mini-label">
                    Transactions {view ? <span>{view.txs.length} total</span> : null}
                  </span>

                  {unavailable ? (
                    <p className="proof-tx-empty">
                      The proof endpoint did not answer, so no transaction list is
                      shown. Nothing is inferred or fabricated.
                    </p>
                  ) : null}

                  {view?.refusal ? (
                    <div className="proof-refusal" role="note">
                      <div className="refusal-head">
                        <X size={15} aria-hidden="true" />
                        <strong>The contract refused a jump.</strong>
                      </div>
                      <p>
                        {view.refusal.tightJob?.owner ?? "A tight job"}
                        {view.refusal.tightJob?.id
                          ? ` (job ${view.refusal.tightJob.id}, ${view.refusal.tightJob.durationSecs ?? "?"}s)`
                          : ""}{" "}
                        would have finished after its deadline
                        {view.refusal.jumpingJob?.owner
                          ? ` if ${view.refusal.jumpingJob.owner}'s job ${view.refusal.jumpingJob.id ?? ""} had moved ahead of it`
                          : ""}
                        . Nothing moved and nobody was paid.
                      </p>
                      {view.refusal.contractError ? (
                        <code className="refusal-error">{view.refusal.contractError}</code>
                      ) : view.refusal.quoteReason ? (
                        <code className="refusal-error">{view.refusal.quoteReason}</code>
                      ) : null}
                      {refusalUrl ? (
                        <a href={refusalUrl} target="_blank" rel="noreferrer">
                          View the failed transaction
                          <ExternalLink size={11} aria-hidden="true" />
                        </a>
                      ) : null}
                    </div>
                  ) : null}

                  {view && view.txs.length > 0 ? (
                    <>
                      <p className="proof-tx-summary">
                        <strong>{delivered} jobs delivered on time</strong> on chain, 0 missed
                        {view.refusal
                          ? ", and one jump refused by the contract because it would have broken a deadline."
                          : "."}
                      </p>
                      {txGroups.map((group) => (
                        <details
                          key={group.key}
                          className="proof-tx-group"
                          open={group.key === "priority" || group.key === "refused"}
                        >
                          <summary>
                            <span>{group.label}</span>
                            <span className="proof-tx-count">{group.txs.length}</span>
                          </summary>
                          <ul>
                            {group.txs.map((tx) => (
                              <li
                                key={tx.hash}
                                className={
                                  /refused/i.test(tx.label ?? "") ? "is-refused" : undefined
                                }
                              >
                                <span className="tx-label">{tx.label ?? "transaction"}</span>
                                <a
                                  href={`${view.explorer}/txns/${encodeURIComponent(tx.hash)}`}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="mono"
                                  title={tx.hash}
                                  aria-label={`View ${tx.label ?? "transaction"} ${tx.hash} on nearblocks`}
                                >
                                  {shortHash(tx.hash, 10, 8)}
                                  <ExternalLink size={11} aria-hidden="true" />
                                </a>
                              </li>
                            ))}
                          </ul>
                        </details>
                      ))}
                    </>
                  ) : !unavailable ? (
                    <p className="proof-tx-empty">
                      No transaction hashes returned. None will be fabricated to
                      fill this list.
                    </p>
                  ) : null}
                </div>

                <div className="proof-tests">
                  <div className="proof-tests-head">
                    <FileCode2 size={15} aria-hidden="true" />
                    <span className="mini-label">Contract tests</span>
                  </div>
                  <div className="command-row">
                    <code>{TEST_COMMAND}</code>
                    <button
                      type="button"
                      className="copy-button"
                      onClick={() => void copy(TEST_COMMAND, "test")}
                      aria-label="Copy contract test command"
                    >
                      {copied === "test" ? (
                        <Check size={14} aria-hidden="true" />
                      ) : (
                        <Copy size={14} aria-hidden="true" />
                      )}
                      {copied === "test" ? "Copied" : "Copy"}
                    </button>
                  </div>
                  <p>
                    Unit tests prove FIFO, exact compensation, deadline rejection,
                    cancellation and access control. Run them locally; this page
                    does not claim a result it cannot observe.
                  </p>
                </div>

                {view?.note ? <p className="proof-note">{view.note}</p> : null}
              </>
            )}

            {copyError ? (
              <p className="form-error" role="alert">
                {copyError}
              </p>
            ) : null}
          </aside>
        </div>
      </div>
    </section>
  );
}
