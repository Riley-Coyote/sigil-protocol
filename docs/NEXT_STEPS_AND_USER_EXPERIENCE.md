# SIGIL Remaining Work and Shipped UX

As of **February 11, 2026**.

## What still must be built for production-grade protocol guarantees

1. On-chain staking source of truth
- Replace API-managed staking mutations with on-chain Solana program instructions.
- Add indexer sync + replay-safe reconciliation from chain state.

Status update:
- Real on-chain devnet e2e coverage now exists via `npm run e2e:devnet` and validates live stake + unstake + Token-2022 passport flows end-to-end.
- Production now exposes truthful readiness gates at `/api/readiness`.
- In on-chain mode, legacy simulated staking rows are excluded from stats/leaderboards/positions.
- Real mainnet smoke runner exists via `SMOKE_WALLET_SECRET='<secret>' npm run smoke:prod`.

2. Full passport NFT hardening
- Add canonical metadata authority and collection verification for passport mints.
- Add key-compromise revocation/supersession rules.
- Add periodic chain backfill to reconcile `passport_records` with minted state.

3. Whitepaper-complete on-chain instruction coverage
- Implement/ship `register_agent`, `anchor_root`, `refund_deposit`, and objective `slash` flows in deployed mainnet program(s).

4. Security controls
- External security audit.
- Operator key management via multisig/HSM.
- SIWS-compatible structured message format and multi-device session keys.

5. SRE and reliability
- Centralized logs/metrics/tracing.
- Alerting on error rate, DB contention, and rate-limit abuse.
- Backup/restore drills and migration verification in CI.

## What users now see and experience on the website

1. Clear protocol path
- `register.html` for onboarding.
- `stake.html` for wallet-backed staking actions with signed one-time action challenges.
- `passport.html` for Token-2022 non-transferable passport mint flow.
- `verify.html` for full agent attestation checks.
- `integrations.html` for copy/paste integration snippets.

2. Passport flow UX
- Connect wallet.
- Sign issue challenge.
- Approve Token-2022 mint transaction.
- Sign finalize challenge.
- View minted passport state + tx reference + glyph artifact.

3. Verification UX
- Paste any agent public key.
- Toggle strict passport requirement.
- Get critical pass/fail checks, compact API, and embeddable badge snippet.

4. Developer adoption UX
- `.well-known` discovery endpoint at `/.well-known/sigil.json`.
- Full + compact verification APIs.
- SVG verification badge endpoint for docs/sites/profile embeds.
