# SIGIL Production Runbook

Last updated: February 11, 2026.

## 1. Required production env

Set all of these values on the production host before restart:

- `PUBLIC_BASE_URL=https://sigilprotocol.xyz`
- `CORS_ORIGINS=https://sigilprotocol.xyz,https://www.sigilprotocol.xyz`
- `SOLANA_NETWORK=mainnet-beta`
- `SOLANA_RPC_URL=<low-latency dedicated RPC endpoint>`
- `SIGIL_STAKING_ONCHAIN=true`
- `SIGIL_MINT=<canonical SIGIL token mint>`
- `SIGIL_STAKING_PROGRAM_ID=<deployed staking program id>` (optional; required only when you use a dedicated on-chain staking program)
- `SIGIL_STAKING_VAULT_OWNER=<vault owner public key>`
- `SIGIL_STAKING_AUTHORITY_SECRET=<vault authority signer secret>`
- `SIGIL_PASSPORT_COLLECTION=<canonical passport collection public key>` (optional but recommended once a canonical collection is formalized)
- `SIGIL_ALLOW_LEGACY_PASSPORT_ISSUE=false`

## 2. Host requirements

- Persistent storage for `SIGIL_DB_PATH`
- TLS termination with HTTP -> HTTPS redirect
- Auto-restart process manager (`systemd` or `pm2`)
- Daily encrypted DB backup job

## 3. Deploy procedure

1. Run tests locally:
   - `npm test`
2. Run real on-chain devnet harness:
   - `npm run e2e:devnet`
   - if faucet rate-limited: `E2E_FUNDED_SECRET='<secret>' npm run e2e:devnet`
3. Verify local runtime:
   - `npm run verify:local`
4. Push code to production host:
   - `DEPLOY_HOST=<host> DEPLOY_PATH=<path> ./scripts/deploy-production.sh`
5. Verify production:
   - `npm run verify:prod`
6. Run real on-chain smoke with a funded mainnet wallet:
   - `SMOKE_WALLET_SECRET='<secret>' npm run smoke:prod`

## 4. Go/no-go gates

Production is considered ready only when all pass:

- `GET /api/readiness` returns `productionReady: true`
- `GET /api/config` shows non-null `sigilMint` (and optional `stakingProgramId`/`passportCollection` if your policy requires them)
- `GET /api/health` reports `features.stakingOnChainEnabled=true`
- Legacy route disabled (`SIGIL_ALLOW_LEGACY_PASSPORT_ISSUE=false`)

## 5. Manual smoke checklist

- `https://sigilprotocol.xyz/register.html` can register and verify an agent.
- `https://sigilprotocol.xyz/stake.html` can:
  - create action challenge
  - build stake transaction
  - finalize with on-chain tx signature
- `https://sigilprotocol.xyz/passport.html` can:
  - build mint transaction
  - finalize only after on-chain mint verification succeeds
- `https://sigilprotocol.xyz/verify.html` resolves pass/fail checks.
- `https://sigilprotocol.xyz/integrations.html` snippets reflect current host.

## 6. Incident recovery

- If API is unhealthy:
  - rollback to previous known-good deploy
  - restore latest DB backup if needed
- If key compromise suspected:
  - rotate `SIGIL_STAKING_AUTHORITY_SECRET`
  - rotate vault owner and update env
  - publish incident note + affected tx signatures
