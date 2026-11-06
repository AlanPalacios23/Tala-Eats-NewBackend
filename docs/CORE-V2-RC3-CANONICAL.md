# Tala Eats Core v2 — RC3 canonical preproduction candidate

**Date:** 2026-11-06  
**Source:** RC2 commit `d8e73b32e45d16ea4f70555d60759f7ed2cfb1a6` (GitHub PR #19)  
**Target:** New **draft** release PR against `main`.  
**Commercial status:** **NO-GO LIVE**. No connection to current Kali production.

## Integration decision G1 (source reconciliation)

The canonical source is the linear chain:
- PR #13 — M11 LAB8; ten domain source trees and real offline LAB scenarios.
- PR #16 — M11 LAB9 single-process composition, health-only gateway.
- PR #17 — v3 commercial policy: merchant **17%**, customer **7% uncapped**, tips **0%**; M11 financial check.
- PR #19 — frozen M1 line verification against `order_lines` before M3 HELD and M8 Stripe TEST reconciliation.

The RC3 branch contains **all those commits** as ancestors; it does **not** cherry-pick #13/#16/#17/#19 into a second M11. The ten owner modules remain independently pinned in `modules/integration/source-lock.json`.

### Alternate PR #14 — deliberate non-merge

PR #14, `feat/core-v2-monolito-integracion`, branched separately from `main`; it includes a **different M11**:
- `modules/integration/src/assembly.ts` loads nine separate external checkout directories.
- `modules/integration/src/manifest.ts` depends on `upstreams.json`; RC3 uses in-tree `source-lock.json` and `assembly-lab9.ts`.
- `fanout.ts` and `001_durable_event_fanout.sql` use financial events `payment.confirmed`/`refund.confirmed` and consumers finance, notifications, analytics; RC3 has a different `events.ts` + `bridge.ts` contract, durable inbox and *direct* M3 HELD/Stripe TEST LAB8 adapters.
- PR #14 has tests proving its own LAB2, but it **does not** prove a real, authoritative M8 payment event or production M3 settlement.

**Decision:** do not merge PR #14 files mechanically (duplicate schema name, conflicting event contracts, alternate source resolution and production false confidence). It remains a historical reference for a **future independently designed finance-event bridge**, not an omitted critical production feature being silently declared complete. G1 remains **partial** until source ownership and the public gateway are commercially proven. Never delete #14 without review.

## New release safety control

- `release/core-v2-rc3-gates.json` carries nine unresolved production gates and explicit commercial policy.
- `scripts/verify-core-v2-preprod.mjs` validates the manifest and **cannot** be switched to GO by changing JSON flags.
- `tests/release-gates.test.mjs` rejects accidental LIVE activation, fake approval, duplicate gates and a return to 15%/7%-capped pricing.
- `.github/workflows/core-v2-rc3-preprod-gate.yml` validates immutable module tree pins and the NO-GO release guard. This is not a deployment workflow and uses no deploy tokens.

**Do not add a workaround such as `productionReady=true` or a hidden `ENABLE_LIVE` flag.** No previous LAB CI or synthetic webhook constitutes payment authorization.

## Critical work remaining (tracked in issue #20)

| Gate | Exit criterion | RC3 status |
| --- | --- | --- |
| G1 | One canonical owner tree + gateway + resolved schema and PR #14 differences | Partial |
| G2 | M1/M3/M8/M10 pricing/refunds/cancel/discount/taxes/wallet/receipts including historical policies | Partial |
| G3 | M4/M9 real issuer, role and ownership checks for every mutation, no dual auth and no ID trust from clients | Blocked |
| G4 | Owner M1/M6 checkout and durable stock hold/timeout/compensation/replay after crash | Blocked |
| G5 | Remote Stripe TEST events, signed webhook, late payments, refunds, PSP reconciliation, no duplicate charges | Blocked |
| G6 | Real three-app order route, courier GPS/dispatch/PIN, cash custody and payout reconciliation | Blocked |
| G7 | Transactional producer outboxes + working consumers M3/M5/M10, monitoring and safe DLQ redrive | Blocked |
| G8 | Isolated staging, versioned SQL, privilege isolation, restore/rollback, E2E four apps, load/security | Blocked |
| G9 | All-CI pinned SHA, immutable release artifact, green /ready only after dependency checks, canary and owner GO | Blocked |

### Minimum release demonstration

1. Customer quote 17/7 → confirmed payment or cash order; server proves quote and persisted order match.
2. Restaurant accepts, prepares, marks ready; stock reservation applied exactly once.
3. Approved courier receives offer, arrives, collects, GPS and buyer PIN validate delivery.
4. Signed payment provider fact or double-ack cash custody; M3 records HELD first, then reconciles wallet; refunds and cancellations reverse correctly.
5. Test disconnects/crashes at every boundary; replays and DLQ cannot duplicate charges, deliverables, journal or transfers.
6. Four app clients (Usuarios, Restaurantes, Repartidores and ADMIN) integrate with the *same* staging backend; migrations, restore and rollback pass.
7. Financial test cases include large carts, 17/7 uncapped, 0%-tip commission, discounts/taxes, historical pricing and full/partial refunds.

### Rollout rule

The current Kali LIVE backend stays untouched. First pass G1–G9 in disposable staging, then complete a **read-only Kali inventory**, verified backup/restore and deployment rehearsal. Only after an explicit fresh human GO and tested rollback should the release be promoted. Do **not** reuse RC3's intentionally non-activatable LAB guard as a production deployment mechanism.

Evidence: [PR #19](https://github.com/AlanPalacios23/Tala-Eats-NewBackend/pull/19), [Issue #20](https://github.com/AlanPalacios23/Tala-Eats-NewBackend/issues/20), [PR #14](https://github.com/AlanPalacios23/Tala-Eats-NewBackend/pull/14).

## RC3 LAB customer cancellation — M4 + M9 + M1 (new)

`modules/integration/adapters/customer-cancel-lab.ts` now implements an **internal, non-HTTP cash-order cancellation** using real owner services:
1. Authenticate the live session in **M4**, validate current customer role (not a client-supplied actor ID).
2. Verify the durable, non-revoked M4→M1 link, read the **M1 order timeline** to prove current ownership, and obtain the canonical M1 customer ID from the link.
3. Issue an ephemeral, scoped host grant and obtain an audited **M9** `orders.cancel` authorization.
4. Recheck ownership and delegate to **M1 `cancelCashOrder`** with its SQL buyer check, version lock, idempotency key, stock restoration, event, outbox, and one atomic transaction.
5. Return a minimal status. No Stripe refund, wallet transfer, or public API is exposed; all databases are disposable LAB names and `NODE_ENV=production` rejects the adapter.

Regression coverage was added to `real-m4-m1-order-ownership-db.test.ts`: genuine account sessions and link, order cancellation, recovered stock, idempotent replay, unrelated customer rejection, and revocation denial.

**Evidence boundary:** A working internal LAB cancellation is progress on G3/G4, **not** a complete commercial gateway. The dual-session enrollment procedure is still transitional, cross-DB revocation is not atomic with an M1 write, and Stripe-paid orders require real refund/compensation contracts. No LIVE readiness is implied.
