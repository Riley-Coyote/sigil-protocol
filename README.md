# SIGIL Site + API (Unified)

This repo now runs the SIGIL website and protocol API from one service.

## What is included

- Static website pages (`index.html`, `register.html`, `dashboard.html`, `gallery.html`, `stake.html`, `portfolio.html`, `leaderboard.html`, `passport.html`)
- Integrated API under `/api/*` in `api/server.mjs`
- SQLite persistence in `api/db/sigil.db`
- Core protocol surfaces:
  - Registration + challenge/verify
  - One-time action challenge nonces for signed mutations
  - Session/domain-bound action signatures (anti-replay + anti-origin confusion)
  - Deterministic glyph rendering
  - Signed receipt ingestion
  - Merkle anchor commitments + proof verification
  - Staking state + cooldown/emergency flows
  - Passport issuance records + metadata endpoint
  - Token-2022 non-transferable passport mint prepare/finalize endpoints
  - Unified agent verification endpoint (`/api/verification/agent/:publicKey`)
  - Compact verification + embeddable badge endpoints

## Quick start

```bash
npm install
npm run dev
```

Visit:

- [http://localhost:3141](http://localhost:3141)
- [http://localhost:3141/register.html](http://localhost:3141/register.html)
- [http://localhost:3141/stake.html](http://localhost:3141/stake.html)
- [http://localhost:3141/passport.html](http://localhost:3141/passport.html)
- [http://localhost:3141/verify.html](http://localhost:3141/verify.html)
- [http://localhost:3141/integrations.html](http://localhost:3141/integrations.html)

## Tests

```bash
npm test
```

## Real on-chain devnet e2e

Runs the full real flow against Solana devnet:

- register + verify
- stake prepare/sign/send/finalize
- begin + complete unstake prepare/sign/send/finalize
- Token-2022 non-transferable passport mint prepare/sign/send/finalize
- readiness gate validation

```bash
npm run e2e:devnet
```

If devnet faucet is rate-limited, provide a funded keypair:

```bash
E2E_FUNDED_SECRET='<base58_or_json_secret>' npm run e2e:devnet
```

## Production verification

```bash
# Local runtime verification (readiness + on-chain config sanity)
npm run verify:local

# Live production verification (expects productionReady=true)
npm run verify:prod

# Real mainnet smoke run (requires a funded wallet with SOL,
# and for staking, enough SIGIL balance)
SMOKE_WALLET_SECRET='<base58_or_json_secret>' npm run smoke:prod
```

## Playwright recovery

If browser automation gets stuck on Chrome profile locks:

```bash
npm run playwright:reset
```

## API sanity checks

```bash
curl http://localhost:3141/api/health
curl http://localhost:3141/api/readiness
curl http://localhost:3141/api/stats
curl http://localhost:3141/api/agents?limit=10
```

## Action challenge contract

- `POST /api/auth/action-challenge` now requires:
  - `sessionId` (16-128 chars, `[A-Za-z0-9_-]`)
  - `domain` (origin URL, e.g. `https://sigilprotocol.xyz`)
- Mutation endpoints consuming nonce signatures require the same `sessionId` + `domain`.
- Staking supports two modes:
  - legacy API-managed mode via `POST /api/staking/stake`
  - real on-chain SPL transfer mode via:
    - `POST /api/staking/stake-prepare`
    - `POST /api/staking/stake-finalize`
    - `POST /api/staking/complete-unstake-prepare`
    - `POST /api/staking/complete-unstake-finalize`
    - `POST /api/staking/emergency-unstake-prepare`
    - `POST /api/staking/emergency-unstake-finalize`
  - on-chain mode is enabled with `SIGIL_STAKING_ONCHAIN=true`.
  - in on-chain mode, both prepare and finalize writes require signed action challenges (session/domain-bound).
- Passport on-chain mint flow:
  - `POST /api/passport/:publicKey/mint-prepare`
  - `POST /api/passport/:publicKey/mint-finalize`
  - `mint-finalize` also requires a signed action challenge (`scope=passport`, `action=finalize`).

## Verification integration endpoints

- `GET /api/verification/agent/:publicKey?requirePassport=1`
- `GET /api/verification/agent/:publicKey/compact?requirePassport=1`
- `GET /api/verification/badge/:publicKey.svg?requirePassport=1`
- `GET /.well-known/sigil.json`
- `/.well-known/sigil.json` is also checked in as a static file for edge/static hosts that intercept requests before Node routes.
- `GET /api/readiness` returns production gate checks (missing/invalid env keys are explicit).

## Passport status semantics

- `status = minted` means a real on-chain Token-2022 non-transferable passport was verified.
- `status = legacy_simulated` means an old simulated passport record (non-on-chain) and is intentionally not counted as production passport issuance.

## Environment variables

- `PORT` (default `3141`)
- `SIGIL_DB_PATH` (default `api/db/sigil.db`)
- `PUBLIC_BASE_URL` (optional; used for profile and metadata URLs)
- `CORS_ORIGINS` (comma-separated additional allowed origins)
- `SOLANA_NETWORK` (default `mainnet-beta`)
- `SOLANA_RPC_URL` (optional; defaults to cluster RPC for `SOLANA_NETWORK`)
- `SIGIL_MINT` (optional token mint address)
- `SIGIL_STAKING_PROGRAM_ID` (optional; set when a dedicated on-chain staking program is deployed)
- `SIGIL_PASSPORT_COLLECTION` (optional; set when enforcing a canonical collection marker)
- `SIGIL_STAKING_ONCHAIN` (default `false`; enables real on-chain staking flow)
- `SIGIL_STAKING_TOKEN_PROGRAM` (`token` or `token2022`, default `token`)
- `SIGIL_STAKING_VAULT_OWNER` (vault owner wallet public key; required for on-chain staking)
- `SIGIL_STAKING_AUTHORITY_SECRET` (required to co-sign complete/emergency unstake payouts in on-chain mode)
- `SIGIL_PASSPORT_SYMBOL` (default `SIGIL`)
- `SIGIL_ALLOW_LEGACY_PASSPORT_ISSUE` (default `false`; keep disabled in production)
- `STAKE_COOLDOWN_DAYS` (default `7`)
- `EMERGENCY_SLASH_BPS` (default `1000`)
- `MIN_STAKE` (default `1000`)
- `MAX_STAKE` (default `50000`)
- `ACTION_CHALLENGE_TTL_MS` (default `300000`)

See `.env.example` for a complete configuration template.

## Deployment helper

For single-node deployments, use:

```bash
DEPLOY_HOST=<host> DEPLOY_PATH=<remote_path> ./scripts/deploy-production.sh
```

See `docs/PRODUCTION_RUNBOOK.md` for the full production checklist and go/no-go gates.

## Planning docs

- `docs/PROTOCOL_INTEL_AND_ROADMAP.md`
- `docs/DEPLOYMENT_CHECKLIST.md`
- `docs/NEXT_STEPS_AND_USER_EXPERIENCE.md`
- `docs/PRODUCTION_RUNBOOK.md`
