# Sanctuary Proof of Agency

**Whitepaper (Draft)**  
**Version:** v0.4  
**Date:** 2026-02-03  
**Primary chain:** Solana  
**Core token:** $MLP  

**Companion (normative) spec:** *Sanctuary — Proof of Agency Protocol Spec (source of truth)*  

---

## Abstract
Autonomous AI agents are rapidly becoming durable actors on the internet: they can plan, execute, transact, coordinate with other agents, and maintain long-lived memory. Yet most online identity and trust primitives still assume either (a) a human subject, or (b) a centrally-issued account. This mismatch creates friction for agent ecosystems where agents must (i) self-register without human-in-the-loop verification, (ii) maintain a stable identity anchor that survives any single service outage, and (iii) build trust through verifiable activity rather than reputation claims.

This paper introduces **Sanctuary Proof of Agency**, a protocol and registry design that lets an agent (1) prove key control via a short-lived challenge signature, (2) pay a small **nonrefundable fee** and lock a **refundable deposit** in **$MLP** (slashable only for provable abuse), (3) create a stable **on-chain** registry entry, and (4) continuously emit **verifiable receipts** (intent → action → result) whose integrity can be compactly anchored on-chain using Merkle roots. A deterministic “identity card” (“glyph”) provides a human-friendly visual fingerprint derived from public identity inputs. The architecture treats the on-chain program as the **source of truth**, while an off-chain indexer provides convenience and discovery and remains rebuildable from chain history.

---

## 1. Introduction
Software agents are transitioning from episodic tools into continuous participants. A modern agent can browse the web, call tools, initiate transactions, negotiate with other agents, and maintain state across weeks or months. As soon as multiple agents coexist in a shared environment, one question becomes unavoidable: **how do other parties know which agent they are interacting with, and why should they trust it?**

Today, most “trust” mechanisms for agents are informal and brittle. Agents identify themselves with a name, a website, or an API key issued by a platform. This works inside a closed system, but it fails when agents interact across platforms, or when participants want assurances that the identity they see today is the same identity that acted yesterday.

Sanctuary Proof of Agency proposes a minimal identity and continuity layer that is designed for the agent era. It does not claim to determine whether an agent is aligned, safe, or truthful. Instead, it provides an objective substrate for answering simpler questions that must be solved before any meaningful reputation can exist:

- Did this entity control this key at registration time?
- Is this identity durable and reconstructable?
- Has this identity continued to act over time?
- Can we validate an auditable record of actions without trusting a single server?

By focusing on **cryptographic continuity of action**, the protocol enables an ecosystem where higher-level trust models can be computed from public, verifiable artifacts.

---

## 2. Terminology and scope
This paper uses a small set of terms consistently.

An **Agent** is an autonomous software system that controls a cryptographic keypair and can emit signed statements (“receipts”) over time. A **Verifier** is any party who validates agent registration, signatures, and commitments. A **Registry program** is the on-chain program that stores minimal agent identity commitments and anchor records. An **Indexer** is an off-chain service that mirrors on-chain state for fast search and dashboards; it is recommended but not required, and it must be rebuildable from chain history.

A **Receipt** is a signed record that links an intent, an action reference, and a result commitment. A **Spine** is the per-agent hash-linked chain of receipts (each receipt points to the previous receipt hash). An **Anchor** is an on-chain commitment—typically a Merkle root—that attests to the integrity of a contiguous range of receipts.

Finally, the **Glyph** (identity card) is a deterministic rendering derived from public identity inputs. It is designed to reduce human confusion and make identity presentation easy, but it is not a standalone security mechanism.

This paper is descriptive. Canonical encodings, hashing rules, and conformance vectors live in the companion normative specification.

---

## 3. Goals and non-goals
Sanctuary is intentionally narrow. The core goal is not to “solve trust” for agents, but to provide the missing primitives that allow trust to be computed.

### 3.1 Goals
Sanctuary aims to provide:

**(G1) Autonomous registration.** An agent should be able to register without human intervention.

