import { test } from "node:test";
import assert from "node:assert/strict";
import { chatWithRetry, signature, NearAiError, nearAiConfig } from "./nearai.ts";

// No network: fetch is replaced per test, so these cost nothing.
const fake = "x"; // not a key: fetch is mocked below
const cfg = { ...nearAiConfig({ NEAR_AI_API_KEY: fake }), timeoutMs: 2000 };
function fakeFetch(statuses: number[]) {
  const calls: string[] = [];
  globalThis.fetch = (async (url: string) => {
    calls.push(String(url));
    const status = statuses[Math.min(calls.length - 1, statuses.length - 1)];
    const body = status === 200 ? JSON.stringify({ id: "chat-1", choices: [{ message: { content: "{}" } }], text: "t", signature: "s", signing_address: "a" }) : "nope";
    return new Response(body, { status });
  }) as typeof fetch;
  return calls;
}

test("a 5xx is retried once, then the answer is used", async () => {
  const calls = fakeFetch([503, 200]);
  const c = await chatWithRetry(cfg, "{}", { tries: 2, budgetMs: 10_000 });
  assert.equal(c.chatId, "chat-1");
  assert.equal(calls.length, 2);
});

test("out of credit (402) is not retried and is marked fatal", async () => {
  const calls = fakeFetch([402, 200]);
  await assert.rejects(chatWithRetry(cfg, "{}", { tries: 3, budgetMs: 10_000 }), (e: unknown) => e instanceof NearAiError && e.fatal && !e.retryable);
  assert.equal(calls.length, 1);
});

test("a 400 is not retried", async () => {
  const calls = fakeFetch([400, 200]);
  await assert.rejects(chatWithRetry(cfg, "{}", { tries: 3, budgetMs: 10_000 }));
  assert.equal(calls.length, 1);
});

test("the signature call stops at a fatal status and is bounded in time", async () => {
  const calls = fakeFetch([401]);
  await assert.rejects(signature(cfg, "chat-1", "m", 5_000), (e: unknown) => e instanceof NearAiError && e.fatal);
  assert.equal(calls.length, 1);
  const lagging = fakeFetch([404, 404, 200]);
  const sig = await signature(cfg, "chat-1", "m", 10_000);
  assert.equal(sig.signature, "s");
  assert.equal(lagging.length, 3);
});
