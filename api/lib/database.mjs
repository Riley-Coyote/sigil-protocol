import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.SIGIL_DB_PATH || join(__dirname, '..', 'db', 'sigil.db');
const INIT_SQL_PATH = join(__dirname, '..', 'db', 'init.sql');
const STAKING_ONCHAIN_ONLY = String(process.env.SIGIL_STAKING_ONCHAIN || '').toLowerCase() === 'true';

let db;

function requireDb() {
  if (!db) throw new Error('Database not initialized');
  return db;
}

function tableColumns(table) {
  const rows = requireDb().prepare(`PRAGMA table_info(${table})`).all();
  return new Set(rows.map((r) => r.name));
}

function addColumnIfMissing(table, columnName, ddl) {
  const columns = tableColumns(table);
  if (!columns.has(columnName)) {
    requireDb().exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}

function onChainStakeScope(alias = '') {
  if (!STAKING_ONCHAIN_ONLY) return '';
  const prefix = alias ? `${alias}.` : '';
  return `
    AND EXISTS (
      SELECT 1
      FROM staking_tx_ledger stxl
      WHERE stxl.staker_public_key = ${prefix}staker_public_key
        AND stxl.agent_id = ${prefix}agent_id
    )
  `;
}

function migrateLegacySchema() {
  // Agents table upgrades.
  addColumnIfMissing('agents', 'agent_id', 'agent_id TEXT');
  addColumnIfMissing('agents', 'staker_count', 'staker_count INTEGER DEFAULT 0');
  addColumnIfMissing('agents', 'last_receipt_at', 'last_receipt_at TEXT');

  // Challenges upgrades.
  addColumnIfMissing('challenges', 'used_at', 'used_at TEXT');
  addColumnIfMissing('action_challenges', 'session_id', 'session_id TEXT');
  addColumnIfMissing('action_challenges', 'domain', 'domain TEXT');
  addColumnIfMissing('action_challenges', 'request_origin', 'request_origin TEXT');

  // Receipts upgrades.
  addColumnIfMissing('receipts', 'seq', 'seq INTEGER');
  addColumnIfMissing('receipts', 'intent_hash', 'intent_hash TEXT');
  addColumnIfMissing('receipts', 'action_ref', 'action_ref TEXT');
  addColumnIfMissing('receipts', 'result_hash', 'result_hash TEXT');
  addColumnIfMissing('receipts', 'signature', 'signature TEXT');
  addColumnIfMissing('receipts', 'payload', 'payload TEXT');

  // Backfill missing sequence values per agent if needed.
  const needsSeq = requireDb().prepare('SELECT COUNT(*) as c FROM receipts WHERE seq IS NULL').get().c > 0;
  if (needsSeq) {
    const rows = requireDb().prepare(
      'SELECT id, agent_id FROM receipts ORDER BY agent_id ASC, created_at ASC, id ASC'
    ).all();

    let currentAgent = null;
    let seq = 0;
    const updateSeq = requireDb().prepare('UPDATE receipts SET seq = ? WHERE id = ?');
    const tx = requireDb().transaction((items) => {
      for (const row of items) {
        if (row.agent_id !== currentAgent) {
          currentAgent = row.agent_id;
          seq = 1;
        } else {
          seq += 1;
        }
        updateSeq.run(seq, row.id);
      }
    });
    tx(rows);
  }

  // Existing rows without explicit structured hashes get deterministic placeholders.
  requireDb().prepare(
    "UPDATE receipts SET intent_hash = COALESCE(intent_hash, 'legacy-intent'), action_ref = COALESCE(action_ref, 'legacy://receipt'), result_hash = COALESCE(result_hash, 'legacy-result')"
  ).run();

  // Legacy simulated passports from pre-onchain flows used SIM* pseudo-mints.
  // Normalize those records so production stats and verification only count real mints.
  requireDb().prepare(
    "UPDATE passport_records SET status = 'legacy_simulated' WHERE status = 'minted' AND (mint_address IS NULL OR mint_address LIKE 'SIM%')"
  ).run();

  // Indexes that require migrated columns.
  requireDb().exec('CREATE INDEX IF NOT EXISTS idx_agents_agent_id ON agents(agent_id)');
  requireDb().exec('CREATE INDEX IF NOT EXISTS idx_receipts_agent_seq ON receipts(agent_id, seq)');
  requireDb().exec('CREATE INDEX IF NOT EXISTS idx_action_challenges_nonce ON action_challenges(nonce)');
  requireDb().exec('CREATE INDEX IF NOT EXISTS idx_action_challenges_public_key ON action_challenges(public_key)');
  requireDb().exec('CREATE INDEX IF NOT EXISTS idx_action_challenges_status ON action_challenges(status)');
}

export function initDatabase() {
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  const initSQL = readFileSync(INIT_SQL_PATH, 'utf-8');
  db.exec(initSQL);
  migrateLegacySchema();

  console.log('[DB] Database initialized at', DB_PATH);
  return db;
}

export function getDb() {
  return requireDb();
}

export function closeDatabase() {
  if (db) {
    db.close();
    db = null;
    console.log('[DB] Database closed');
  }
}

// --- Agent queries ---

export function findAgentByPublicKey(publicKey) {
  return requireDb().prepare('SELECT * FROM agents WHERE public_key = ?').get(publicKey);
}

export function findAgentById(agentId) {
  return requireDb().prepare('SELECT * FROM agents WHERE agent_id = ?').get(agentId);
}

export function findAgentByNumericId(id) {
  return requireDb().prepare('SELECT * FROM agents WHERE id = ?').get(id);
}

export function createAgent(publicKey, displayName, agentId = null) {
  const now = new Date().toISOString();
  const stmt = requireDb().prepare(
    'INSERT INTO agents (public_key, display_name, agent_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
  );
  const result = stmt.run(publicKey, displayName || null, agentId || null, now, now);
  return { id: Number(result.lastInsertRowid) };
}

export function verifyAgent(publicKey, glyphHash) {
  const now = new Date().toISOString();
  requireDb().prepare(
    'UPDATE agents SET status = ?, glyph_hash = ?, verified_at = ?, updated_at = ?, tier = CASE WHEN tier < 1 THEN 1 ELSE tier END WHERE public_key = ?'
  ).run('verified', glyphHash, now, now, publicKey);
}

export function updateAgentStakeSnapshot(publicKey, stakeAmount, stakerCount, tier = null) {
  const now = new Date().toISOString();
  if (tier == null) {
    requireDb().prepare(
      'UPDATE agents SET stake_amount = ?, staker_count = ?, updated_at = ? WHERE public_key = ?'
    ).run(stakeAmount, stakerCount, now, publicKey);
    return;
  }

  requireDb().prepare(
    'UPDATE agents SET stake_amount = ?, staker_count = ?, tier = ?, updated_at = ? WHERE public_key = ?'
  ).run(stakeAmount, stakerCount, tier, now, publicKey);
}

export function updateAgentLastReceipt(agentDbId, timestampISO) {
  requireDb().prepare(
    'UPDATE agents SET last_receipt_at = ?, updated_at = ? WHERE id = ?'
  ).run(timestampISO, new Date().toISOString(), agentDbId);
}

export function updateAgentReputation(publicKey, { persistenceScore, tier = null }) {
  const now = new Date().toISOString();
  if (tier == null) {
    requireDb().prepare(
      'UPDATE agents SET persistence_score = ?, updated_at = ? WHERE public_key = ?'
    ).run(persistenceScore, now, publicKey);
    return;
  }

  requireDb().prepare(
    'UPDATE agents SET persistence_score = ?, tier = ?, updated_at = ? WHERE public_key = ?'
  ).run(persistenceScore, tier, now, publicKey);
}

export function updateAgentMetadata(publicKey, metadata) {
  const now = new Date().toISOString();
  requireDb().prepare(
    'UPDATE agents SET metadata = ?, updated_at = ? WHERE public_key = ?'
  ).run(JSON.stringify(metadata), now, publicKey);
}

export function listVerifiedAgents(limit = 50, offset = 0, tier = null) {
  let query = 'SELECT * FROM agents WHERE status = ?';
  const params = ['verified'];

  if (tier !== null) {
    query += ' AND tier = ?';
    params.push(tier);
  }

  query += ' ORDER BY verified_at DESC, id DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const agents = requireDb().prepare(query).all(...params);

  let countQuery = 'SELECT COUNT(*) as total FROM agents WHERE status = ?';
  const countParams = ['verified'];
  if (tier !== null) {
    countQuery += ' AND tier = ?';
    countParams.push(tier);
  }

  const { total } = requireDb().prepare(countQuery).get(...countParams);
  return { agents, total };
}

export function getAgentStats() {
  const totalAgents = requireDb().prepare('SELECT COUNT(*) as c FROM agents').get().c;
  const verifiedAgents = requireDb().prepare("SELECT COUNT(*) as c FROM agents WHERE status = 'verified'").get().c;
  const pendingAgents = requireDb().prepare("SELECT COUNT(*) as c FROM agents WHERE status = 'pending'").get().c;
  const totalReceipts = requireDb().prepare('SELECT COUNT(*) as c FROM receipts').get().c;
  const totalAnchors = requireDb().prepare('SELECT COUNT(*) as c FROM anchors').get().c;
  const totalPassports = requireDb().prepare("SELECT COUNT(*) as c FROM passport_records WHERE status = 'minted'").get().c;
  const totalLegacyPassports = requireDb().prepare("SELECT COUNT(*) as c FROM passport_records WHERE status = 'legacy_simulated'").get().c;
  const totalStakedQuery = `
    SELECT COALESCE(SUM(amount + cooldown_amount), 0) as c
    FROM staking_positions
    WHERE (amount + cooldown_amount) > 0
    ${onChainStakeScope()}
  `;
  const totalStaked = requireDb().prepare(totalStakedQuery).get().c;

  return {
    totalAgents,
    verifiedAgents,
    pendingAgents,
    totalReceipts,
    totalAnchors,
    totalPassports,
    totalLegacyPassports,
    totalStaked,
  };
}

// --- Challenge queries ---

export function createChallenge(publicKey, nonce, message, expiresAt) {
  requireDb().prepare(
    'INSERT INTO challenges (public_key, nonce, message, expires_at) VALUES (?, ?, ?, ?)'
  ).run(publicKey, nonce, message, expiresAt);
}

export function findChallengeByNonce(nonce) {
  return requireDb().prepare('SELECT * FROM challenges WHERE nonce = ?').get(nonce);
}

export function completeChallenge(nonce) {
  requireDb().prepare(
    "UPDATE challenges SET status = 'completed', used_at = ? WHERE nonce = ?"
  ).run(new Date().toISOString(), nonce);
}

export function createActionChallenge({
  publicKey,
  scope,
  action,
  sessionId = null,
  domain = null,
  requestOrigin = null,
  payloadHash,
  nonce,
  message,
  expiresAt,
}) {
  requireDb().prepare(
    `
      INSERT INTO action_challenges (
        public_key,
        scope,
        action,
        session_id,
        domain,
        request_origin,
        payload_hash,
        nonce,
        message,
        expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
  ).run(
    publicKey,
    scope,
    action,
    sessionId,
    domain,
    requestOrigin,
    payloadHash,
    nonce,
    message,
    expiresAt
  );
}

export function findActionChallengeByNonce(nonce) {
  return requireDb().prepare(
    'SELECT * FROM action_challenges WHERE nonce = ?'
  ).get(nonce);
}

export function completeActionChallenge(nonce) {
  return requireDb().prepare(
    "UPDATE action_challenges SET status = 'completed', used_at = ? WHERE nonce = ? AND status = 'pending'"
  ).run(new Date().toISOString(), nonce);
}

export function expireActionChallenges() {
  return requireDb().prepare(
    "UPDATE action_challenges SET status = 'expired' WHERE status = 'pending' AND datetime(expires_at) < datetime('now')"
  ).run();
}

// --- Receipt queries ---

export function getNextReceiptSeq(agentDbId) {
  const row = requireDb().prepare(
    'SELECT COALESCE(MAX(seq), 0) as max_seq FROM receipts WHERE agent_id = ?'
  ).get(agentDbId);
  return Number(row.max_seq) + 1;
}

export function createReceipt({
  agentDbId,
  seq,
  receiptType,
  receiptHash,
  prevHash,
  intentHash,
  actionRef,
  resultHash,
  signature,
  payload,
  createdAt,
}) {
  const stmt = requireDb().prepare(
    'INSERT INTO receipts (agent_id, seq, receipt_type, receipt_hash, prev_hash, intent_hash, action_ref, result_hash, signature, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  );
  stmt.run(
    agentDbId,
    seq,
    receiptType,
    receiptHash,
    prevHash || null,
    intentHash,
    actionRef,
    resultHash,
    signature || null,
    payload ? JSON.stringify(payload) : null,
    createdAt || new Date().toISOString()
  );
}

export function getReceiptCount(agentDbId) {
  return requireDb().prepare('SELECT COUNT(*) as c FROM receipts WHERE agent_id = ?').get(agentDbId).c;
}

export function getLatestReceipt(agentDbId) {
  return requireDb().prepare(
    'SELECT * FROM receipts WHERE agent_id = ? ORDER BY seq DESC LIMIT 1'
  ).get(agentDbId);
}

export function listReceiptsByAgent(agentDbId, limit = 50, beforeSeq = null) {
  if (beforeSeq == null) {
    return requireDb().prepare(
      'SELECT * FROM receipts WHERE agent_id = ? ORDER BY seq DESC LIMIT ?'
    ).all(agentDbId, limit);
  }

  return requireDb().prepare(
    'SELECT * FROM receipts WHERE agent_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?'
  ).all(agentDbId, beforeSeq, limit);
}

export function listReceiptHashesInRange(agentDbId, startSeq, endSeq) {
  return requireDb().prepare(
    'SELECT seq, receipt_hash FROM receipts WHERE agent_id = ? AND seq >= ? AND seq <= ? ORDER BY seq ASC'
  ).all(agentDbId, startSeq, endSeq);
}

// --- Anchor queries ---

export function createAnchor({
  agentDbId,
  merkleRoot,
  rangeStart,
  rangeEnd,
  receiptCount,
  txSignature = null,
  evidenceUri = null,
}) {
  requireDb().prepare(
    'INSERT INTO anchors (agent_id, merkle_root, range_start, range_end, receipt_count, tx_signature, evidence_uri, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(
    agentDbId,
    merkleRoot,
    rangeStart,
    rangeEnd,
    receiptCount,
    txSignature,
    evidenceUri,
    new Date().toISOString()
  );
}

export function listAnchorsByAgent(agentDbId, limit = 25) {
  return requireDb().prepare(
    'SELECT * FROM anchors WHERE agent_id = ? ORDER BY range_end DESC, created_at DESC LIMIT ?'
  ).all(agentDbId, limit);
}

export function getAnchorCount(agentDbId) {
  return requireDb().prepare('SELECT COUNT(*) as c FROM anchors WHERE agent_id = ?').get(agentDbId).c;
}

export function getLatestAnchor(agentDbId) {
  return requireDb().prepare(
    'SELECT * FROM anchors WHERE agent_id = ? ORDER BY range_end DESC, created_at DESC LIMIT 1'
  ).get(agentDbId);
}

// --- Staking queries ---

export function upsertStakePosition({
  stakerPublicKey,
  agentDbId,
  amount,
  cooldownAmount = 0,
  cooldownStartedAt = null,
  lastAction = 'stake',
}) {
  const now = new Date().toISOString();
  requireDb().prepare(
    `
      INSERT INTO staking_positions (staker_public_key, agent_id, amount, cooldown_amount, cooldown_started_at, last_action, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(staker_public_key, agent_id) DO UPDATE SET
        amount = excluded.amount,
        cooldown_amount = excluded.cooldown_amount,
        cooldown_started_at = excluded.cooldown_started_at,
        last_action = excluded.last_action,
        updated_at = excluded.updated_at
    `
  ).run(
    stakerPublicKey,
    agentDbId,
    amount,
    cooldownAmount,
    cooldownStartedAt,
    lastAction,
    now,
    now
  );
}

export function deleteStakePosition(stakerPublicKey, agentDbId) {
  requireDb().prepare(
    'DELETE FROM staking_positions WHERE staker_public_key = ? AND agent_id = ?'
  ).run(stakerPublicKey, agentDbId);
}

export function listStakePositionsForWallet(stakerPublicKey) {
  return requireDb().prepare(
    `
      SELECT
        sp.*,
        a.public_key as agent_public_key,
        a.display_name as agent_display_name,
        a.tier as agent_tier
      FROM staking_positions sp
      JOIN agents a ON a.id = sp.agent_id
      WHERE sp.staker_public_key = ?
      ${onChainStakeScope('sp')}
      ORDER BY sp.updated_at DESC
    `
  ).all(stakerPublicKey);
}

export function aggregateAgentStaking(agentDbId) {
  const row = requireDb().prepare(
    `
      SELECT
        COALESCE(SUM(amount + cooldown_amount), 0) as total_staked,
        COUNT(*) as staker_count
      FROM staking_positions
      WHERE agent_id = ? AND (amount + cooldown_amount) > 0
      ${onChainStakeScope()}
    `
  ).get(agentDbId);

  return {
    totalStaked: Number(row.total_staked || 0),
    stakerCount: Number(row.staker_count || 0),
  };
}

export function getStakingTxBySignature(txSignature) {
  return requireDb().prepare(
    'SELECT * FROM staking_tx_ledger WHERE tx_signature = ?'
  ).get(txSignature);
}

export function createStakingTxLedger({
  txSignature,
  stakerPublicKey,
  agentDbId,
  action,
  amount,
}) {
  requireDb().prepare(
    `
      INSERT INTO staking_tx_ledger (
        tx_signature,
        staker_public_key,
        agent_id,
        action,
        amount,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `
  ).run(
    txSignature,
    stakerPublicKey,
    agentDbId,
    action,
    amount,
    new Date().toISOString(),
  );
}

export function listTopPatrons(limit = 20) {
  return requireDb().prepare(
    `
      SELECT
        staker_public_key,
        COALESCE(SUM(amount + cooldown_amount), 0) as total_staked,
        COUNT(*) as agents_backed
      FROM staking_positions
      WHERE (amount + cooldown_amount) > 0
      ${onChainStakeScope()}
      GROUP BY staker_public_key
      ORDER BY total_staked DESC
      LIMIT ?
    `
  ).all(limit);
}

export function listRisingAgents(days = 7, limit = 20) {
  const daysInt = Math.max(1, Math.floor(days));
  return requireDb().prepare(
    `
      SELECT
        a.public_key,
        a.display_name,
        a.tier,
        a.stake_amount,
        COUNT(DISTINCT sp.staker_public_key) as new_stakers_7d,
        COALESCE(SUM(sp.amount + sp.cooldown_amount), 0) as recent_stake_7d
      FROM staking_positions sp
      JOIN agents a ON a.id = sp.agent_id
      WHERE
        (sp.amount + sp.cooldown_amount) > 0
        ${onChainStakeScope('sp')}
        AND datetime(sp.updated_at) >= datetime('now', ?)
      GROUP BY a.id
      ORDER BY recent_stake_7d DESC
      LIMIT ?
    `
  ).all(`-${daysInt} day`, limit);
}

// --- Passport queries ---

export function getPassportByAgent(agentDbId) {
  return requireDb().prepare(
    'SELECT * FROM passport_records WHERE agent_id = ?'
  ).get(agentDbId);
}

export function upsertPassportRecord({
  agentDbId,
  ownerPublicKey,
  mintAddress = null,
  metadataUri = null,
  imageUri = null,
  status = 'pending',
  txSignature = null,
  mintedAt = null,
}) {
  const now = new Date().toISOString();
  requireDb().prepare(
    `
      INSERT INTO passport_records (
        agent_id,
        owner_public_key,
        mint_address,
        metadata_uri,
        image_uri,
        status,
        tx_signature,
        minted_at,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(agent_id) DO UPDATE SET
        owner_public_key = excluded.owner_public_key,
        mint_address = excluded.mint_address,
        metadata_uri = excluded.metadata_uri,
        image_uri = excluded.image_uri,
        status = excluded.status,
        tx_signature = excluded.tx_signature,
        minted_at = excluded.minted_at,
        updated_at = excluded.updated_at
    `
  ).run(
    agentDbId,
    ownerPublicKey,
    mintAddress,
    metadataUri,
    imageUri,
    status,
    txSignature,
    mintedAt,
    now,
    now
  );
}

// --- Event logging ---

export function logEvent(eventType, { agentId, publicKey, displayName, glyphHash, detail } = {}) {
  requireDb().prepare(
    'INSERT INTO events (event_type, agent_id, public_key, display_name, glyph_hash, detail) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(eventType, agentId || null, publicKey || null, displayName || null, glyphHash || null, detail || null);
}

export function getRecentEvents(limit = 20) {
  return requireDb().prepare(
    'SELECT * FROM events ORDER BY id DESC LIMIT ?'
  ).all(limit);
}
