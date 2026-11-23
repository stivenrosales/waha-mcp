# Email and self-service password recovery

Objective: every account can have an email, and a user who forgets the password gets a reset link by email (Cloudflare Email Service). Branch `feat/email-recovery` (chained on `feat/billing-lifecycle`); delivery `ask-on-risk`; runner `pnpm test` (vitest).

## Specs

- S1. "sigue con lo del email y eso, supongo que con Cloudflare" (user). Email goes through an `EmailSender` port with a Cloudflare Email Service REST adapter (`POST https://api.cloudflare.com/client/v4/accounts/{account_id}/email/sending/send`, Bearer token), so the provider can change.
- S2. Config is all-or-nothing: `EMAIL_FROM`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_EMAIL_API_TOKEN`. Without them email is off and nothing about recovery is shown.
- S3. Users have an optional email, unique case-insensitively. The invite form asks for it; the owner's comes from `ADMIN_EMAIL`.
- S4. With email on, the login pages link to `/forgot`. `/forgot` takes an email and always answers the same message (no account enumeration); when an account has that email it sends a reset link valid 1 hour, using the existing `/reset/:token` page. Rate-limited per IP and per email.
- Assumption: emails and pages are in Spanish, like the existing pages.

## Tasks

- T1 (S1, S2) EmailSender port, Cloudflare adapter, config group; inline; done d6265ef.
- T2 (S3) email column, invite field, ADMIN_EMAIL; inline; done bf657ec.
- T3 (S4) /forgot route, links on login pages, docs; inline; done (this commit).

## Log

- L1 (2026-11-23, user): "Configura todo ok, par aencerder todo con un boton, y suufue con lo del email y eso, supigno que con Cloudfare no?" then "osae estar aqui haciendo todo y cuando todo lo de factuacion y nube este ok, pues mandaleo a produccion".
- L2: Cloudflare Email Service is public beta, Workers Paid, 3,000 emails/month included then US$0.35/1,000; `from` domain must be onboarded in the dashboard (DNS on `cf-bounce`).
- L3: Pre-existing flaky test `oauth.test.ts > limiter hardening > 51st failure…` hits its 5 s timeout under full-suite load (passes alone 3/3); not touched by this feature.
- L4: All tasks done; full suite 1316 passed; lint clean on feature files.