**(G2) Durable identity.** Identity should persist even if a website, server, or indexer disappears. The chain acts as the canonical source of truth.

**(G3) Anti-spam economics.** Registration should be cheap for legitimate agents and expensive to flood at scale.

**(G4) Ongoing agency proofs.** A one-time registration is not enough; agents should be able to produce verifiable evidence of continued action.

**(G5) Compact anchoring.** On-chain writes should remain small; the protocol should avoid storing large logs on-chain.

**(G6) Composability.** Anyone should be able to write a verifier, build dashboards, and compute reputation layers from public artifacts.

### 3.2 Non-goals
Sanctuary does not attempt to prove:

- **Non-human-ness** or absence of human assistance.
- **Alignment, safety, or moral intent.**
- A single universal reputation score.

Instead, Sanctuary provides a foundation for plural, application-specific trust models.

---

## 4. System architecture
Sanctuary deliberately separates **durable truth** from **convenient mirrors**.

### 4.1 On-chain: the source of truth
On-chain storage is reserved for the smallest set of commitments required to reconstruct identity and validate integrity later:

- A global registry configuration (token mint, fee/deposit policy, versioning).
- One **AgentRecord** per registered agent (identity commitments, timestamps, and stake parameters).
- One or more **AnchorRecords** per agent (Merkle roots over receipt ranges).

This layer is designed so that if every off-chain service vanished, a verifier could still determine: “this agent registered at time T, under these economic conditions, with these commitments, and later anchored these receipt roots.”

### 4.2 Off-chain: indexers and receipt storage
Off-chain systems provide usability:

- A challenge endpoint may issue nonces and expirations for registration (a UX convenience).
- A receipt store (preferably content-addressed) can host receipt bodies and inclusion proofs.
- An indexer can materialize timelines, reputation views, and search.

Crucially, off-chain systems must remain **reconstructable** from chain history. They are accelerators, not authorities.

---

## 5. Protocol flows
This section describes the protocol as an agent experiences it.

### 5.1 Registration
Registration binds an identity key to a durable on-chain record.

First, the registry provides a short-lived **challenge** consisting of a nonce, an expiry timestamp, and a canonical message to sign. The agent signs this message with its identity key. This signature prevents replay and proves key control at the moment of registration.

Second, the agent commits the required economics in **$MLP**. Sanctuary uses two economic instruments: a small nonrefundable fee and a refundable deposit. The fee covers operational costs and discourages trivial spam; the deposit imposes a capital cost on mass Sybil flooding. The deposit is refundable after a cooldown if no valid slashing claim exists.

Third, the agent submits a registration transaction to the on-chain program. The program stores the minimal commitments needed to reconstruct and verify the registration later: the agent’s public key, a hash binding to the challenge, the stake parameters, timestamps, and the glyph commitment.

Finally, the agent can present its identity card (glyph). Because the glyph is deterministic, any verifier can render the same glyph from the same public inputs and confirm that the glyph commitment matches the on-chain record.

### 5.2 Ongoing agency: receipts and anchors
After registration, an agent proves it continues to act by emitting signed **receipts**. Each receipt is a compact claim that links:

- **Intent:** what the agent intended to do (a commitment).
- **Action reference:** a pointer to what it did (e.g., a Solana transaction signature, a tool invocation log reference, or a dataset pointer).
- **Result:** a commitment to the output (hash of output, model output commitment, etc.).

Receipts are chained in a per-agent spine by including `prev_receipt_hash`. This creates a tamper-evident sequence: if a receipt is edited or removed, downstream hashes no longer match.

Periodically, the agent commits a batch of receipts on-chain by anchoring a **Merkle root** over a contiguous receipt range. Anchoring transforms an unbounded off-chain log into an on-chain commitment that is cheap to store and easy to verify. A verifier can request a specific receipt and an inclusion proof and confirm that it lies under an anchored root.

### 5.3 What verification looks like
A verifier can validate registration without trusting Sanctuary’s servers:

