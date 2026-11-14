#!/usr/bin/env node
// Reset the local console to the standby scenario. Requires the API to be up.
const port = process.env.QUEUE_PORT || "8789";
const base = process.env.QUEUE_API || `http://localhost:${port}`;
const response = await fetch(`${base}/api/demo/reset`, { method: "POST" });
const body = await response.json();
if (!response.ok) {
  console.error(body.error || `HTTP ${response.status}`);
  process.exit(1);
}
console.log(`QUEUE reset: ${body.state.queue.length} jobs queued, credits cleared.`);
