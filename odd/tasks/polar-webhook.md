# Polar webhook: payments drive accounts

Objective: a Polar subscription creates the customer's account and invite, and its payment state drives the billing lifecycle. Branch `feat/polar-webhook` (chained on `feat/email-recovery`); delivery `ask-on-risk`; runner `pnpm test` (vitest).

## Specs

- S1. "Polar checkout → account created automatically (invite) → user logs into panel → scans QR" (agreed plan). A new subscription (`trialing` or `active`) for an unknown customer creates a tenant, issues its invite and emails the invite link to the customer's email.
- S2. Webhooks are verified (Standard Webhooks: `webhook-id`, `webhook-timestamp`, `webhook-signature`, HMAC-SHA256, 5-minute tolerance) and deduplicated by `webhook-id`; invalid signatures get 403 and change nothing. Valid ones get 202 at once and are processed in the background.
- S3. Events are not trusted for order: for every `subscription.*` event the server fetches the subscription's current state from the Polar API and acts on it. `trialing`/`active` → `paymentSucceeded`; `past_due` → `paymentFailed` (3-day grace); `canceled`, `unpaid`, `incomplete_expired`, `trial_ended` → access ends now (suspend; deletion 30 days later).
- S4. Config is all-or-nothing: `POLAR_WEBHOOK_SECRET`, `POLAR_ACCESS_TOKEN`; optional `POLAR_API_URL` (default `https://api.polar.sh`, sandbox `https://sandbox-api.polar.sh`). Polar needs email configured (the invite goes by email) and is a startup error with `MULTI_TENANT=false`; with Polar on, invites are on.
- S5. At most 20 new accounts per hour from webhooks. Over the cap the event is not accepted (HTTP 429), so Polar redelivers it later; existing customers are never capped.
- Assumption: the webhook payload envelope is `{ type, timestamp, data }` with `data.id` the subscription id for `subscription.*` events.

## Tasks

- T1 (S2, S4) signature verifier, config group; inline; pending.
- T2 (S3) Polar API client and subscription sync service (status → billing action), mapping store; inline; pending.
- T3 (S1, S5) provisioning (tenant + invite + email) with hourly cap; inline; pending.
- T4 (S2) `/webhooks/polar` route, dedupe, background queue, wiring, docs; inline; pending.

## Log

- L1 (2026-11-23, user): "osae estar aqui haciendo todo y cuando todo lo de factuacion y nube este ok, pues mandaleo a produccion". Agreed order: lifecycle → email → Polar webhook → panel.
- L2: Polar docs: Standard Webhooks for secrets created after 2026-09-08 (pass `whsec_…` as-is); 10 attempts, 10 s timeout; `subscription.past_due` = payment failed, `subscription.revoked` = access ends; `GET /v1/subscriptions/{id}` with an organization access token (`subscriptions:read`). Ordering not documented → reconcile by fetching.
