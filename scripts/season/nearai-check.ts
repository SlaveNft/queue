/**
 * Step A1: one live NEAR AI request, its TEE signature, and the attestation report.
 * Answers the only open question of the plan: does the signed text match what the contract checks?
 *
 *   npx tsx scripts/season/nearai-check.ts
 *
 * Writes data/season/nearai-check.json (no secrets: request, response, signature, signer, verdict).
 */
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { ROOT, loadEnv } from "../lib.mjs";
import { nearAiConfig, chat, signature, attestedArgs, attestedSigners, requestBody, sha256hex } from "./nearai.ts";

loadEnv();
const ai = nearAiConfig();
if (!ai.apiKey) {
  console.error("NEAR_AI_API_KEY is not set. Put it in queue/.env (never in chat).");
  process.exit(2);
}
const body = requestBody(ai.model, "You are the QUEUE worker.", `QUEUE A1 check ${new Date().toISOString()}: reply with the word ok.`, { temperature: 0, maxTokens: 20 });
const c = await chat(ai, body);
console.log(`chat ${c.chatId}: ${c.latencyMs} ms, answer ${JSON.stringify(c.content.slice(0, 60))}`);
const sig = await signature(ai, c.chatId);
console.log(`signed text form: ${sig.text.startsWith(ai.model + ":") ? "provider {model}:{req}:{res}" : "other"}; signer ${sig.signing_address.slice(0, 18)}…`);
let report: { signers: string[] } = { signers: [] };
try {
  report = await attestedSigners(ai);
  console.log(`attestation report: ${report.signers.length} signing key(s)`);
} catch (e) {
  console.log(`attestation report unavailable: ${(e as Error).message}`);
}
const verdict = attestedArgs(c, sig, ai.model, report.signers.length ? report.signers : undefined);
console.log(verdict.ok ? `PASS: the contract's check would accept this answer (model arg = ${verdict.model === null ? "null (gateway form)" : "set"})` : `FAIL: ${verdict.problems.join("; ")}`);
mkdirSync(path.join(ROOT, "data/season"), { recursive: true });
writeFileSync(
  path.join(ROOT, "data/season/nearai-check.json"),
  JSON.stringify({ at: new Date().toISOString(), model: ai.model, chatId: c.chatId, requestSha256: sha256hex(body), responseSha256: sha256hex(c.responseBody), request: body, response: c.responseBody, signature: sig, reportSigners: report.signers, verdict }, null, 2),
);
process.exit(verdict.ok ? 0 : 1);
