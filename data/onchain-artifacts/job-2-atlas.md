# Audit the failed settlements export

**Settlement audit.** 15 rows parsed from the supplied export. All totals are computed from the file, not estimated.

## Headline

- Settled volume: **$26,297.99**
- Failed volume: **$20,859.99** across **5** payments (33.3% by count)
- Retry load: **8** retries
- Average latency: **2669 ms** overall, **6228 ms** on failed payments

## By chain

| Chain | Payments | Failed | Volume | Avg latency |
|---|---:|---:|---:|---:|
| near | 6 | 0 | $2,009.55 | 790 ms |
| arbitrum | 2 | 2 | $4,430.00 | 4100 ms |
| base | 3 | 1 | $2,285.69 | 1700 ms |
| ethereum | 2 | 2 | $16,300.00 | 10030 ms |
| solana | 2 | 0 | $1,272.75 | 965 ms |

## Largest failed payments

- **st-90128** — $9,900.00 on ethereum · 2 retries · 8020 ms
- **st-90134** — $6,400.00 on ethereum · 3 retries · 12040 ms
- **st-90126** — $4,200.00 on arbitrum · 1 retries · 4210 ms

## What to do next

1. Retry the three largest failures only after checking the destination chain's finality.
2. Treat the failed-payment latency tail as the primary operational signal.
3. Re-run this audit on the next export and compare failed volume, not just failure count.

---

**Checks:** 15 data rows · 7 columns · 5 failures. Deterministic CSV arithmetic.