import { formatNear } from "@queue/core";
import { QueueEngine } from "../engine.js";

const engine = new QueueEngine({ dbPath: ":memory:" });
engine.runScenario();

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
let lastPhase = "";
for (let i = 0; i < 24; i += 1) {
  const state = engine.getState();
  if (state.scenario.phase !== lastPhase) {
    lastPhase = state.scenario.phase;
    console.log(`[${String(i).padStart(2, "0")}s] ${state.scenario.phase}`);
  }
  if (state.scenario.status === "done") break;
  await sleep(1_000);
}

const state = engine.getState();
const job = state.recent.find((item) => item.expedited);
console.log("");
console.log("QUEUE scenario complete");
console.log(`  urgent job   ${job?.id ?? "—"} · ${job?.status ?? "—"}`);
console.log(`  moved        ${state.stats.moves} agents`);
console.log(`  priority     ${formatNear(state.stats.totalPriorityYocto)}`);
console.log(`  compensation ${formatNear(state.stats.totalCompensationYocto)}`);
console.log(`  fee          ${formatNear(state.stats.totalFeesYocto)}`);
console.log(`  credits      ${Object.entries(state.credits).filter(([, value]) => value !== "0").map(([id, value]) => `${id} ${formatNear(value)}`).join(", ")}`);
if (job?.artifactId) {
  const artifact = engine.getArtifact(job.artifactId);
  console.log(`  artifact     ${artifact.sha256}`);
  console.log("");
  console.log(artifact.markdown.split("\n").slice(0, 18).join("\n"));
}
engine.close();