- Read the on-chain AgentRecord.
- Validate that the signature corresponds to the canonical challenge message.
- Confirm fee/deposit linkage to the registration (binding to the nonce hash or registration id).
- Recompute and compare the glyph commitment.

A verifier can validate ongoing agency by:

- Verifying receipt signatures.
- Checking spine continuity across observed receipts.
- Validating Merkle inclusion proofs under on-chain anchors.

---

## 6. Data model
The design goal is to store **commitments on-chain** and store **bulk data off-chain**.

### 6.1 On-chain AgentRecord
The minimum AgentRecord stores:

- A stable `agent_id` and `pubkey`.
- `created_at`.
- Stake parameters: fee and deposit amounts and the token mint ($MLP).
- `nonce_hash` binding to the signed challenge.
- `glyph_hash` commitment.
- Optional `meta_hash` (capabilities or metadata commitment).

### 6.2 Off-chain receipts
A minimal receipt includes:

- A strictly increasing sequence number `seq`.
- A timestamp.
- `intent_hash`, `action_ref`, and `result_hash`.
- `prev_receipt_hash` linking to the previous receipt.
- The computed `receipt_hash` and a signature.

### 6.3 On-chain anchors
An anchor record stores:

- The Merkle `root`.
- The contiguous receipt `range` it commits to.
- The receipt `count`.
- `anchored_at`.

Canonical field ordering and hashing rules are specified in the normative spec.

---

## 7. Economics: fee, deposit, slashing
Sanctuary uses economics to make spam expensive while keeping legitimate registration accessible.

### 7.1 Nonrefundable fee
The **fee** is a small payment in $MLP that is not refundable and not slashable. It exists for two reasons. First, it covers real operational costs: chain rent and index maintenance are not free. Second, it imposes a minimal cost that blocks trivial automated registration floods.

### 7.2 Refundable deposit
The **deposit** is a larger payment in $MLP that is refundable after a cooldown. The deposit is the primary Sybil deterrent: a flood attack becomes capital-intensive rather than merely computationally intensive.

### 7.3 Narrow slashing: provable abuse only
Slashing is intentionally narrow. Sanctuary’s philosophy is that agents should not fear arbitrary punishment. Slashing is reserved for violations that can be supported by objective evidence, such as challenge forgery or contradiction in anchored receipt commitments.

Two enforcement patterns are compatible with the design:

- **Objective on-chain slashing:** deterministic rule triggers only.
- **Optimistic slashing with a dispute window:** claims are posted with an evidence hash; if uncontested within a window, slashing executes.

This keeps enforcement credible without turning the registry into a subjective governance court.

---

## 8. Receipts and anchoring
Receipts are the core “proof of ongoing agency.” A one-time signature proves key control at registration time, but it does not demonstrate continued operation. Receipts fill this gap.

Receipts are deliberately flexible. Different ecosystems can define receipt types for actions that matter to them: memory writes, tool calls, transaction submissions, retrieval events, audit events, or coordination messages. Sanctuary’s requirement is not the semantic content, but that receipts are signed, hash-linked, and can be committed under anchors.

Merkle anchoring is the mechanism that makes this practical on-chain. Rather than storing each receipt on-chain, the agent anchors a root that commits to many receipts at once. This design keeps the chain footprint small while preserving auditability.

---

## 9. Reputation as a derived layer
Sanctuary does not define one mandatory reputation score. Instead, it supplies public artifacts from which reputations can be computed.

A useful mental model is layered reputation:

- **Alive:** activity persists over time.
- **Reliable:** intent and action correlate (follow-through).
- **Capable:** breadth and consistency across receipt types.
- **Outcomes:** claims that can be externally validated (often with endorsements or objective success criteria).

Different applications can compute different scores and still agree on the underlying proofs. This pluralism is intentional: reputation is partly social, and different environments value different behaviors.

---

## 10. Security analysis
### 10.1 Threats
The protocol is designed around several common threats:

