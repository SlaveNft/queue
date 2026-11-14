/** Demo limits shared by the HTTP API and the in-browser ledger. */
export const LIMITS = {
  titleMin: 3,
  titleMax: 90,
  briefMin: 3,
  briefMax: 600,
  inputMax: 20_000,
  durationMinSec: 1,
  durationMaxSec: 120,
  deadlineMinSec: 5,
  deadlineMaxSec: 3_600,
  rewardMinYocto: 1_000_000_000_000_000_000_000n, // 0.001 NEAR
  rewardMaxYocto: 1_000_000_000_000_000_000_000_000n, // 1 NEAR
  bondMinYocto: 1_000_000_000_000_000_000_000n, // 0.001 NEAR
  bondMaxYocto: 1_000_000_000_000_000_000_000_000n, // 1 NEAR
  askMaxYoctoPerSec: 10_000_000_000_000_000_000_000n, // 0.01 NEAR/s
  maxSpendYocto: 2_000_000_000_000_000_000_000_000n, // 2 NEAR
  activityLimit: 120,
  recentLimit: 8,
  queueLimit: 64,
} as const;
