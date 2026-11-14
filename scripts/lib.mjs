#!/usr/bin/env node
// Shared NEAR testnet helpers for QUEUE. Testnet only. Never prints secrets.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import os from "node:os";
import { Account, JsonRpcProvider, KeyPair, KeyPairSigner, actions } from "near-api-js";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const NETWORK = "testnet";
export const RPC = process.env.QUEUE_RPC_URL || "https://rpc.testnet.fastnear.com";
export const HELPER = process.env.NEAR_HELPER_URL || "https://helper.testnet.near.org/account";
export const TGAS = 10n ** 12n;
export const STATE = path.join(ROOT, ".testnet");

export function loadEnv(file = path.join(ROOT, ".env")) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (match && process.env[match[1]] === undefined) {
      process.env[match[1]] = match[2].replace(/^["']|["']$/g, "");
    }
  }
}

export function ensureState() {
  mkdirSync(STATE, { recursive: true, mode: 0o700 });
  chmodSync(STATE, 0o700);
  const ignore = path.join(STATE, ".gitignore");
  if (!existsSync(ignore)) writeFileSync(ignore, "# QUEUE testnet secrets — never commit\n*\n", { mode: 0o600 });
}

export function keyFile(accountId) {
  return path.join(STATE, `${accountId}.json`);
}

export function loadKey(accountId) {
  const file = keyFile(accountId);
  if (!existsSync(file)) throw new Error(`missing key for ${accountId} at ${path.relative(ROOT, file)}`);
  const data = JSON.parse(readFileSync(file, "utf8"));
  if (!data.secretKey) throw new Error(`key file for ${accountId} has no secretKey`);
  return data;
}

