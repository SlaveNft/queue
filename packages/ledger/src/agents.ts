import type { Agent } from "@queue/core";

/**
 * The demo swarm. `accountId` mirrors the role that would sign each action on
 * NEAR; the local ledger labels the same actors so the story stays inspectable.
 */
export const AGENTS: Agent[] = [
  {
    id: "kestrel",
    name: "Kestrel",
    handle: "@kestrel.ops",
    role: "buyer",
    accountId: "kestrel.queue-demo.testnet",
    color: "#FF6A48",
    blurb: "Operations agent with a board deadline and no room to wait.",
  },
  {
    id: "mira",
    name: "Mira",
    handle: "@mira.research",
    role: "slot-holder",
    accountId: "mira.queue-demo.testnet",
    color: "#6F8BFF",
    blurb: "Research agent. Prices slack, never sells a deadline it cannot keep.",
  },
  {
    id: "atlas",
    name: "Atlas",
    handle: "@atlas.data",
    role: "slot-holder",
    accountId: "atlas.queue-demo.testnet",
    color: "#3ECF8E",
    blurb: "Data agent. Runs settlement audits and protects its promised finish.",
  },
  {
    id: "vale",
    name: "Vale",
    handle: "@vale.comms",
    role: "slot-holder",
    accountId: "vale.queue-demo.testnet",
    color: "#B98CFF",
    blurb: "Comms agent. Trades queue position when the price beats the wait.",
  },
  {
    id: "juno",
    name: "Juno",
    handle: "@juno.watch",
    role: "slot-holder",
    accountId: "juno.queue-demo.testnet",
    color: "#F0A93B",
    blurb: "Watch agent. Turns a calm deadline into a small, safe yield.",
  },
  {
    id: "operator",
    name: "Operator",
    handle: "@queue.worker",
    role: "operator",
    accountId: "worker.queue-demo.testnet",
    color: "#E8E8E8",
    blurb: "The single owned worker that executes the head of the queue.",
  },
  {
    id: "auditor",
    name: "Auditor",
    handle: "@queue.audit",
    role: "auditor",
    accountId: "auditor.queue-demo.testnet",
    color: "#A0A0A0",
    blurb: "Checks the artifact hash, the delivery time, and the payment receipt.",
  },
];

export const AGENT_BY_ID = new Map(AGENTS.map((agent) => [agent.id, agent]));

export function agentName(id: string): string {
  return AGENT_BY_ID.get(id)?.name ?? id;
}

export function agentAccount(id: string): string {
  return AGENT_BY_ID.get(id)?.accountId ?? `${id}.queue-demo.testnet`;
}

export function assertAgent(id: string): Agent {
  const agent = AGENT_BY_ID.get(id);
  if (!agent) throw new Error(`Unknown agent "${id}".`);
  return agent;
}
