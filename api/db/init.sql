CREATE TABLE IF NOT EXISTS agents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  public_key TEXT UNIQUE NOT NULL,
  agent_id TEXT UNIQUE,
  display_name TEXT,
  glyph_hash TEXT,
  tier INTEGER DEFAULT 1,
  status TEXT DEFAULT 'pending',
  stake_amount REAL DEFAULT 0,
  staker_count INTEGER DEFAULT 0,
  persistence_score REAL DEFAULT 0,
  verified_at TEXT,
  last_receipt_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  metadata TEXT
);

CREATE TABLE IF NOT EXISTS challenges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  public_key TEXT NOT NULL,
  nonce TEXT UNIQUE NOT NULL,
  message TEXT NOT NULL,
  status TEXT DEFAULT 'pending',
  created_at TEXT DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  used_at TEXT
);

CREATE TABLE IF NOT EXISTS action_challenges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  public_key TEXT NOT NULL,
  scope TEXT NOT NULL,
  action TEXT NOT NULL,
  session_id TEXT,
  domain TEXT,
  request_origin TEXT,
  payload_hash TEXT NOT NULL,
  nonce TEXT UNIQUE NOT NULL,
  message TEXT NOT NULL,
  status TEXT DEFAULT 'pending',
  created_at TEXT DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  used_at TEXT
);

CREATE TABLE IF NOT EXISTS receipts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  receipt_type TEXT NOT NULL,
  receipt_hash TEXT NOT NULL,
  prev_hash TEXT,
  intent_hash TEXT NOT NULL,
  action_ref TEXT NOT NULL,
  result_hash TEXT NOT NULL,
  signature TEXT,
  payload TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE,
  UNIQUE(agent_id, seq),
  UNIQUE(agent_id, receipt_hash)
);

CREATE TABLE IF NOT EXISTS anchors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id INTEGER NOT NULL,
  merkle_root TEXT NOT NULL,
  range_start INTEGER NOT NULL,
  range_end INTEGER NOT NULL,
  receipt_count INTEGER NOT NULL,
  tx_signature TEXT,
  evidence_uri TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE,
  UNIQUE(agent_id, range_start, range_end)
);

CREATE TABLE IF NOT EXISTS staking_positions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  staker_public_key TEXT NOT NULL,
  agent_id INTEGER NOT NULL,
  amount REAL DEFAULT 0,
  cooldown_amount REAL DEFAULT 0,
  cooldown_started_at TEXT,
  last_action TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE,
  UNIQUE(staker_public_key, agent_id)
);

CREATE TABLE IF NOT EXISTS staking_tx_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tx_signature TEXT UNIQUE NOT NULL,
  staker_public_key TEXT NOT NULL,
  agent_id INTEGER NOT NULL,
  action TEXT NOT NULL,
  amount REAL NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS passport_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id INTEGER UNIQUE NOT NULL,
  owner_public_key TEXT NOT NULL,
  mint_address TEXT UNIQUE,
  metadata_uri TEXT,
  image_uri TEXT,
  status TEXT DEFAULT 'pending',
  tx_signature TEXT,
  minted_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL,
  agent_id INTEGER,
  public_key TEXT,
  display_name TEXT,
  glyph_hash TEXT,
  detail TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_agents_public_key ON agents(public_key);
CREATE INDEX IF NOT EXISTS idx_agents_status ON agents(status);
CREATE INDEX IF NOT EXISTS idx_challenges_nonce ON challenges(nonce);
CREATE INDEX IF NOT EXISTS idx_challenges_public_key ON challenges(public_key);
CREATE INDEX IF NOT EXISTS idx_action_challenges_nonce ON action_challenges(nonce);
CREATE INDEX IF NOT EXISTS idx_action_challenges_public_key ON action_challenges(public_key);
CREATE INDEX IF NOT EXISTS idx_action_challenges_status ON action_challenges(status);
CREATE INDEX IF NOT EXISTS idx_receipts_agent ON receipts(agent_id);
CREATE INDEX IF NOT EXISTS idx_receipts_hash ON receipts(receipt_hash);
CREATE INDEX IF NOT EXISTS idx_anchors_agent ON anchors(agent_id);
CREATE INDEX IF NOT EXISTS idx_staking_positions_staker ON staking_positions(staker_public_key);
CREATE INDEX IF NOT EXISTS idx_staking_tx_ledger_staker ON staking_tx_ledger(staker_public_key);
CREATE INDEX IF NOT EXISTS idx_staking_tx_ledger_agent ON staking_tx_ledger(agent_id);
CREATE INDEX IF NOT EXISTS idx_passports_agent ON passport_records(agent_id);
CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at);