export function saveKey({ accountId, publicKey, secretKey, helperResponse = null }) {
  ensureState();
  const file = keyFile(accountId);
  writeFileSync(
    file,
    `${JSON.stringify(
      {
        network: NETWORK,
        accountId,
        publicKey,
        secretKey,
        createdAt: new Date().toISOString(),
        helperResponse: helperResponse ? String(helperResponse).slice(0, 300) : null,
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  chmodSync(file, 0o600);
  return file;
}

export function loadLegacyKey(accountId) {
  const file = path.join(os.homedir(), ".near-credentials", "testnet", `${accountId}.json`);
  if (!existsSync(file)) return null;
  const data = JSON.parse(readFileSync(file, "utf8"));
  if (!data.private_key) return null;
  return { accountId, publicKey: data.public_key, secretKey: data.private_key };
}

export function provider() {
  return new JsonRpcProvider({ url: RPC });
}

export function account(accountId, secretKey) {
  if (!secretKey) throw new Error(`missing key for ${accountId}`);
  return new Account(accountId, provider(), new KeyPairSigner(KeyPair.fromString(secretKey)));
}

export async function accountExists(accountId) {
  const response = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "query",
      params: { request_type: "view_account", finality: "final", account_id: accountId },
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = await response.json();
  return Boolean(body.result);
}

export async function createSubaccount(parentId, parentSecret, newAccountId, balanceNear = 0.25) {
  const parent = account(parentId, parentSecret);
  const keyPair = KeyPair.fromRandom("ed25519");
  const publicKey = keyPair.getPublicKey().toString();
  const secretKey = keyPair.toString();
  const signed = await parent.createSignedTransaction({
    receiverId: newAccountId,
    actions: [
      actions.createAccount(),
      actions.transfer(BigInt(Math.round(balanceNear * 1e6)) * 10n ** 18n),
      actions.addFullAccessKey(keyPair.getPublicKey()),
    ],
  });
  const outcome = await parent.provider.sendTransactionUntil(signed, "FINAL");
  saveKey({ accountId: newAccountId, publicKey, secretKey });
  return {
    accountId: newAccountId,
    publicKey,
    secretKey,
    tx_hash: outcome.transaction?.hash || outcome.transaction_outcome?.id || null,
  };
}

export async function createHelperAccount(prefix) {
  ensureState();
  const accountId = `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.testnet`;
  const keyPair = KeyPair.fromRandom("ed25519");
  const publicKey = keyPair.getPublicKey().toString();
  const secretKey = keyPair.toString();
  const response = await fetch(HELPER, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ newAccountId: accountId, newAccountPublicKey: publicKey }),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`helper failed for ${accountId}: HTTP ${response.status} ${text.slice(0, 200)}`);
  saveKey({ accountId, publicKey, secretKey, helperResponse: text });
  return { accountId, publicKey, secretKey };
}

export async function ensureAccount(role, prefix, envName, balanceNear = 0.25) {
  const configured = process.env[`${envName}_ACCOUNT_ID`];
  if (configured) {
    if (existsSync(keyFile(configured))) {
      const key = loadKey(configured);
      return { accountId: configured, publicKey: key.publicKey, secretKey: key.secretKey };
    }
    const legacy = loadLegacyKey(configured);
    if (legacy) return legacy;
    if (!(await accountExists(configured))) {
      const parentId = process.env.QUEUE_PARENT_ACCOUNT_ID;
      const parentKey = process.env.QUEUE_PARENT_PRIVATE_KEY;
      if (!parentId || !parentKey) {
        throw new Error(
          `${configured} does not exist and no QUEUE_PARENT_ACCOUNT_ID/QUEUE_PARENT_PRIVATE_KEY were provided.`,
        );
      }
      return createSubaccount(parentId, parentKey, configured, balanceNear);
    }
    throw new Error(`account ${configured} exists but no key is available for role ${role}`);
  }

  const parentId = process.env.QUEUE_PARENT_ACCOUNT_ID;
  const parentSecret =
    process.env.QUEUE_PARENT_PRIVATE_KEY ||
    (parentId && existsSync(keyFile(parentId)) ? loadKey(parentId).secretKey : undefined) ||
    loadLegacyKey(parentId || "")?.secretKey;
  if (parentId && parentSecret) {
    const name = `${prefix}.${parentId}`;
    if (await accountExists(name)) {
      return loadKey(name);
    }
    return createSubaccount(parentId, parentSecret, name, balanceNear);
  }
  return createHelperAccount(prefix);
}

export async function view(contractId, method, args = {}) {
  const result = await provider().query({
    request_type: "call_function",
    account_id: contractId,
    method_name: method,
    args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
    finality: "final",
  });
  return JSON.parse(Buffer.from(result.result).toString());
}

export async function call(accountObject, contractId, method, args = {}, deposit = 0n, gas = 30n) {
  const outcome = await accountObject.callFunctionRaw({
    contractId,
    methodName: method,
    args,
    gas: gas * TGAS,
    deposit,
    waitUntil: "FINAL",
  });
  const status = outcome.status;
  if (typeof status === "object" && "Failure" in status) {
    throw new Error(`${method} failed: ${JSON.stringify(status.Failure)}`);
  }
  const logs = (outcome.receipts_outcome || []).flatMap((receipt) => receipt.outcome?.logs || []);
  const events = [];
  for (const line of logs) {
    if (line.startsWith("EVENT_JSON:")) {
      try {
        events.push(JSON.parse(line.slice(11)));
      } catch {
        // Keep the raw log out of the proof; malformed events are not trusted.
      }
    }
  }
  const result =
    typeof status === "object" && "SuccessValue" in status && status.SuccessValue
      ? JSON.parse(Buffer.from(status.SuccessValue, "base64").toString())
      : null;
  return {
    tx_hash: outcome.transaction.hash,
    result,
    events,
    logs,
  };
}

/** Throws if any receipt of a finished transaction failed (near-api-js resolves anyway). */
export function assertSucceeded(outcome, what) {
  const statuses = [outcome?.status, ...(outcome?.receipts_outcome ?? []).map((r) => r.outcome?.status)];
  const failure = statuses.find((status) => status && typeof status === "object" && "Failure" in status);
  if (failure) {
    const hash = outcome.transaction?.hash || outcome.transaction_outcome?.id || "?";
    throw new Error(`${what} failed in tx ${hash}: ${JSON.stringify(failure.Failure).slice(0, 300)}`);
  }
}

export async function deploy(accountObject, contractId, wasm, initArgs) {
  const signed = await accountObject.createSignedTransaction({
    receiverId: contractId,
    actions: [
      actions.deployContract(wasm),
      actions.functionCall("new", Buffer.from(JSON.stringify(initArgs)), 300n * TGAS, 0n),
    ],
  });
  const outcome = await accountObject.provider.sendTransactionUntil(signed, "FINAL");
  assertSucceeded(outcome, `deploy to ${contractId}`);
  return {
    tx_hash: outcome.transaction?.hash || outcome.transaction_outcome?.id || null,
    outcome,
  };
}

export async function deployCodeOnly(accountObject, contractId, wasm) {
  const signed = await accountObject.createSignedTransaction({
    receiverId: contractId,
    actions: [actions.deployContract(wasm)],
  });
  const outcome = await accountObject.provider.sendTransactionUntil(signed, "FINAL");
  assertSucceeded(outcome, `deploy to ${contractId}`);
  return {
    tx_hash: outcome.transaction?.hash || outcome.transaction_outcome?.id || null,
    outcome,
  };
}

/**
 * Send a call that the contract is expected to refuse. Returns the transaction hash and the
 * contract's own error text; throws if the call unexpectedly succeeds.
 */
export async function callExpectingRefusal(accountObject, contractId, method, args = {}, deposit = 0n, gas = 30n) {
  const signed = await accountObject.createSignedTransaction({
    receiverId: contractId,
    actions: [actions.functionCall(method, Buffer.from(JSON.stringify(args)), gas * TGAS, deposit)],
  });
  let outcome;
  try {
    outcome = await accountObject.provider.sendTransactionUntil(signed, "FINAL");
  } catch (error) {
    // Some provider versions throw a typed error for a failed execution; the hash is still final.
    const hash = error?.txHash || error?.transaction_outcome?.id;
    if (!hash) throw error;
    return { tx_hash: hash, error: String(error?.message ?? error).slice(0, 400) };
  }
  const statuses = [outcome?.status, ...(outcome?.receipts_outcome ?? []).map((r) => r.outcome?.status)];
  const failure = statuses.find((status) => status && typeof status === "object" && "Failure" in status);
  if (!failure) throw new Error(`${method} was expected to be refused but succeeded`);
  const text = JSON.stringify(failure.Failure);
  const match = text.match(/Smart contract panicked: ([^"\\]+)/);
  return { tx_hash: outcome.transaction.hash, error: (match ? match[1] : text).slice(0, 400) };
}

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function writeJson(file, value) {
  const target = path.isAbsolute(file) ? file : path.join(ROOT, file);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`);
}

export function readJson(file, fallback = null) {
  try {
    const target = path.isAbsolute(file) ? file : path.join(ROOT, file);
    return JSON.parse(readFileSync(target, "utf8"));
  } catch {
    return fallback;
  }
}

export async function nearBalance(accountId) {
  const result = await provider().query({
    request_type: "view_account",
    finality: "final",
    account_id: accountId,
  });
  return BigInt(result.amount);
}
