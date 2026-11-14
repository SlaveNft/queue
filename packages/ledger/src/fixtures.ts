export interface JobSeed {
  ownerId: string;
  task: "incident-triage" | "csv-audit" | "launch-brief";
  title: string;
  brief: string;
  input: string;
  durationSec: number;
  deadlineInSec: number;
  rewardNear: string;
  bondNear: string;
  askPerSecNear: string;
}

export const INCIDENT_INPUT = `14:02:07Z checkout-api p99 latency 4,820ms (baseline 240ms)
14:02:11Z payments-webhook 5xx rate 18.4% over 5m
14:02:19Z checkout-api error "upstream reservation timeout" x 1,204
14:02:31Z risk-engine queue depth 91,000, consumer lag 22m
14:03:02Z support tickets +312 in 15m, top intent "payment taken, order missing"
14:03:18Z deploy checkout-api@2026.11.13.3 rolled to 100% at 13:47Z
14:03:29Z database primary CPU 61%, replica lag 38s
14:03:44Z feature flag reserve_split_v2 enabled for 42% of traffic
14:04:01Z on-call paged: Seva (payments), Ilya (checkout)
14:04:12Z rollback of reserve_split_v2 requested by incident commander
14:04:30Z error rate down to 11.2% after flag rollback
14:04:51Z orders stuck in RESERVED state: 8,410
14:05:03Z refund queue is healthy; write path is not
14:05:22Z partner status page still green; do not publish yet
14:05:40Z next board update due 14:20Z`;

export const SETTLEMENT_CSV = `settlement_id,chain,asset,amount_usd,status,latency_ms,retry
st-90124,near,USDC,1240.00,settled,840,0
st-90125,near,USDC,88.40,settled,910,0
st-90126,arbitrum,USDC,4200.00,failed,4210,1
st-90127,base,USDC,315.20,settled,1180,0
st-90128,ethereum,USDT,9900.00,failed,8020,2
st-90129,near,USDC,61.10,settled,760,0
st-90130,solana,USDC,512.75,settled,990,0
st-90131,arbitrum,USDC,230.00,failed,3990,1
st-90132,base,USDC,1840.50,settled,1040,0
st-90133,near,USDC,73.25,settled,700,0
st-90134,ethereum,USDT,6400.00,failed,12040,3
st-90135,near,USDC,455.00,settled,810,0
st-90136,base,USDC,129.99,failed,2880,1
st-90137,solana,USDC,760.00,settled,940,0
st-90138,near,USDC,91.80,settled,720,0`;

export const LAUNCH_INPUT = `Partner: Northline Labs
Audience: 4,200 developer teams already using Northline's settlement API
Offer: a 14-day pilot of the QUEUE priority market, capped at 0.5 NEAR per team
Proof: one owned worker, every deadline checked on-chain, displaced agents paid immediately
Why now: Northline's batch window closes on 18 November; their support queue is the bottleneck
Risk 1: teams may try to buy priority for jobs that are already late
Mitigation: the quote refuses any move that breaks a displaced deadline; the buyer sees the refusal before paying
Risk 2: finance may treat the pilot budget as prepaid revenue
Mitigation: label it a refundable test credit; return unused balance after 14 days
Success signal: at least 12 teams complete an urgent job on time with zero displaced-deadline breaches
Ask: approve the pilot page and a 30-minute onboarding session on 15 November`;

export const STANDBY_SEEDS: JobSeed[] = [
  {
    ownerId: "mira",
    task: "incident-triage",
    title: "Triage the checkout incident",
    brief:
      "Turn the on-call notes into a decision-ready incident brief with signal, likely cause, and next actions.",
    input: INCIDENT_INPUT,
    durationSec: 11,
    deadlineInSec: 150,
    rewardNear: "0.02",
    bondNear: "0.01",
    askPerSecNear: "0.00042",
  },
  {
    ownerId: "atlas",
    task: "csv-audit",
    title: "Audit the failed settlements export",
    brief:
      "Compute settlement volume, failure rate, retry load, and the three largest at-risk payments.",
    input: SETTLEMENT_CSV,
    durationSec: 9,
    deadlineInSec: 120,
    rewardNear: "0.02",
    bondNear: "0.01",
    askPerSecNear: "0.00058",
  },
  {
    ownerId: "vale",
    task: "launch-brief",
    title: "Draft the Northline pilot brief",
    brief:
      "Produce a tight partner launch brief: audience, offer, proof, risks, mitigations, and the ask.",
    input: LAUNCH_INPUT,
    durationSec: 10,
    deadlineInSec: 180,
    rewardNear: "0.02",
    bondNear: "0.01",
    askPerSecNear: "0.00036",
  },
  {
    ownerId: "juno",
    task: "incident-triage",
    title: "Summarize the latency escalation",
    brief:
      "Extract the customer-facing facts, the unresolved risks, and what the next update must contain.",
    input: INCIDENT_INPUT,
    durationSec: 12,
    deadlineInSec: 160,
    rewardNear: "0.02",
    bondNear: "0.01",
    askPerSecNear: "0.00031",
  },
];

export const URGENT_SEED: JobSeed = {
  ownerId: "kestrel",
  task: "incident-triage",
  title: "Board brief: checkout incident",
  brief:
    "A board call starts in 34 seconds. Produce the incident brief before the call, with the unresolved risk and the rollback evidence.",
  input: INCIDENT_INPUT,
  durationSec: 12,
  deadlineInSec: 34,
  rewardNear: "0.02",
  bondNear: "0.015",
  askPerSecNear: "0.0006",
};
