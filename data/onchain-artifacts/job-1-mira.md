# Triage the checkout incident

**Decision brief for the next board update.** Prepared by the QUEUE operator from the on-call log. No external model; the numbers below are extracted from the supplied evidence.

## What happened

9 signal lines describe a live checkout incident with a 18.4% 5xx rate. **8,410 orders are stuck in a reserved state.** The failing write path is the priority, not refunds.

## Most likely trigger

- 14:03:18Z deploy checkout-api@2026.11.13.3 rolled to 100% at 13:47Z
- 14:03:44Z feature flag reserve_split_v2 enabled for 42% of traffic
- 14:04:12Z rollback of reserve_split_v2 requested by incident commander

## Customer impact

- 14:02:11Z payments-webhook 5xx rate 18.4% over 5m
- 14:03:02Z support tickets +312 in 15m, top intent "payment taken, order missing"
- 14:04:01Z on-call paged: Seva (payments), Ilya (checkout)
- 14:04:51Z orders stuck in RESERVED state: 8,410

## What is still unresolved

- 14:02:31Z risk-engine queue depth 91,000, consumer lag 22m
- 14:03:29Z database primary CPU 61%, replica lag 38s
- 14:03:44Z feature flag reserve_split_v2 enabled for 42% of traffic
- 14:04:30Z error rate down to 11.2% after flag rollback
- 14:05:22Z partner status page still green; do not publish yet

## Next 10 minutes

1. Keep the feature flag rolled back; confirm the error rate is still falling.
2. Reconcile the stuck reservations against the payment ledger before retrying writes.
3. Publish the next update only after the partner status-page decision is made.
4. The next update is due **14:20Z**.

## Evidence

> 14:02:11Z payments-webhook 5xx rate 18.4% over 5m
> 14:04:01Z on-call paged: Seva (payments), Ilya (checkout)
> 14:04:12Z rollback of reserve_split_v2 requested by incident commander
> 14:04:30Z error rate down to 11.2% after flag rollback
> 14:04:51Z orders stuck in RESERVED state: 8,410
> 14:05:40Z next board update due 14:20Z

---

**Checks:** 15 log lines parsed · 9 signals · 6 open risks. This is a deterministic extraction, not an independent incident diagnosis.