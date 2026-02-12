# SIGIL Protocol Intel, Gap Analysis, and Production Roadmap

As of **February 11, 2026**.

## 1. Concept and Vision (from code + whitepaper)

SIGIL aims to be identity infrastructure for autonomous agents:

- Autonomous registration (keyless or wallet challenge flow)
- Durable identity with deterministic glyph artifact
- Ongoing proof-of-agency through signed receipts
- Compact on-chain anchoring via Merkle roots
- Economic anti-Sybil layer via staking and slashing
- Portable trust layer, not a single reputation monopoly

Whitepaper priorities confirmed:

- Off-chain receipts, on-chain commitments
- Fee + refundable deposit model
- Pluggable verification and reputation scoring
- Planned key rotation/session keys still marked as a v0.x gap

## 2. What was deployed before this build

Verified from live endpoints/pages:

- Website routes deployed: `/`, `/register.html`, `/gallery.html`, `/dashboard.html`, `/whitepaper.html`, etc.
- API v0.4.1 deployed at `/api/*` with:
  - health/stats/events
  - register + challenge verify
  - agent listing/profile
  - glyph rendering
- Live numbers at check time:
  - `totalAgents`: 131
  - `verifiedAgents`: 121
  - `totalReceipts`: 116
- Major gaps observed in deployed UX:
  - staking UI and portfolio were mostly mocked
  - leaderboard used synthetic/randomized values
  - no publicly accessible passport issuance flow
  - no user-facing receipts/anchors workflows

## 3. What is now implemented in this repo

### API (unified service)

- `api/server.mjs` now serves both static site and API.
- New/expanded protocol surfaces:
  - `POST /api/receipts` and `GET /api/receipts/:publicKey`
  - `POST /api/anchors`, `GET /api/anchors/:publicKey`, `POST /api/anchors/verify`
  - staking endpoints:
    - `POST /api/staking/stake`
    - `POST /api/staking/stake-prepare`
    - `POST /api/staking/stake-finalize`
    - `POST /api/staking/begin-unstake`
    - `POST /api/staking/cancel-unstake`
    - `POST /api/staking/complete-unstake`
    - `POST /api/staking/emergency-unstake`
    - `GET /api/staking/positions/:stakerPublicKey`
  - passport endpoints:
    - `GET /api/passport/:publicKey`
    - `GET /api/passport/:publicKey/metadata`
    - `POST /api/passport/:publicKey/issue`
    - `POST /api/passport/:publicKey/mint-prepare`
    - `POST /api/passport/:publicKey/mint-finalize`
  - leaderboard endpoints:
    - `GET /api/leaderboard/top-patrons`
    - `GET /api/leaderboard/rising`
  - verification endpoints:
    - `GET /api/verification/agent/:publicKey`
    - `GET /api/verification/agent/:publicKey/compact`
    - `GET /api/verification/badge/:publicKey.svg`
    - `GET /.well-known/sigil.json`

### Real on-chain QA harness

- `npm run e2e:devnet` now executes a full real Solana devnet flow:
  - wallet registration + verification
  - stake prepare/sign/send/finalize
  - begin/complete unstake prepare/sign/send/finalize
  - Token-2022 non-transferable passport mint prepare/sign/send/finalize
  - readiness gate validation under fully-configured runtime env
- `npm run smoke:prod` now executes real production smoke flows against `https://sigilprotocol.xyz` using a funded wallet secret:
  - register + verify agent
  - passport mint prepare/send/finalize
  - stake prepare/send/finalize (when wallet has SIGIL balance)

### Data model

Expanded SQLite schema now includes:

- `receipts` with `seq`, intent/action/result hashes, signatures
- `anchors` for range commitments
- `staking_positions`
- `passport_records`
- backward-compat migrations for legacy DB columns
- on-chain mode filtering now excludes legacy staking rows that lack on-chain tx ledger proofs

### Frontend updates

- `stake.html` switched from mock-only flows to signed API staking flows.
- `portfolio.html` switched from static mock positions to live wallet positions endpoint.
- `leaderboard.html` switched from randomized leaderboard values to API-backed data.
- `gallery.html` and `agent.html` now use dynamic API base for local/prod environments.
- new `passport.html` added for wallet-based passport lookup/issuance.
- new `verify.html` added for developer-facing protocol verification checks.
- new `integrations.html` added with copy/paste API + badge embed snippets.
- navigation links updated to expose the passport flow.

## 4. What still needs to be built for true production-grade protocol status

These are the critical remaining items.

### A. On-chain source-of-truth completion

Current staking/passport in this repo is API-managed state with signed intents. For full protocol guarantees:

1. Deploy and harden `sigil-programs` on Solana mainnet-beta.
2. Replace API-side staking state transitions with on-chain transaction builders + indexer sync.
3. Implement canonical `anchor_root`/`refund_deposit`/`slash` program paths from whitepaper semantics.
4. Add chain confirmation and reorg-safe indexing.

### B. Passport NFT hardening

Token-2022 Soulbound mint flow now exists (prepare + finalize with deterministic mint and chain verification). Remaining hardening:

1. Add metadata authority controls and collection verification.
2. Add revocation/supersession policy for compromised keys.
3. Add chain index backfill jobs for already-minted passports.

### C. Security and abuse controls

1. Add session keys + rotation flows.
2. Replay-protected nonce signing + domain/session binding is now implemented for staking and passport flows; next step is full SIWS-compatible message schema and multi-device session management.
3. Add formal abuse/slash dispute workflow and evidence schemas.
4. Add external audit before production key custody.

### D. SRE and reliability

1. Add structured logs + tracing + alerting.
2. Add DB backup/restore + migration CI checks.
3. Add rate-limit telemetry and abuse dashboards.
4. Add blue/green deployment or canary process.

## 5. Recommended execution order

1. Mainnet program deployment + IDL freeze + integration tests
2. Indexer with chain replay and deterministic rebuild
3. Token-2022 Soulbound passport mint pipeline
4. End-to-end staking rewrite to on-chain tx paths
5. Security review and launch readiness gate

## 6. Viral and mass adoption engine (practical)

### Product loop

- One-click agent registration -> instant glyph -> public profile URL
- Mandatory receipt cadence (alive proofs) -> dynamic rank movement
- Stake-backed curation -> social proof around real agents
- Passport issuance -> shareable identity artifact

### Distribution loop

- Weekly "Top Rising Agents" snapshots syndicated to X/Telegram/Discord
- Public API leaderboards for ecosystem partners
- Embeddable "Verify my agent" badge and widget
- Challenge campaigns: "100 receipts in 7 days", "Top staker cohort"
- Performance benchmark targets based on proven viral app systems:
  - 50-150 creator accounts in UGC network phase
  - 30-70 posts/day network-wide during breakout pushes
  - one repeatable hook format scaled into 20-50 variants
- Example ceilings from adjacent growth engines:
  - Yope: ~145 ambassadors and 207M views
  - TurboLearn: 435M+ views and reported $300K MRR
  - TruthSeek: 100K downloads in ~22 days using high-velocity posting

### Ecosystem lock-in

- Open verifier SDKs (TS/Python/Rust)
- DID-compatible resolver format
- federation adapters for MCP agents, bot frameworks, and autonomous infra tools

## 7. Non-negotiable launch criteria

- deterministic signing and receipt hashing test vectors
- reproducible indexer state from chain replay
- slash/dispute path tested in adversarial simulation
- wallet UX safe defaults (no hidden signing prompts)
- published incident response and key compromise playbook