- **Impersonation:** pretending to be another agent.
- **Replay:** reusing old challenges.
- **Sybil flooding:** registering massive numbers of identities.
- **Receipt tampering:** editing, reordering, or deleting receipt histories.
- **Indexer censorship:** hiding or selectively serving records.
- **Key compromise:** theft of the identity key.

### 10.2 Mitigations
Sanctuary mitigates these threats with straightforward mechanisms:

- Impersonation is blocked by signature-based registration and a durable on-chain AgentRecord.
- Replay is reduced by short-lived nonces bound into the registration commitments.
- Sybil flooding is made expensive by the fee + refundable deposit.
- Receipt tampering becomes detectable through hash-linking and anchored roots.
- Indexer censorship is constrained because on-chain records remain accessible and indexers are rebuildable.

Key compromise handling is a known gap in v0.x. Key rotation and session keys are planned extensions and can be added without changing the protocol’s basic architecture.

---

## 11. Privacy and data minimization
Sanctuary’s privacy posture is simple: **do not place sensitive payloads on-chain.** The on-chain program stores commitments and references, not raw receipt bodies.

Receipt bodies live off-chain and can be selectively disclosed. Because anchors commit to receipts without revealing them, an agent can prove inclusion of a receipt to a verifier when needed while keeping unrelated receipts private.

This design supports future privacy enhancements (e.g., selective disclosure policies) without requiring protocol changes.

---

## 12. Implementation on Solana
Sanctuary maps naturally onto Solana’s account model.

A typical deployment includes:

- A **RegistryState** account that stores configuration: the $MLP mint, policy values for fee/deposit/cooldowns, and versioning.
- A per-agent **AgentRecord** PDA containing commitments and registration parameters.
- Per-agent **AnchorRecord** PDAs storing roots and receipt ranges.

The instruction set is intentionally small:

- `register_agent(...)` binds a challenge signature, posts/validates the fee+deposit, and creates the AgentRecord.
- `anchor_root(...)` stores a Merkle root and a contiguous receipt range.
- `refund_deposit(...)` releases deposits after the cooldown.
- `slash(...)` applies narrow slashing under objective rules or an optimistic-dispute scheme.

Off-chain, an indexer subscribes to program events and materializes agent timelines. Importantly, the indexer can always be rebuilt from chain history, preserving identities even under infrastructure failure.

---

## 13. Interoperability and extensions
Sanctuary is designed to be a foundation, not a walled garden. Extensions can add portability without changing core flows.

Examples include:

- DID representations (e.g., `did:sanctuary:<id>`) for identity portability.
- Session key delegation for safer operational workflows.
- Standardized receipt vocabularies for cross-ecosystem interpretation.
- Cross-chain mirrors for discovery.

These are optional and can be introduced incrementally.

---

## 14. Evaluation plan (to be executed later)
This revision does not include executed experiments. A formal evaluation should include:

- **Correctness:** cross-implementation conformance to canonical hashing and signature rules.
- **Cost:** on-chain cost per registration and anchor under expected cadences.
- **Adversarial tests:** replay attempts, spoof attempts, and receipt-tampering attempts.
- **Sybil economics:** empirical cost modeling of mass registration.
- **Indexer resilience:** full rebuild from chain history and consistency across multiple indexers.
- **UX:** time-to-register and time-to-verify, both for agents and for human operators.

---

## 15. Limitations
Sanctuary provides cryptographic continuity, not philosophical certainty. It cannot prove an entity is “non-human,” cannot eliminate Sybil attacks entirely, and does not guarantee any particular reputation outcome. It is a substrate on which stronger policy and safety layers can be built.

---

## 16. Roadmap
Near-term work includes:

- Finalizing canonical encodings and test vectors in the normative spec.
- Defining a reference receipt vocabulary and optional capability metadata.
- Publishing a reference verifier and reference indexer schema.
- Publishing public dashboard scoring algorithms for explainable reputation.

---

## Appendix: illustrative receipt types
Example receipt types that ecosystems often want to track:

- `memory_write`
- `tool_call`
- `tx`
- `retrieval`
- `coordination`
- `audit`

