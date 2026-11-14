import { useEffect, useState } from "react";
import { api } from "./api";

/** The scripted run of the demo scenario on NEAR testnet: the console's on-chain twin. */
export interface OnchainTwin {
  contractId: string;
  contractUrl: string;
  priorityTxUrl: string | null;
  withdrawTxUrl: string | null;
  /** The failed transaction in which the contract refused a deadline-breaking jump. */
  refusalTxUrl: string | null;
  /** Jobs the proof delivered on chain before their deadlines. */
  deliveredOnTime: number;
  /** Total the on-chain buyer paid for priority, in yocto. */
  prioritySpendYocto: string | null;
}

const TX = /^[1-9A-HJ-NP-Za-km-z]{32,60}$/;
let cached: Promise<OnchainTwin | null> | null = null;

function explorerOrigin(raw: unknown): string {
  try {
    if (typeof raw === "string" && /^https:\/\//.test(raw)) return new URL(raw).origin;
  } catch {
    /* fall through */
  }
  return "https://testnet.nearblocks.io";
}

async function load(): Promise<OnchainTwin | null> {
  const proof = await api.getOnchain().catch(() => null);
  if (!proof || proof.deployed === false) return null;
  const contractId = typeof proof.contractId === "string" ? proof.contractId : "";
  if (!/^[a-z0-9._-]{2,64}$/.test(contractId)) return null;
  const base = explorerOrigin(proof.explorer);
  const txs = Array.isArray(proof.transactions) ? proof.transactions : [];
  const find = (label: RegExp): string | null => {
    for (const entry of txs) {
      if (typeof entry !== "object" || entry === null) continue;
      const { hash, label: name } = entry as { hash?: unknown; label?: unknown };
      if (typeof hash === "string" && TX.test(hash) && typeof name === "string" && label.test(name)) {
        return `${base}/txns/${hash}`;
      }
    }
    return null;
  };
  return {
    contractId,
    contractUrl: `${base}/address/${contractId}`,
    priorityTxUrl: find(/priority/i),
    withdrawTxUrl: find(/withdraw/i),
    refusalTxUrl: find(/refused/i),
    deliveredOnTime: txs.filter(
      (entry) => typeof entry === "object" && entry !== null && /^deliver/i.test(String((entry as { label?: unknown }).label ?? "")),
    ).length,
    prioritySpendYocto: typeof proof.onchainPrioritySpend === "string" ? proof.onchainPrioritySpend : null,
  };
}

/** Fetched once per page load; the proof file only changes on a redeploy. */
export function useOnchainTwin(): OnchainTwin | null {
  const [twin, setTwin] = useState<OnchainTwin | null>(null);
  useEffect(() => {
    let live = true;
    cached ??= load();
    void cached.then((value) => {
      if (live) setTwin(value);
    });
    return () => {
      live = false;
    };
  }, []);
  return twin;
}
