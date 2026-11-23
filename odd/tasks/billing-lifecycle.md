# Billing lifecycle for hosted tenants
Objective: what happens to a paying tenant when payments fail, before any Polar code. Branch `feat/billing-lifecycle`; delivery `ask-on-risk`; runner `pnpm test` (vitest).

## Specs
- S1. "3 días de gracia, luego desconectar WhatsApp y pausar todo, y borrar los datos a los 30 días." (user, accepted proposal)
  - A failed payment moves a billed tenant to past due; nothing changes for the user for 3 days.
  - After 3 days past due the tenant is suspended: WhatsApp is logged out in WAHA, the tenant is revoked (no tool access, OAuth tokens revoked, missions stop, schedules wait).
  - After 30 days suspended, the tenant and its data are deleted (same cleanup as `delete_tenant`).
- S2. A successful payment returns a past-due tenant to normal, and a suspended (not yet deleted) tenant to usable (restored; the user logs in and re-pairs at /pair).
- S3. Tenants without billing (the admin, self-hosted installs, invited friends) are never touched.
- S4. Billing state is stored per tenant and survives restarts; a periodic worker applies the time-based steps.
- Assumption: the entry points (`paymentFailed`, `paymentSucceeded`) are called by the Polar webhook in a later feature; this feature has no user-facing trigger yet.

## Tasks
- T1 (S1-S4) billing store, application service and sweeper, tests; route inline (one behavior, no writer reason); commit: pending.
- T2 (S4) wire the sweeper in main/composition, docs and changelog; inline; commit: pending.

## Log
- L1 (2026-11-23, user): "Vale, vamos con tu sugernecia" — accepting: "¿Qué pasa cuando alguien deja de pagar? Mi propuesta: 3 días de gracia, luego desconectar WhatsApp y pausar todo, y borrar los datos a los 30 días."
- L2: Critic review found `revoke()` never logs WhatsApp out (src/application/tenantAdmin.ts:384-400) and no email is stored; order agreed: lifecycle → email/recovery → Polar webhook → panel.
- L3: Design: billing lives in its own table `tenant_billing` (the `tenants.status` CHECK constraint would need a table rebuild); suspension reuses status `revoked` so the existing gates stop missions and schedules.
