# SIGIL Production Deployment Checklist

## Infrastructure

- [ ] Provision API host with automatic restart and health checks
- [ ] Use managed TLS + strict HTTPS redirect
- [x] Publish static `/.well-known/sigil.json` for edge/static routing compatibility
- [x] Add deployment helper script (`scripts/deploy-production.sh`)
- [x] Add automated production verification script (`scripts/verify-production.mjs`)
- [ ] Configure `PUBLIC_BASE_URL`, `CORS_ORIGINS`, and `SOLANA_RPC_URL`
- [ ] Set `SIGIL_DB_PATH` to persistent mounted storage
- [ ] Add encrypted offsite DB backups

## Protocol

- [ ] (Optional) Set `SIGIL_STAKING_PROGRAM_ID` to deployed mainnet program when protocol uses program-owned staking state
- [ ] Set `SIGIL_MINT` to canonical token mint
- [ ] (Optional) Set `SIGIL_PASSPORT_COLLECTION` to canonical collection address when enforcing collection marker policy
- [ ] Enable `SIGIL_STAKING_ONCHAIN=true`
- [ ] Set `SIGIL_STAKING_VAULT_OWNER` to staking vault owner wallet
- [ ] Set `SIGIL_STAKING_AUTHORITY_SECRET` for payout signing
- [x] Wire passport issuance to Token-2022 non-transferable mint prepare/finalize flow
- [x] Classify pre-onchain SIM passport records as `legacy_simulated` (excluded from on-chain passport counts)
- [ ] Add metadata authority + collection verification for minted passports

## Security

- [ ] Run dependency audit and patch critical issues
- [ ] Add WAF/rate limiting at edge
- [x] Add signing nonce enforcement for staking/passport mutations
- [x] Add session/domain binding for wallet mutation signatures
- [x] Require signed nonce challenge for passport finalize writes
- [ ] Protect admin/operator keys with multisig/HSM

## Observability

- [ ] Export logs and metrics to centralized stack
- [ ] Alerts for API error rate, DB lock contention, high 429 rate
- [ ] Monitor receipt ingestion lag and anchor cadence

## QA gates

- [x] Automated devnet real on-chain e2e harness (`npm run e2e:devnet`)
- [ ] Registration/verify pass on clean DB and migrated DB
- [ ] Receipts and anchors replay test passes
- [ ] Staking cooldown and emergency paths pass
- [ ] Passport issuance and metadata integrity pass
- [ ] Browser regression check on register/gallery/dashboard/stake/passport/verify/integrations
- [ ] `GET /api/readiness` returns `productionReady: true` with zero blocking checks (for required checks)
- [ ] `SMOKE_WALLET_SECRET='<secret>' npm run smoke:prod` completes (real mainnet mint + stake)
- [x] Add reproducible go-live runbook (`docs/PRODUCTION_RUNBOOK.md`)
