# Account panel

Objective: a minimal, usable web panel per account at `/panel`. Branch `feat/panel` (chained on `feat/polar-webhook`); delivery `ask-on-risk`; runner `pnpm test` (vitest).

## Specs

- S1. "un panel simple para escanear QR, ver historial de cosas que hizo, recordatorios y misiones activas, todo muy minimalista y usable, tambien, para que se loggen" (user). Pages in Spanish, same look as the existing pages.
- S2. Login with the same username and password as the MCP. Server-side sessions: random token in a cookie (`HttpOnly; Secure; SameSite=Strict; Path=/panel`), only its hash stored, 12 h lifetime, new token on every login; logout deletes it; `revokeUser` (logout, unlink, revoke, reset, suspension) also deletes the user's panel sessions. Logins share the login rate limiter. Every POST checks the Origin. Only `active` and `pairing` accounts can log in.
- S3. WhatsApp: shows the state read-only (connected, needs QR, connecting, disconnected); anything but connected links to `/pair`, which asks for the password again before the QR.
- S4. Activity: the latest 20 tool calls of the account with time, a Spanish label and whether it worked; never arguments or message content.
- S5. Reminders and missions (only when missions are on): active scheduled messages (text or instruction, chat, next run, repetition) and active missions (objective, chat, deadline), each with a cancel button that goes through the existing services.
- S6. Subscription: when the account is billed, shows "Al día" or the past-due notice with the suspension date.

## Tasks

- T1 (S2, S4) panel sessions in the auth store (+ revokeUser), recent tool calls query; inline; done c4431d6.
- T2 (S1-S6) panel routes and pages, wiring, docs; inline; done (this commit).

## Log

- L1 (2026-11-23, user): "Si, asi seria o seria mejor un panel simple para escanear QR, ver historial de cosas que hizo, recordatorios y misiones activas, todo muy minimalista y usable, tambien, para qu se loggen, porque eos necesta el MCP no?" then "Dale con todo".
- L2: Critic: long-lived panel session must be revocable (server-side table, cleared by revokeUser), new id on login, Origin check, re-auth before QR; activity log must hold no content.
- L3: Visual proof of the real routes (desktop, 390 px, empty state, login) published as an artifact; fixed the forgot link's spacing. Full suite 1361 passed.
