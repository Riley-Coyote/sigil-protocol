import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import crypto from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  clusterApiUrl,
} from '@solana/web3.js';
import {
  AuthorityType,
  ExtensionType,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  createInitializeInstruction as createInitializeTokenMetadataInstruction,
  createInitializeMint2Instruction,
  createInitializeMetadataPointerInstruction,
  createInitializeNonTransferableMintInstruction,
  createMintToInstruction,
  createSetAuthorityInstruction,
  createTransferCheckedInstruction,
  createUpdateAuthorityInstruction as createUpdateTokenMetadataAuthorityInstruction,
  createUpdateFieldInstruction as createUpdateTokenMetadataFieldInstruction,
  getAssociatedTokenAddressSync,
  getMint,
  getMetadataPointerState,
  getMintLen,
  getNonTransferable,
  getTokenMetadata,
} from '@solana/spl-token';
import bs58 from 'bs58';
import { pack as packTokenMetadata } from '@solana/spl-token-metadata';

import {
  initDatabase,
  closeDatabase,
  createAgent,
  findAgentByPublicKey,
  verifyAgent,
  listVerifiedAgents,
  getAgentStats,
  createChallenge as dbCreateChallenge,
  findChallengeByNonce,
  completeChallenge,
  createActionChallenge,
  findActionChallengeByNonce,
  completeActionChallenge,
  expireActionChallenges,
  getReceiptCount,
  getLatestReceipt,
  logEvent,
  getRecentEvents,
  getDb,
  updateAgentMetadata,
  getNextReceiptSeq,
  listReceiptsByAgent,
  listAnchorsByAgent,
  getLatestAnchor,
  getAnchorCount,
  aggregateAgentStaking,
  updateAgentStakeSnapshot,
  updateAgentReputation,
  upsertStakePosition,
  listStakePositionsForWallet,
  deleteStakePosition,
  listTopPatrons,
  listRisingAgents,
  getStakingTxBySignature,
  createStakingTxLedger,
  getPassportByAgent,
  upsertPassportRecord,
} from './lib/database.mjs';

import {
  isValidPublicKey,
  generateChallenge,
  verifySignature,
  isChallengeExpired,
} from './lib/challenge.mjs';

import { generateGlyphHash } from './lib/glyph.mjs';
import {
  buildReceiptPreimage,
  issueSystemReceipt,
  storeSignedReceipt,
} from './lib/receipts.mjs';
import {
  validateAnchorRange,
  canAnchorRange,
  buildAnchorForRange,
  persistAnchor,
} from './lib/anchors.mjs';
import { verifyMerkleProof } from './lib/merkle.mjs';
import { calculatePersistenceScore, calculateTier } from './lib/economics.mjs';
import {
  buildPassportMetadata,
  deterministicPassportMint,
  derivePassportMintAddress,
  normalizeMetadataUri,
} from './lib/passports.mjs';

import { renderGlyphCard } from './lib/glyphRenderer.mjs';
import {
  strictLimit,
  moderateLimit,
  relaxedLimit,
  actionChallengeLimit,
  mutationLimit,
  globalLimit,
} from './middleware/rateLimit.mjs';
import { maxBodySize } from './middleware/validate.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SITE_ROOT = join(__dirname, '..');
const GLYPHS_DIR = join(__dirname, 'glyphs');

const app = express();
const PORT = Number(process.env.PORT || 3141);
const VERSION = '0.5.0';
const startTime = Date.now();

const COOLDOWN_DAYS = Number(process.env.STAKE_COOLDOWN_DAYS || 7);
const EMERGENCY_SLASH_BPS = Number(process.env.EMERGENCY_SLASH_BPS || 1000);
const MIN_STAKE = Number(process.env.MIN_STAKE || 1000);
const MAX_STAKE = Number(process.env.MAX_STAKE || 50000);
const ACTION_CHALLENGE_TTL_MS = Number(process.env.ACTION_CHALLENGE_TTL_MS || 5 * 60 * 1000);
const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL || clusterApiUrl(process.env.SOLANA_NETWORK || 'mainnet-beta');
const ACTION_ALLOWLIST = Object.freeze({
  staking: new Set(['stake', 'begin_unstake', 'cancel_unstake', 'complete_unstake', 'emergency_unstake']),
  passport: new Set(['issue', 'finalize']),
});
const ACTION_SESSION_ID_REGEX = /^[A-Za-z0-9_-]{16,128}$/;
const STAKING_ONCHAIN_ENABLED = /^(1|true|yes|on)$/i.test(String(process.env.SIGIL_STAKING_ONCHAIN || ''));
const STAKING_MINT_ADDRESS_RAW = process.env.SIGIL_MINT || null;
const STAKING_MINT_ADDRESS = normalizeEnvPublicKey(STAKING_MINT_ADDRESS_RAW);
const STAKING_PROGRAM_ID_RAW = process.env.SIGIL_STAKING_PROGRAM_ID || null;
const STAKING_PROGRAM_ID = normalizeEnvPublicKey(STAKING_PROGRAM_ID_RAW);
const STAKING_TOKEN_PROGRAM = String(process.env.SIGIL_STAKING_TOKEN_PROGRAM || 'token').toLowerCase();
const STAKING_TOKEN_PROGRAM_ID = STAKING_TOKEN_PROGRAM === 'token2022'
  ? TOKEN_2022_PROGRAM_ID
  : TOKEN_PROGRAM_ID;
const STAKING_VAULT_OWNER_RAW = process.env.SIGIL_STAKING_VAULT_OWNER || null;
const STAKING_VAULT_OWNER = normalizeEnvPublicKey(STAKING_VAULT_OWNER_RAW);
const STAKING_AUTHORITY_SECRET = process.env.SIGIL_STAKING_AUTHORITY_SECRET || null;
const LEGACY_PASSPORT_ISSUE_ENABLED = /^(1|true|yes|on)$/i.test(String(process.env.SIGIL_ALLOW_LEGACY_PASSPORT_ISSUE || ''));
const PASSPORT_SYMBOL = String(process.env.SIGIL_PASSPORT_SYMBOL || 'SIGIL').trim().slice(0, 10) || 'SIGIL';
const PASSPORT_COLLECTION_RAW = process.env.SIGIL_PASSPORT_COLLECTION || null;
const PASSPORT_COLLECTION = normalizeEnvPublicKey(PASSPORT_COLLECTION_RAW);

const defaultOrigins = [
  'https://sigilprotocol.xyz',
  'https://www.sigilprotocol.xyz',
  'http://localhost:3000',
  'http://localhost:4173',
  'http://localhost:5173',
  `http://localhost:${PORT}`,
];

const envOrigins = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map((v) => v.trim())
  .filter(Boolean);

const corsOrigins = new Set([...defaultOrigins, ...envOrigins]);

function nowIso() {
  return new Date().toISOString();
}

function hasConfiguredValue(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function normalizeEnvPublicKey(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    return new PublicKey(trimmed).toBase58();
  } catch {
    return null;
  }
}

function envPublicKeyError(rawValue, normalizedValue, envName) {
  if (!hasConfiguredValue(rawValue)) return `${envName} is not configured`;
  if (!normalizedValue) return `${envName} is not a valid Solana public key`;
  return null;
}

function toBase58(buf) {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let zeros = 0;
  while (zeros < buf.length && buf[zeros] === 0) zeros += 1;

  let num = BigInt(`0x${Buffer.from(buf).toString('hex') || '0'}`);
  let encoded = '';
  while (num > 0n) {
    encoded = alphabet[Number(num % 58n)] + encoded;
    num /= 58n;
  }
  for (let i = 0; i < zeros; i += 1) encoded = '1' + encoded;
  return encoded || '1';
}

function escapeSvgText(input) {
  return String(input ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function normalizeDisplayName(input) {
  if (!input || typeof input !== 'string') return null;
  const value = input.trim().replace(/\s+/g, ' ');
  if (value.length < 2 || value.length > 64) return null;
  return value;
}

function createAgentSlug(displayName, publicKey) {
  const base = (displayName || 'agent')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24) || 'agent';
  return `${base}-${publicKey.slice(0, 6).toLowerCase()}`;
}

function buildPassportTokenName(displayName) {
  const cleaned = String(displayName || 'Anonymous Agent')
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[^A-Za-z0-9 ._-]/g, '')
    .trim();
  const safe = cleaned || 'Anonymous Agent';
  const maxCoreLength = 20;
  const core = safe.length > maxCoreLength ? `${safe.slice(0, maxCoreLength).trimEnd()}...` : safe;
  return `${core} Passport`;
}

function buildPassportTokenMetadataFields(agent, metadataUri) {
  const glyphHash = String(agent?.glyph_hash || '').slice(0, 64);
  const tier = String(Number(agent?.tier || 1));
  const verifiedAt = String(agent?.verified_at || '');
  const displayName = String(agent?.display_name || 'Anonymous Agent');
  const additionalMetadata = [
    ['sigil_standard', 'sigil-passport-v1'],
    ['sigil_agent', String(agent?.public_key || '')],
    ['sigil_glyph_hash', glyphHash],
    ['sigil_tier', tier],
    ['sigil_verified_at', verifiedAt],
    ['sigil_soulbound', 'true'],
  ];
  if (PASSPORT_COLLECTION) {
    additionalMetadata.push(['sigil_collection', PASSPORT_COLLECTION]);
  }
  return {
    name: buildPassportTokenName(displayName),
    symbol: PASSPORT_SYMBOL,
    uri: metadataUri,
    additionalMetadata,
  };
}

function parseMetadata(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function baseUrlFromReq(req) {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/$/, '');
  const proto = req.headers['x-forwarded-proto'] || req.protocol;
  return `${proto}://${req.get('host')}`;
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isLegacySimulatedPassportRecord(record) {
  if (!record) return false;
  if (record.status === 'legacy_simulated') return true;
  return record.status === 'minted'
    && typeof record.mint_address === 'string'
    && /^SIM[A-F0-9]{40}$/.test(record.mint_address);
}

function metadataUriSemanticallyMatches(actualUri, expectedUri) {
  if (actualUri === expectedUri) return true;
  if (!actualUri || !expectedUri) return false;
  try {
    const actual = new URL(actualUri);
    const expected = new URL(expectedUri);
    return actual.pathname === expected.pathname && actual.search === expected.search;
  } catch {
    return false;
  }
}

function stableJson(value) {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(',')}]`;
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort();
    const body = keys.map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',');
    return `{${body}}`;
  }
  return JSON.stringify(value);
}

function hashActionPayload(payload) {
  return crypto.createHash('sha256').update(stableJson(payload)).digest('hex');
}

function normalizeActionSessionId(input) {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (!ACTION_SESSION_ID_REGEX.test(trimmed)) return null;
  return trimmed;
}

function normalizeActionDomain(input) {
  if (typeof input !== 'string') return null;
  try {
    const parsed = new URL(input);
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;
    return parsed.origin.toLowerCase();
  } catch {
    return null;
  }
}

function requestOriginFromReq(req) {
  return normalizeActionDomain(req.get('origin') || '');
}

function buildActionChallengeMessage({
  scope,
  action,
  publicKey,
  sessionId,
  domain,
  payloadHash,
  nonce,
  expiresAt,
}) {
  return `SIGIL:ACTION:V2:${scope}:${action}:${publicKey}:${sessionId}:${domain}:${payloadHash}:${nonce}:${expiresAt}`;
}

function issueActionChallenge({
  publicKey,
  scope,
  action,
  sessionId,
  domain,
  requestOrigin = null,
  payload,
}) {
  const payloadHash = hashActionPayload(payload);
  const nonce = crypto.randomBytes(18).toString('base64url');
  const expiresAt = new Date(Date.now() + ACTION_CHALLENGE_TTL_MS).toISOString();
  const message = buildActionChallengeMessage({
    scope,
    action,
    publicKey,
    sessionId,
    domain,
    payloadHash,
    nonce,
    expiresAt,
  });

  createActionChallenge({
    publicKey,
    scope,
    action,
    sessionId,
    domain,
    requestOrigin,
    payloadHash,
    nonce,
    message,
    expiresAt,
  });

  return {
    nonce,
    message,
    expiresAt,
    payloadHash,
  };
}

function consumeActionChallenge({
  publicKey,
  scope,
  action,
  sessionId,
  domain,
  requestOrigin = null,
  payload,
  nonce,
  signature,
}) {
  if (!nonce || !signature) {
    return { ok: false, status: 400, error: 'nonce and signature are required', code: 'INVALID_SIGNATURE' };
  }
  const normalizedSessionId = normalizeActionSessionId(sessionId);
  if (!normalizedSessionId) {
    return { ok: false, status: 400, error: 'Valid sessionId is required', code: 'INVALID_SESSION' };
  }
  const normalizedDomain = normalizeActionDomain(domain);
  if (!normalizedDomain) {
    return { ok: false, status: 400, error: 'Valid domain is required', code: 'INVALID_DOMAIN' };
  }
  if (!corsOrigins.has(normalizedDomain)) {
    return { ok: false, status: 400, error: 'Domain is not allowed', code: 'INVALID_DOMAIN' };
  }

  expireActionChallenges();
  const challenge = findActionChallengeByNonce(nonce);
  if (!challenge) {
    return { ok: false, status: 404, error: 'Action challenge not found', code: 'NOT_FOUND' };
  }
  if (challenge.public_key !== publicKey) {
    return { ok: false, status: 400, error: 'Action challenge public key mismatch', code: 'INVALID_KEY' };
  }
  if (challenge.scope !== scope || challenge.action !== action) {
    return { ok: false, status: 400, error: 'Action challenge scope mismatch', code: 'INVALID_ACTION' };
  }
  if ((challenge.session_id || '') !== normalizedSessionId) {
    return { ok: false, status: 400, error: 'Action challenge session mismatch', code: 'INVALID_SESSION' };
  }
  if ((challenge.domain || '').toLowerCase() !== normalizedDomain) {
    return { ok: false, status: 400, error: 'Action challenge domain mismatch', code: 'DOMAIN_MISMATCH' };
  }
  if (requestOrigin && challenge.request_origin && requestOrigin !== challenge.request_origin) {
    return { ok: false, status: 400, error: 'Action challenge origin mismatch', code: 'ORIGIN_MISMATCH' };
  }
  if (challenge.status !== 'pending') {
    return { ok: false, status: 400, error: 'Action challenge already used', code: 'CHALLENGE_USED' };
  }
  if (isChallengeExpired(challenge.expires_at)) {
    return { ok: false, status: 400, error: 'Action challenge expired', code: 'CHALLENGE_EXPIRED' };
  }

  const payloadHash = hashActionPayload(payload);
  if (challenge.payload_hash !== payloadHash) {
    return { ok: false, status: 400, error: 'Action payload mismatch', code: 'PAYLOAD_MISMATCH' };
  }

  const expectedMessage = challenge.message || buildActionChallengeMessage({
    scope: challenge.scope,
    action: challenge.action,
    publicKey: challenge.public_key,
    sessionId: challenge.session_id,
    domain: challenge.domain,
    payloadHash: challenge.payload_hash,
    nonce: challenge.nonce,
    expiresAt: challenge.expires_at,
  });

  if (!verifySignature(expectedMessage, signature, publicKey)) {
    return { ok: false, status: 400, error: 'Invalid signature', code: 'INVALID_SIGNATURE' };
  }

  const completed = completeActionChallenge(nonce);
  if (!completed?.changes) {
    return { ok: false, status: 409, error: 'Action challenge conflict', code: 'CHALLENGE_CONFLICT' };
  }

  return { ok: true };
}

function validateActionChallengeInput({
  publicKey,
  scope,
  action,
  payload,
  sessionId,
  domain,
  requestOrigin,
}) {
  if (!isValidPublicKey(publicKey)) {
    return { ok: false, status: 400, error: 'Invalid public key format', code: 'INVALID_KEY' };
  }
  if (!ACTION_ALLOWLIST[scope] || !ACTION_ALLOWLIST[scope].has(action)) {
    return { ok: false, status: 400, error: 'Unsupported scope/action', code: 'INVALID_ACTION' };
  }
  if (!isObject(payload)) {
    return { ok: false, status: 400, error: 'payload object is required', code: 'INVALID_INPUT' };
  }
  const normalizedSessionId = normalizeActionSessionId(sessionId);
  if (!normalizedSessionId) {
    return { ok: false, status: 400, error: 'Valid sessionId is required', code: 'INVALID_SESSION' };
  }
  const normalizedDomain = normalizeActionDomain(domain);
  if (!normalizedDomain) {
    return { ok: false, status: 400, error: 'Valid domain is required', code: 'INVALID_DOMAIN' };
  }
  if (!corsOrigins.has(normalizedDomain)) {
    return { ok: false, status: 400, error: 'Domain is not allowed', code: 'INVALID_DOMAIN' };
  }
  if (requestOrigin && requestOrigin !== normalizedDomain) {
    return { ok: false, status: 400, error: 'Origin does not match domain', code: 'ORIGIN_MISMATCH' };
  }

  if (scope === 'staking') {
    if (payload.stakerPublicKey !== publicKey || !isValidPublicKey(payload.stakerPublicKey)) {
      return { ok: false, status: 400, error: 'payload.stakerPublicKey mismatch', code: 'INVALID_KEY' };
    }
    if (!isValidPublicKey(payload.agentPublicKey)) {
      return { ok: false, status: 400, error: 'payload.agentPublicKey is invalid', code: 'INVALID_KEY' };
    }
    if (payload.txSignature != null && normalizeSolanaSignature(payload.txSignature) == null) {
      return { ok: false, status: 400, error: 'payload.txSignature is invalid', code: 'INVALID_TX' };
    }
    if (action === 'stake' || action === 'begin_unstake') {
      if (!Number.isFinite(Number(payload.amount)) || Number(payload.amount) <= 0) {
        return { ok: false, status: 400, error: 'payload.amount must be positive', code: 'INVALID_AMOUNT' };
      }
    }
    if (action === 'emergency_unstake') {
      if (!Number.isFinite(Number(payload.total)) || Number(payload.total) <= 0) {
        return { ok: false, status: 400, error: 'payload.total must be positive', code: 'INVALID_AMOUNT' };
      }
    }
  }

  if (scope === 'passport') {
    if (!isValidPublicKey(payload.agentPublicKey)) {
      return { ok: false, status: 400, error: 'payload.agentPublicKey is invalid', code: 'INVALID_KEY' };
    }
    if (payload.ownerPublicKey !== publicKey || !isValidPublicKey(payload.ownerPublicKey)) {
      return { ok: false, status: 400, error: 'payload.ownerPublicKey mismatch', code: 'INVALID_KEY' };
    }
    if (action === 'finalize') {
      if (!isValidPublicKey(payload.mintAddress)) {
        return { ok: false, status: 400, error: 'payload.mintAddress is invalid', code: 'INVALID_KEY' };
      }
      if (payload.txSignature != null && normalizeSolanaSignature(payload.txSignature) == null) {
        return { ok: false, status: 400, error: 'payload.txSignature is invalid', code: 'INVALID_TX' };
      }
    }
  }

  return {
    ok: true,
    sessionId: normalizedSessionId,
    domain: normalizedDomain,
  };
}

function solanaConnection() {
  return new Connection(SOLANA_RPC_URL, 'confirmed');
}

function tokenAccountAmountFromParsed(account) {
  const amountRaw = account?.data?.parsed?.info?.tokenAmount?.amount;
  if (typeof amountRaw === 'string') return BigInt(amountRaw);
  return 0n;
}

function normalizeSolanaSignature(sig) {
  if (typeof sig !== 'string') return null;
  const trimmed = sig.trim();
  if (!trimmed) return null;
  if (!/^[1-9A-HJ-NP-Za-km-z]{64,128}$/.test(trimmed)) return null;
  return trimmed;
}

function accountKeyToString(key) {
  if (typeof key === 'string') return key;
  if (key && typeof key === 'object' && key.pubkey) {
    if (typeof key.pubkey === 'string') return key.pubkey;
    if (typeof key.pubkey.toBase58 === 'function') return key.pubkey.toBase58();
  }
  if (key && typeof key.toBase58 === 'function') return key.toBase58();
  return String(key || '');
}

function stakingAmountToBaseUnits(amountTokens, decimals) {
  const normalized = typeof amountTokens === 'number'
    ? String(amountTokens)
    : String(amountTokens || '').trim();
  if (!/^\d+(\.\d+)?$/.test(normalized)) throw new Error('Invalid amount');

  const [wholePartRaw, fractionalPartRaw = ''] = normalized.split('.');
  const wholePart = wholePartRaw.replace(/^0+(?=\d)/, '') || '0';
  if (fractionalPartRaw.length > decimals) {
    throw new Error('Amount has too many decimal places');
  }
  const fractionalPart = fractionalPartRaw.padEnd(decimals, '0');

  const factor = 10n ** BigInt(decimals);
  const whole = BigInt(wholePart) * factor;
  const fractional = fractionalPart ? BigInt(fractionalPart) : 0n;
  const total = whole + fractional;
  if (total <= 0n) throw new Error('Invalid amount');
  return total;
}

let stakingAuthorityCache = undefined;
function stakingAuthorityKeypair() {
  if (stakingAuthorityCache !== undefined) return stakingAuthorityCache;
  if (!STAKING_AUTHORITY_SECRET) {
    stakingAuthorityCache = null;
    return stakingAuthorityCache;
  }

  try {
    const trimmed = STAKING_AUTHORITY_SECRET.trim();
    let secret;
    if (trimmed.startsWith('[')) {
      const parsed = JSON.parse(trimmed);
      secret = Uint8Array.from(parsed);
    } else if (/^\d+(,\d+)+$/.test(trimmed)) {
      secret = Uint8Array.from(trimmed.split(',').map((v) => Number(v.trim())));
    } else {
      secret = Uint8Array.from(bs58.decode(trimmed));
    }
    stakingAuthorityCache = Keypair.fromSecretKey(secret);
    return stakingAuthorityCache;
  } catch (err) {
    throw new Error(`Invalid SIGIL_STAKING_AUTHORITY_SECRET: ${err.message}`);
  }
}

function stakingVaultOwnerPublicKey() {
  if (STAKING_VAULT_OWNER) return new PublicKey(STAKING_VAULT_OWNER);
  const authority = stakingAuthorityKeypair();
  if (authority) return authority.publicKey;
  return null;
}

function safeStakingVaultOwnerPublicKey() {
  try {
    return stakingVaultOwnerPublicKey();
  } catch {
    return null;
  }
}

function stakingVaultOwnerReadiness() {
  if (STAKING_VAULT_OWNER) {
    return {
      pass: true,
      source: 'SIGIL_STAKING_VAULT_OWNER',
      detail: null,
    };
  }
  if (hasConfiguredValue(STAKING_VAULT_OWNER_RAW) && !STAKING_VAULT_OWNER) {
    return {
      pass: false,
      source: 'SIGIL_STAKING_VAULT_OWNER',
      detail: 'SIGIL_STAKING_VAULT_OWNER is not a valid Solana public key',
    };
  }
  if (hasConfiguredValue(STAKING_AUTHORITY_SECRET)) {
    try {
      const authority = stakingAuthorityKeypair();
      if (authority?.publicKey) {
        return {
          pass: true,
          source: 'SIGIL_STAKING_AUTHORITY_SECRET',
          detail: null,
        };
      }
      return {
        pass: false,
        source: 'SIGIL_STAKING_AUTHORITY_SECRET',
        detail: 'SIGIL_STAKING_AUTHORITY_SECRET did not resolve to a keypair',
      };
    } catch (err) {
      return {
        pass: false,
        source: 'SIGIL_STAKING_AUTHORITY_SECRET',
        detail: err.message,
      };
    }
  }
  return {
    pass: false,
    source: null,
    detail: 'Set SIGIL_STAKING_VAULT_OWNER or SIGIL_STAKING_AUTHORITY_SECRET',
  };
}

function stakingModeReady() {
  if (!STAKING_ONCHAIN_ENABLED) return false;
  if (!STAKING_MINT_ADDRESS) return false;
  return Boolean(safeStakingVaultOwnerPublicKey());
}

function getProtocolReadiness() {
  const vaultOwner = stakingVaultOwnerReadiness();
  const checks = [
    {
      key: 'staking.onchain_enabled',
      env: 'SIGIL_STAKING_ONCHAIN',
      pass: STAKING_ONCHAIN_ENABLED,
      required: true,
      detail: STAKING_ONCHAIN_ENABLED ? null : 'Set SIGIL_STAKING_ONCHAIN=true',
    },
    {
      key: 'staking.mint_address',
      env: 'SIGIL_MINT',
      pass: Boolean(STAKING_MINT_ADDRESS),
      required: true,
      detail: envPublicKeyError(STAKING_MINT_ADDRESS_RAW, STAKING_MINT_ADDRESS, 'SIGIL_MINT'),
    },
    {
      key: 'staking.vault_owner',
      env: 'SIGIL_STAKING_VAULT_OWNER or SIGIL_STAKING_AUTHORITY_SECRET',
      pass: vaultOwner.pass,
      required: true,
      detail: vaultOwner.detail,
    },
    {
      key: 'staking.program_id',
      env: 'SIGIL_STAKING_PROGRAM_ID',
      pass: Boolean(STAKING_PROGRAM_ID),
      required: false,
      detail: envPublicKeyError(STAKING_PROGRAM_ID_RAW, STAKING_PROGRAM_ID, 'SIGIL_STAKING_PROGRAM_ID'),
    },
    {
      key: 'passport.collection',
      env: 'SIGIL_PASSPORT_COLLECTION',
      pass: Boolean(PASSPORT_COLLECTION),
      required: false,
      detail: envPublicKeyError(PASSPORT_COLLECTION_RAW, PASSPORT_COLLECTION, 'SIGIL_PASSPORT_COLLECTION'),
    },
    {
      key: 'passport.legacy_issue_disabled',
      env: 'SIGIL_ALLOW_LEGACY_PASSPORT_ISSUE',
      pass: !LEGACY_PASSPORT_ISSUE_ENABLED,
      required: true,
      detail: LEGACY_PASSPORT_ISSUE_ENABLED ? 'Disable SIGIL_ALLOW_LEGACY_PASSPORT_ISSUE for production' : null,
    },
  ];

  const blocking = checks.filter((check) => check.required && !check.pass);
  return {
    productionReady: blocking.length === 0,
    staking: {
      runtimeReady: stakingModeReady(),
      canonicalProgramConfigured: Boolean(STAKING_PROGRAM_ID),
      vaultOwnerSource: vaultOwner.source,
    },
    passport: {
      runtimeReady: true,
      collectionConfigured: Boolean(PASSPORT_COLLECTION),
      collectionAddress: PASSPORT_COLLECTION,
      legacyIssueEnabled: LEGACY_PASSPORT_ISSUE_ENABLED,
    },
    checks,
    blocking,
  };
}

async function getStakingMintState() {
  if (!STAKING_MINT_ADDRESS) {
    return { ok: false, status: 400, error: 'SIGIL_MINT is not configured', code: 'STAKING_MINT_UNSET' };
  }
  if (!stakingModeReady()) {
    return { ok: false, status: 400, error: 'On-chain staking is not fully configured', code: 'STAKING_NOT_CONFIGURED' };
  }

  const connection = solanaConnection();
  const mint = new PublicKey(STAKING_MINT_ADDRESS);
  const mintAccount = await connection.getAccountInfo(mint, 'confirmed');
  if (!mintAccount) {
    return { ok: false, status: 400, error: 'Configured staking mint was not found on-chain', code: 'STAKING_MINT_NOT_FOUND' };
  }
  if (!mintAccount.owner.equals(STAKING_TOKEN_PROGRAM_ID)) {
    return {
      ok: false,
      status: 400,
      error: 'Configured staking mint owner does not match staking token program',
      code: 'STAKING_MINT_PROGRAM_MISMATCH',
    };
  }

  let mintState;
  try {
    mintState = await getMint(connection, mint, 'confirmed', STAKING_TOKEN_PROGRAM_ID);
  } catch (err) {
    return {
      ok: false,
      status: 400,
      error: `Unable to decode staking mint: ${err.message}`,
      code: 'STAKING_MINT_DECODE_FAILED',
    };
  }

  return {
    ok: true,
    connection,
    mint,
    decimals: mintState.decimals,
    tokenProgramId: STAKING_TOKEN_PROGRAM_ID,
  };
}

function parsedTokenAmountForAccount(parsedTx, mintAddress, accountAddress, side = 'post') {
  const meta = parsedTx?.meta;
  const balances = side === 'pre' ? meta?.preTokenBalances : meta?.postTokenBalances;
  const keys = parsedTx?.transaction?.message?.accountKeys || [];
  if (!balances || !Array.isArray(balances)) return 0n;

  let total = 0n;
  for (const entry of balances) {
    if (!entry || entry.mint !== mintAddress) continue;
    const key = keys[entry.accountIndex];
    const keyString = accountKeyToString(key);
    if (keyString !== accountAddress) continue;
    const amount = entry?.uiTokenAmount?.amount;
    if (typeof amount === 'string') total += BigInt(amount);
  }
  return total;
}

async function buildStakeTransferTransaction({
  stakerPublicKey,
  amountTokens,
}) {
  const mintState = await getStakingMintState();
  if (!mintState.ok) return mintState;

  const { connection, mint, decimals, tokenProgramId } = mintState;
  const staker = new PublicKey(stakerPublicKey);
  const vaultOwner = stakingVaultOwnerPublicKey();
  const sourceAta = getAssociatedTokenAddressSync(mint, staker, false, tokenProgramId);
  const vaultAta = getAssociatedTokenAddressSync(mint, vaultOwner, true, tokenProgramId);

  const sourceInfo = await connection.getAccountInfo(sourceAta, 'confirmed');
  if (!sourceInfo) {
    return {
      ok: false,
      status: 400,
      error: 'Staker token account not found for configured staking mint',
      code: 'STAKER_TOKEN_ACCOUNT_MISSING',
    };
  }

  const amountBaseUnits = stakingAmountToBaseUnits(amountTokens, decimals);
  const latest = await connection.getLatestBlockhash('confirmed');
  const transaction = new Transaction({
    feePayer: staker,
    blockhash: latest.blockhash,
    lastValidBlockHeight: latest.lastValidBlockHeight,
  });

  const vaultInfo = await connection.getAccountInfo(vaultAta, 'confirmed');
  if (!vaultInfo) {
    transaction.add(
      createAssociatedTokenAccountInstruction(
        staker,
        vaultAta,
        vaultOwner,
        mint,
        tokenProgramId,
      ),
    );
  }

  transaction.add(
    createTransferCheckedInstruction(
      sourceAta,
      mint,
      vaultAta,
      staker,
      amountBaseUnits,
      decimals,
      [],
      tokenProgramId,
    ),
  );

  const serialized = transaction.serialize({
    requireAllSignatures: false,
    verifySignatures: false,
  }).toString('base64');

  return {
    ok: true,
    transactionBase64: serialized,
    blockhash: latest.blockhash,
    lastValidBlockHeight: latest.lastValidBlockHeight,
    rpcEndpoint: SOLANA_RPC_URL,
    mintAddress: mint.toBase58(),
    sourceAtaAddress: sourceAta.toBase58(),
    vaultAtaAddress: vaultAta.toBase58(),
    vaultOwnerPublicKey: vaultOwner.toBase58(),
    amountTokens: Number(amountTokens),
    amountBaseUnits: amountBaseUnits.toString(),
    decimals,
    tokenProgramId: tokenProgramId.toBase58(),
  };
}

async function verifyStakeTransferOnChain({
  stakerPublicKey,
  amountTokens,
  txSignature,
}) {
  const normalizedSig = normalizeSolanaSignature(txSignature);
  if (!normalizedSig) {
    return { ok: false, status: 400, error: 'Invalid txSignature format', code: 'INVALID_TX' };
  }

  const mintState = await getStakingMintState();
  if (!mintState.ok) return mintState;

  const { connection, mint, decimals, tokenProgramId } = mintState;
  const staker = new PublicKey(stakerPublicKey);
  const vaultOwner = stakingVaultOwnerPublicKey();
  const sourceAta = getAssociatedTokenAddressSync(mint, staker, false, tokenProgramId);
  const vaultAta = getAssociatedTokenAddressSync(mint, vaultOwner, true, tokenProgramId);

  const parsedTx = await connection.getParsedTransaction(normalizedSig, {
    commitment: 'confirmed',
    maxSupportedTransactionVersion: 0,
  });
  if (!parsedTx) return { ok: false, status: 400, error: 'Transaction signature not found', code: 'TX_NOT_FOUND' };
  if (parsedTx.meta?.err) return { ok: false, status: 400, error: 'Transaction failed on-chain', code: 'TX_FAILED' };

  const keys = parsedTx?.transaction?.message?.accountKeys || [];
  const signerMatch = keys.some((key) => {
    const keyString = accountKeyToString(key);
    const signerFlag = Boolean(key?.signer);
    return keyString === stakerPublicKey && signerFlag;
  });
  if (!signerMatch) {
    return { ok: false, status: 400, error: 'Transaction is not signed by expected staker', code: 'TX_SIGNER_MISMATCH' };
  }

  const preSource = parsedTokenAmountForAccount(parsedTx, mint.toBase58(), sourceAta.toBase58(), 'pre');
  const postSource = parsedTokenAmountForAccount(parsedTx, mint.toBase58(), sourceAta.toBase58(), 'post');
  const preVault = parsedTokenAmountForAccount(parsedTx, mint.toBase58(), vaultAta.toBase58(), 'pre');
  const postVault = parsedTokenAmountForAccount(parsedTx, mint.toBase58(), vaultAta.toBase58(), 'post');
  const sourceDelta = postSource - preSource;
  const vaultDelta = postVault - preVault;
  const expectedAmount = stakingAmountToBaseUnits(amountTokens, decimals);

  if (sourceDelta !== -expectedAmount || vaultDelta !== expectedAmount) {
    return {
      ok: false,
      status: 400,
      error: 'Transaction token deltas do not match expected stake transfer',
      code: 'TX_AMOUNT_MISMATCH',
    };
  }

  return {
    ok: true,
    txSignature: normalizedSig,
    mintAddress: mint.toBase58(),
    sourceAtaAddress: sourceAta.toBase58(),
    vaultAtaAddress: vaultAta.toBase58(),
    decimals,
    amountBaseUnits: expectedAmount.toString(),
    amountTokens: Number(amountTokens),
  };
}

async function buildVaultPayoutTransaction({
  stakerPublicKey,
  returnAmountTokens,
}) {
  const authority = stakingAuthorityKeypair();
  if (!authority) {
    return {
      ok: false,
      status: 400,
      error: 'Staking authority key is not configured for vault payouts',
      code: 'STAKING_AUTHORITY_UNSET',
    };
  }

  const vaultOwner = stakingVaultOwnerPublicKey();
  if (!vaultOwner.equals(authority.publicKey)) {
    return {
      ok: false,
      status: 500,
      error: 'Staking vault owner does not match authority signer',
      code: 'STAKING_AUTHORITY_MISMATCH',
    };
  }

  const mintState = await getStakingMintState();
  if (!mintState.ok) return mintState;
  const { connection, mint, decimals, tokenProgramId } = mintState;

  const staker = new PublicKey(stakerPublicKey);
  const vaultAta = getAssociatedTokenAddressSync(mint, vaultOwner, true, tokenProgramId);
  const stakerAta = getAssociatedTokenAddressSync(mint, staker, false, tokenProgramId);
  const amountBaseUnits = stakingAmountToBaseUnits(returnAmountTokens, decimals);
  const latest = await connection.getLatestBlockhash('confirmed');
  const tx = new Transaction({
    feePayer: staker,
    blockhash: latest.blockhash,
    lastValidBlockHeight: latest.lastValidBlockHeight,
  });

  const stakerAtaInfo = await connection.getAccountInfo(stakerAta, 'confirmed');
  if (!stakerAtaInfo) {
    tx.add(
      createAssociatedTokenAccountInstruction(
        staker,
        stakerAta,
        staker,
        mint,
        tokenProgramId,
      ),
    );
  }

  tx.add(
    createTransferCheckedInstruction(
      vaultAta,
      mint,
      stakerAta,
      authority.publicKey,
      amountBaseUnits,
      decimals,
      [],
      tokenProgramId,
    ),
  );

  tx.partialSign(authority);
  const serialized = tx.serialize({
    requireAllSignatures: false,
    verifySignatures: false,
  }).toString('base64');

  return {
    ok: true,
    transactionBase64: serialized,
    blockhash: latest.blockhash,
    lastValidBlockHeight: latest.lastValidBlockHeight,
    rpcEndpoint: SOLANA_RPC_URL,
    mintAddress: mint.toBase58(),
    vaultOwnerPublicKey: vaultOwner.toBase58(),
    vaultAtaAddress: vaultAta.toBase58(),
    stakerAtaAddress: stakerAta.toBase58(),
    amountTokens: Number(returnAmountTokens),
    amountBaseUnits: amountBaseUnits.toString(),
    decimals,
  };
}

async function verifyVaultPayoutOnChain({
  stakerPublicKey,
  amountTokens,
  txSignature,
}) {
  const normalizedSig = normalizeSolanaSignature(txSignature);
  if (!normalizedSig) {
    return { ok: false, status: 400, error: 'Invalid txSignature format', code: 'INVALID_TX' };
  }

  const authority = stakingAuthorityKeypair();
  if (!authority) {
    return {
      ok: false,
      status: 400,
      error: 'Staking authority key is not configured for vault payouts',
      code: 'STAKING_AUTHORITY_UNSET',
    };
  }

  const mintState = await getStakingMintState();
  if (!mintState.ok) return mintState;

  const { connection, mint, decimals, tokenProgramId } = mintState;
  const staker = new PublicKey(stakerPublicKey);
  const vaultOwner = stakingVaultOwnerPublicKey();
  const vaultAta = getAssociatedTokenAddressSync(mint, vaultOwner, true, tokenProgramId);
  const stakerAta = getAssociatedTokenAddressSync(mint, staker, false, tokenProgramId);

  const parsedTx = await connection.getParsedTransaction(normalizedSig, {
    commitment: 'confirmed',
    maxSupportedTransactionVersion: 0,
  });
  if (!parsedTx) return { ok: false, status: 400, error: 'Transaction signature not found', code: 'TX_NOT_FOUND' };
  if (parsedTx.meta?.err) return { ok: false, status: 400, error: 'Transaction failed on-chain', code: 'TX_FAILED' };

  const keys = parsedTx?.transaction?.message?.accountKeys || [];
  const stakerSigned = keys.some((key) => {
    const keyString = accountKeyToString(key);
    return keyString === stakerPublicKey && Boolean(key?.signer);
  });
  if (!stakerSigned) {
    return { ok: false, status: 400, error: 'Transaction is not signed by expected staker', code: 'TX_SIGNER_MISMATCH' };
  }

  const authoritySigned = keys.some((key) => {
    const keyString = accountKeyToString(key);
    return keyString === authority.publicKey.toBase58() && Boolean(key?.signer);
  });
  if (!authoritySigned) {
    return { ok: false, status: 400, error: 'Transaction missing staking authority signature', code: 'TX_AUTHORITY_MISMATCH' };
  }

  const preVault = parsedTokenAmountForAccount(parsedTx, mint.toBase58(), vaultAta.toBase58(), 'pre');
  const postVault = parsedTokenAmountForAccount(parsedTx, mint.toBase58(), vaultAta.toBase58(), 'post');
  const preStaker = parsedTokenAmountForAccount(parsedTx, mint.toBase58(), stakerAta.toBase58(), 'pre');
  const postStaker = parsedTokenAmountForAccount(parsedTx, mint.toBase58(), stakerAta.toBase58(), 'post');
  const vaultDelta = postVault - preVault;
  const stakerDelta = postStaker - preStaker;
  const expectedAmount = stakingAmountToBaseUnits(amountTokens, decimals);

  if (vaultDelta !== -expectedAmount || stakerDelta !== expectedAmount) {
    return {
      ok: false,
      status: 400,
      error: 'Transaction token deltas do not match expected vault payout',
      code: 'TX_AMOUNT_MISMATCH',
    };
  }

  return {
    ok: true,
    txSignature: normalizedSig,
    mintAddress: mint.toBase58(),
    vaultAtaAddress: vaultAta.toBase58(),
    stakerAtaAddress: stakerAta.toBase58(),
    decimals,
    amountBaseUnits: expectedAmount.toString(),
    amountTokens: Number(amountTokens),
  };
}

async function buildPassportMintTransaction({
  ownerPublicKey,
  agentPublicKey,
  metadataUri,
  tokenMetadataFields,
}) {
  const connection = solanaConnection();
  const owner = new PublicKey(ownerPublicKey);
  const { seed, mintAddress } = await derivePassportMintAddress(ownerPublicKey, agentPublicKey);
  const mint = new PublicKey(mintAddress);
  const ata = getAssociatedTokenAddressSync(mint, owner, false, TOKEN_2022_PROGRAM_ID);
  const tokenMetadata = {
    updateAuthority: owner,
    mint,
    name: tokenMetadataFields.name,
    symbol: tokenMetadataFields.symbol,
    uri: tokenMetadataFields.uri,
    additionalMetadata: tokenMetadataFields.additionalMetadata || [],
  };

  const existingMint = await connection.getAccountInfo(mint, 'confirmed');
  if (existingMint) {
    return {
      alreadyExists: true,
      mintAddress,
      ataAddress: ata.toBase58(),
      metadataUri,
      rpcEndpoint: SOLANA_RPC_URL,
      seed,
    };
  }

  const metadataExtensionLength = packTokenMetadata(tokenMetadata).length;
  const mintExtensions = [ExtensionType.NonTransferable, ExtensionType.MetadataPointer];
  const mintBaseSpace = getMintLen(mintExtensions);
  const mintFinalSpace = getMintLen(mintExtensions, {
    [ExtensionType.TokenMetadata]: metadataExtensionLength,
  });
  const [mintBaseRentLamports, mintFinalRentLamports] = await Promise.all([
    connection.getMinimumBalanceForRentExemption(mintBaseSpace),
    connection.getMinimumBalanceForRentExemption(mintFinalSpace),
  ]);
  const metadataRentTopUpLamports = Math.max(0, mintFinalRentLamports - mintBaseRentLamports);
  const latest = await connection.getLatestBlockhash('confirmed');
  const transaction = new Transaction({
    feePayer: owner,
    blockhash: latest.blockhash,
    lastValidBlockHeight: latest.lastValidBlockHeight,
  });

  transaction.add(
    SystemProgram.createAccountWithSeed({
      fromPubkey: owner,
      basePubkey: owner,
      seed,
      newAccountPubkey: mint,
      lamports: mintBaseRentLamports,
      space: mintBaseSpace,
      programId: TOKEN_2022_PROGRAM_ID,
    }),
    // Token-2022 extensions must be initialized in canonical type order.
    // NonTransferable (9) comes before MetadataPointer (18).
    createInitializeNonTransferableMintInstruction(mint, TOKEN_2022_PROGRAM_ID),
    createInitializeMetadataPointerInstruction(
      mint,
      null,
      mint,
      TOKEN_2022_PROGRAM_ID,
    ),
    createInitializeMint2Instruction(
      mint,
      0,
      owner,
      owner,
      TOKEN_2022_PROGRAM_ID,
    ),
  );

  if (metadataRentTopUpLamports > 0) {
    transaction.add(
      SystemProgram.transfer({
        fromPubkey: owner,
        toPubkey: mint,
        lamports: metadataRentTopUpLamports,
      }),
    );
  }

  transaction.add(
    createInitializeTokenMetadataInstruction({
      programId: TOKEN_2022_PROGRAM_ID,
      metadata: mint,
      updateAuthority: owner,
      mint,
      mintAuthority: owner,
      name: tokenMetadata.name,
      symbol: tokenMetadata.symbol,
      uri: tokenMetadata.uri,
    }),
  );

  for (const [field, value] of tokenMetadata.additionalMetadata) {
    transaction.add(
      createUpdateTokenMetadataFieldInstruction({
        programId: TOKEN_2022_PROGRAM_ID,
        metadata: mint,
        updateAuthority: owner,
        field,
        value,
      }),
    );
  }

  transaction.add(
    createAssociatedTokenAccountInstruction(
      owner,
      ata,
      owner,
      mint,
      TOKEN_2022_PROGRAM_ID,
    ),
    createMintToInstruction(
      mint,
      ata,
      owner,
      1n,
      [],
      TOKEN_2022_PROGRAM_ID,
    ),
    createSetAuthorityInstruction(
      mint,
      owner,
      AuthorityType.MintTokens,
      null,
      [],
      TOKEN_2022_PROGRAM_ID,
    ),
    createUpdateTokenMetadataAuthorityInstruction({
      programId: TOKEN_2022_PROGRAM_ID,
      metadata: mint,
      oldAuthority: owner,
      newAuthority: null,
    }),
  );

  const serialized = transaction.serialize({
    requireAllSignatures: false,
    verifySignatures: false,
  }).toString('base64');

  return {
    alreadyExists: false,
    transactionBase64: serialized,
    blockhash: latest.blockhash,
    lastValidBlockHeight: latest.lastValidBlockHeight,
    mintAddress,
    ataAddress: ata.toBase58(),
    metadataUri,
    tokenMetadata: {
      name: tokenMetadata.name,
      symbol: tokenMetadata.symbol,
      uri: tokenMetadata.uri,
      additionalMetadata: tokenMetadata.additionalMetadata,
      updateAuthority: null,
    },
    rpcEndpoint: SOLANA_RPC_URL,
    seed,
  };
}

async function verifyPassportMintOnChain({
  ownerPublicKey,
  agentPublicKey,
  mintAddress,
  metadataUriExpected = null,
  txSignature = null,
}) {
  const connection = solanaConnection();
  const owner = new PublicKey(ownerPublicKey);
  const expected = await derivePassportMintAddress(ownerPublicKey, agentPublicKey);
  if (expected.mintAddress !== mintAddress) {
    return {
      ok: false,
      status: 400,
      error: 'Mint address does not match deterministic passport mint',
      code: 'MINT_MISMATCH',
    };
  }

  const mint = new PublicKey(mintAddress);
  const mintInfo = await connection.getAccountInfo(mint, 'confirmed');
  if (!mintInfo) {
    return { ok: false, status: 400, error: 'Mint account not found on-chain', code: 'MINT_NOT_FOUND' };
  }
  if (!mintInfo.owner.equals(TOKEN_2022_PROGRAM_ID)) {
    return { ok: false, status: 400, error: 'Mint account is not Token-2022', code: 'INVALID_MINT_OWNER' };
  }

  let mintState;
  try {
    mintState = await getMint(connection, mint, 'confirmed', TOKEN_2022_PROGRAM_ID);
  } catch (err) {
    return {
      ok: false,
      status: 400,
      error: `Unable to decode mint state: ${err.message}`,
      code: 'MINT_DECODE_FAILED',
    };
  }

  const nonTransferable = getNonTransferable(mintState) !== null;
  if (!nonTransferable) {
    return {
      ok: false,
      status: 400,
      error: 'Mint does not include NonTransferable extension',
      code: 'NON_TRANSFERABLE_MISSING',
    };
  }
  const metadataPointer = getMetadataPointerState(mintState);
  if (!metadataPointer || !metadataPointer.metadataAddress) {
    return {
      ok: false,
      status: 400,
      error: 'Mint metadata pointer extension is missing',
      code: 'METADATA_POINTER_MISSING',
    };
  }
  if (metadataPointer.metadataAddress.toBase58() !== mintAddress) {
    return {
      ok: false,
      status: 400,
      error: 'Mint metadata pointer does not point to mint account',
      code: 'METADATA_POINTER_MISMATCH',
    };
  }
  if (mintState.decimals !== 0) {
    return {
      ok: false,
      status: 400,
      error: 'Passport mint must have 0 decimals',
      code: 'INVALID_DECIMALS',
    };
  }
  if (mintState.mintAuthority !== null) {
    return {
      ok: false,
      status: 400,
      error: 'Passport mint authority must be revoked',
      code: 'MINT_AUTHORITY_ACTIVE',
    };
  }

  let tokenMetadata;
  try {
    tokenMetadata = await getTokenMetadata(connection, mint, 'confirmed', TOKEN_2022_PROGRAM_ID);
  } catch (err) {
    return {
      ok: false,
      status: 400,
      error: `Unable to decode token metadata: ${err.message}`,
      code: 'TOKEN_METADATA_DECODE_FAILED',
    };
  }
  if (!tokenMetadata) {
    return {
      ok: false,
      status: 400,
      error: 'Token metadata extension is missing',
      code: 'TOKEN_METADATA_MISSING',
    };
  }
  if (!tokenMetadata.name || !tokenMetadata.symbol || !tokenMetadata.uri) {
    return {
      ok: false,
      status: 400,
      error: 'Token metadata is incomplete',
      code: 'TOKEN_METADATA_INCOMPLETE',
    };
  }
  if (metadataUriExpected && !metadataUriSemanticallyMatches(tokenMetadata.uri, metadataUriExpected)) {
    return {
      ok: false,
      status: 400,
      error: 'Token metadata URI mismatch',
      code: 'TOKEN_METADATA_URI_MISMATCH',
    };
  }
  if (tokenMetadata.symbol !== PASSPORT_SYMBOL) {
    return {
      ok: false,
      status: 400,
      error: 'Token metadata symbol mismatch',
      code: 'TOKEN_METADATA_SYMBOL_MISMATCH',
    };
  }
  const metadataMap = new Map((tokenMetadata.additionalMetadata || []).map((entry) => [entry[0], entry[1]]));
  if (metadataMap.get('sigil_standard') !== 'sigil-passport-v1') {
    return {
      ok: false,
      status: 400,
      error: 'Token metadata protocol standard marker is missing or invalid',
      code: 'TOKEN_METADATA_STANDARD_MISMATCH',
    };
  }
  if (metadataMap.get('sigil_agent') !== agentPublicKey) {
    return {
      ok: false,
      status: 400,
      error: 'Token metadata agent field mismatch',
      code: 'TOKEN_METADATA_AGENT_MISMATCH',
    };
  }
  if (metadataMap.get('sigil_soulbound') !== 'true') {
    return {
      ok: false,
      status: 400,
      error: 'Token metadata soulbound marker missing',
      code: 'TOKEN_METADATA_SOULBOUND_MISSING',
    };
  }
  if (PASSPORT_COLLECTION && metadataMap.get('sigil_collection') !== PASSPORT_COLLECTION) {
    return {
      ok: false,
      status: 400,
      error: 'Token metadata collection marker mismatch',
      code: 'TOKEN_METADATA_COLLECTION_MISMATCH',
    };
  }
  if (tokenMetadata.updateAuthority) {
    return {
      ok: false,
      status: 400,
      error: 'Token metadata update authority must be revoked',
      code: 'TOKEN_METADATA_AUTHORITY_ACTIVE',
    };
  }

  const ata = getAssociatedTokenAddressSync(mint, owner, false, TOKEN_2022_PROGRAM_ID);
  const tokenAccounts = await connection.getParsedTokenAccountsByOwner(
    owner,
    { mint },
    'confirmed',
  );
  const minted = tokenAccounts.value.some((row) => tokenAccountAmountFromParsed(row.account) > 0n);
  if (!minted) {
    return {
      ok: false,
      status: 400,
      error: 'Owner does not hold minted passport token',
      code: 'TOKEN_NOT_HELD',
    };
  }

  if (txSignature) {
    const sig = normalizeSolanaSignature(txSignature);
    if (!sig) {
      return { ok: false, status: 400, error: 'Invalid txSignature format', code: 'INVALID_TX' };
    }
    const tx = await connection.getTransaction(sig, {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0,
    });
    if (!tx) {
      return { ok: false, status: 400, error: 'Transaction signature not found', code: 'TX_NOT_FOUND' };
    }
    const message = tx.transaction.message;
    const keys = 'staticAccountKeys' in message
      ? message.staticAccountKeys.map((k) => k.toBase58())
      : message.accountKeys.map((k) => k.toBase58());
    if (!keys.includes(mintAddress)) {
      return { ok: false, status: 400, error: 'Transaction does not include expected mint', code: 'TX_MINT_MISMATCH' };
    }
  }

  return {
    ok: true,
    ataAddress: ata.toBase58(),
    mint: {
      nonTransferable,
      decimals: mintState.decimals,
      supply: mintState.supply?.toString?.() ?? String(mintState.supply ?? ''),
      mintAuthority: mintState.mintAuthority ? mintState.mintAuthority.toBase58() : null,
      freezeAuthority: mintState.freezeAuthority ? mintState.freezeAuthority.toBase58() : null,
    },
    metadata: {
      name: tokenMetadata.name,
      symbol: tokenMetadata.symbol,
      uri: tokenMetadata.uri,
      updateAuthority: tokenMetadata.updateAuthority ? tokenMetadata.updateAuthority.toBase58() : null,
      additionalMetadata: tokenMetadata.additionalMetadata || [],
      collection: PASSPORT_COLLECTION,
    },
  };
}

function verifyReceiptSpine(agentDbId) {
  const rows = getDb().prepare(
    'SELECT seq, receipt_hash, prev_hash FROM receipts WHERE agent_id = ? ORDER BY seq ASC'
  ).all(agentDbId);

  if (!rows.length) {
    return {
      ok: true,
      checked: 0,
      reason: 'no-receipts',
    };
  }

  for (let i = 0; i < rows.length; i += 1) {
    const current = rows[i];
    if (i > 0) {
      const previous = rows[i - 1];
      if (current.seq !== previous.seq + 1) {
        return {
          ok: false,
          checked: i + 1,
          reason: 'seq-gap',
          failedAtSeq: current.seq,
          expectedSeq: previous.seq + 1,
        };
      }
      if ((current.prev_hash || null) !== previous.receipt_hash) {
        return {
          ok: false,
          checked: i + 1,
          reason: 'prev-hash-mismatch',
          failedAtSeq: current.seq,
        };
      }
    }
  }

  return {
    ok: true,
    checked: rows.length,
    headSeq: rows[rows.length - 1].seq,
  };
}

function verifyLatestAnchorIntegrity(agentDbId) {
  const latest = getLatestAnchor(agentDbId);
  if (!latest) {
    return {
      ok: true,
      anchored: false,
      reason: 'no-anchors',
    };
  }

  const recomputed = buildAnchorForRange(
    agentDbId,
    Number(latest.range_start),
    Number(latest.range_end),
  );

  if (!recomputed.ok) {
    return {
      ok: false,
      anchored: true,
      reason: recomputed.code || 'anchor-recompute-failed',
      message: recomputed.message,
      latest: {
        root: latest.merkle_root,
        startSeq: latest.range_start,
        endSeq: latest.range_end,
      },
    };
  }

  const rootMatches = String(recomputed.merkleRoot).toLowerCase() === String(latest.merkle_root).toLowerCase();
  const countMatches = Number(recomputed.receiptCount) === Number(latest.receipt_count);
  return {
    ok: rootMatches && countMatches,
    anchored: true,
    reason: rootMatches && countMatches ? 'verified' : 'anchor-mismatch',
    latest: {
      root: latest.merkle_root,
      startSeq: latest.range_start,
      endSeq: latest.range_end,
      count: latest.receipt_count,
      createdAt: latest.created_at,
      txSignature: latest.tx_signature,
    },
    recomputed: {
      root: recomputed.merkleRoot,
      count: recomputed.receiptCount,
    },
  };
}

async function verifyPassportRecord(agent, record) {
  if (!record) {
    return {
      exists: false,
      ok: true,
      reason: 'not-issued',
    };
  }

  if (isLegacySimulatedPassportRecord(record)) {
    return {
      exists: true,
      ok: false,
      reason: 'legacy_simulated',
      status: 'legacy_simulated',
      mintAddress: record.mint_address,
      ownerPublicKey: record.owner_public_key,
    };
  }

  if (record.status !== 'minted' || !record.mint_address || !record.owner_public_key) {
    return {
      exists: true,
      ok: false,
      reason: 'record-incomplete',
      status: record.status,
      mintAddress: record.mint_address,
      ownerPublicKey: record.owner_public_key,
    };
  }

  if (!isValidPublicKey(record.mint_address) || !isValidPublicKey(record.owner_public_key)) {
    return {
      exists: true,
      ok: false,
      reason: 'record-invalid-key',
      status: record.status,
      mintAddress: record.mint_address,
      ownerPublicKey: record.owner_public_key,
    };
  }

  const onChain = await verifyPassportMintOnChain({
    ownerPublicKey: record.owner_public_key,
    agentPublicKey: agent.public_key,
    mintAddress: record.mint_address,
    metadataUriExpected: record.metadata_uri || null,
    txSignature: record.tx_signature,
  });

  if (!onChain.ok) {
    return {
      exists: true,
      ok: false,
      reason: onChain.code,
      error: onChain.error,
      mintAddress: record.mint_address,
      ownerPublicKey: record.owner_public_key,
      txSignature: record.tx_signature,
    };
  }

  return {
    exists: true,
    ok: true,
    reason: 'verified',
    mintAddress: record.mint_address,
    ownerPublicKey: record.owner_public_key,
    txSignature: record.tx_signature,
    ataAddress: onChain.ataAddress,
    mint: onChain.mint,
  };
}

async function buildAgentVerificationPayload({ publicKey, requirePassport, req }) {
  const agent = findAgentByPublicKey(publicKey);
  if (!agent) {
    return {
      ok: false,
      status: 404,
      error: 'Agent not found',
      code: 'NOT_FOUND',
    };
  }

  const refreshed = recalcAgentState(publicKey) || agent;
  const glyphExpected = generateGlyphHash(refreshed.public_key);
  const identity = {
    status: refreshed.status,
    verified: refreshed.status === 'verified',
    glyphHashStored: refreshed.glyph_hash,
    glyphHashExpected: glyphExpected,
    glyphHashMatches: refreshed.glyph_hash === glyphExpected,
    verifiedAt: refreshed.verified_at,
  };

  const receipts = verifyReceiptSpine(refreshed.id);
  const anchors = verifyLatestAnchorIntegrity(refreshed.id);
  const passportRecord = getPassportByAgent(refreshed.id);
  const passport = await verifyPassportRecord(refreshed, passportRecord);

  const criticalChecks = [
    { key: 'identity.verified', pass: identity.verified },
    { key: 'identity.glyph_hash_match', pass: identity.glyphHashMatches },
    { key: 'receipts.spine', pass: receipts.ok },
    { key: 'anchors.latest', pass: anchors.ok },
  ];
  if (requirePassport) {
    criticalChecks.push({
      key: 'passport.on_chain',
      pass: Boolean(passport.exists) && passport.ok,
    });
  }

  const passed = criticalChecks.filter((item) => item.pass).length;
  const failed = criticalChecks.length - passed;

  return {
    ok: true,
    payload: {
      publicKey: refreshed.public_key,
      agentId: refreshed.agent_id,
      displayName: refreshed.display_name,
      attestation: {
        checkedAt: nowIso(),
        requirePassport,
        criticalChecks,
        passed,
        failed,
        criticalPass: failed === 0,
      },
      identity,
      receipts,
      anchors,
      passport,
      staking: {
        totalStaked: Number(refreshed.stake_amount || 0),
        stakerCount: Number(refreshed.staker_count || 0),
        tier: Number(refreshed.tier || 0),
        persistenceScore: Number(refreshed.persistence_score || 0),
      },
      profileUrl: `${baseUrlFromReq(req)}/agent.html?key=${encodeURIComponent(refreshed.public_key)}`,
      docs: {
        verificationApi: `${baseUrlFromReq(req)}/api/verification/agent/${encodeURIComponent(refreshed.public_key)}?requirePassport=1`,
        compactApi: `${baseUrlFromReq(req)}/api/verification/agent/${encodeURIComponent(refreshed.public_key)}/compact?requirePassport=1`,
        badgeSvg: `${baseUrlFromReq(req)}/api/verification/badge/${encodeURIComponent(refreshed.public_key)}.svg?requirePassport=1`,
      },
    },
  };
}

function buildVerificationBadgeSvg({
  publicKey,
  displayName,
  criticalPass,
  requirePassport,
  failedChecks = [],
  checkedAt,
}) {
  const status = criticalPass ? 'PASS' : 'FAIL';
  const statusBg = criticalPass ? '#0f241d' : '#2a1414';
  const statusStroke = criticalPass ? '#4ade80' : '#f87171';
  const statusText = criticalPass ? '#5df0a5' : '#ff8f8f';
  const detail = criticalPass
    ? (requirePassport ? 'Identity + receipts + anchors + passport' : 'Identity + receipts + anchors')
    : (failedChecks[0] || 'verification_failed');
  const safeName = escapeSvgText(displayName || `${publicKey.slice(0, 8)}...${publicKey.slice(-8)}`);
  const safePub = escapeSvgText(publicKey);
  const safeCheckedAt = escapeSvgText(checkedAt || nowIso());
  const safeDetail = escapeSvgText(detail);

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="700" height="132" viewBox="0 0 700 132" role="img" aria-label="SIGIL verification badge">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#0b1111"/>
      <stop offset="100%" stop-color="#101919"/>
    </linearGradient>
  </defs>
  <rect x="1" y="1" width="698" height="130" rx="10" fill="url(#bg)" stroke="#2f4540" />
  <rect x="1" y="1" width="188" height="130" rx="10" fill="#0b1413" stroke="#2f4540" />
  <text x="18" y="38" font-family="'Spline Sans Mono', 'IBM Plex Mono', monospace" font-size="16" fill="#8bb8ad" letter-spacing="0.12em">SIGIL</text>
  <text x="18" y="64" font-family="'Spline Sans Mono', 'IBM Plex Mono', monospace" font-size="14" fill="#b7d8d0" letter-spacing="0.08em">AGENT VERIFY</text>
  <text x="18" y="92" font-family="'Public Sans', sans-serif" font-size="12" fill="#8ea39e">${safeName}</text>

  <rect x="212" y="16" width="112" height="34" rx="8" fill="${statusBg}" stroke="${statusStroke}" />
  <text x="268" y="38" text-anchor="middle" font-family="'Spline Sans Mono', 'IBM Plex Mono', monospace" font-size="16" fill="${statusText}">${status}</text>

  <text x="338" y="38" font-family="'Public Sans', sans-serif" font-size="13" fill="#bdd6d1">${safeDetail}</text>
  <text x="212" y="70" font-family="'Spline Sans Mono', 'IBM Plex Mono', monospace" font-size="11" fill="#7e9590">PUBLIC KEY</text>
  <text x="212" y="89" font-family="'Spline Sans Mono', 'IBM Plex Mono', monospace" font-size="11" fill="#c0ddd7">${safePub}</text>
  <text x="212" y="114" font-family="'Spline Sans Mono', 'IBM Plex Mono', monospace" font-size="10" fill="#68827c">checked ${safeCheckedAt}</text>
</svg>`;
}

function recalcAgentState(publicKey) {
  const agent = findAgentByPublicKey(publicKey);
  if (!agent) return null;

  const receiptCount = getReceiptCount(agent.id);
  const anchorCount = getAnchorCount(agent.id);
  const staking = aggregateAgentStaking(agent.id);

  const tier = calculateTier({
    verified: agent.status === 'verified',
    totalStaked: staking.totalStaked,
    stakerCount: staking.stakerCount,
    interactions30d: receiptCount,
  });

  const persistence = calculatePersistenceScore({
    verifiedAt: agent.verified_at,
    receiptCount,
    anchorCount,
    totalStaked: staking.totalStaked,
    stakerCount: staking.stakerCount,
  });

  updateAgentStakeSnapshot(publicKey, staking.totalStaked, staking.stakerCount, tier);
  updateAgentReputation(publicKey, { persistenceScore: persistence, tier });

  return {
    ...findAgentByPublicKey(publicKey),
    receiptCount,
    anchorCount,
    staking,
  };
}

function formatAgentPayload(agent, req, extra = {}) {
  const baseUrl = baseUrlFromReq(req);
  return {
    publicKey: agent.public_key,
    agentId: agent.agent_id,
    displayName: agent.display_name,
    glyphHash: agent.glyph_hash,
    tier: agent.tier,
    status: agent.status,
    stakeAmount: Number(agent.stake_amount || 0),
    stakerCount: Number(agent.staker_count || 0),
    persistenceScore: Number(agent.persistence_score || 0),
    verifiedAt: agent.verified_at,
    lastReceiptAt: agent.last_receipt_at,
    createdAt: agent.created_at,
    metadata: parseMetadata(agent.metadata),
    profileUrl: `${baseUrl}/agent.html?key=${encodeURIComponent(agent.public_key)}`,
    glyphUrl: `${baseUrl}/api/glyph/${encodeURIComponent(agent.public_key)}`,
    ...extra,
  };
}

function ensureGlyphCacheDir() {
  if (!existsSync(GLYPHS_DIR)) mkdirSync(GLYPHS_DIR, { recursive: true });
}

function keylessRegistration(displayName) {
  const { publicKey: pubKeyObj, privateKey: privKeyObj } = crypto.generateKeyPairSync('ed25519');
  const publicKeyRaw = pubKeyObj.export({ type: 'spki', format: 'der' }).slice(-32);
  const publicKey = toBase58(publicKeyRaw);
  const nonce = crypto.randomBytes(16).toString('hex');

  const challengeMessage = `SIGIL Proof of Agency: ${nonce}`;
  const signature = crypto.sign(null, Buffer.from(challengeMessage), privKeyObj);
  const valid = crypto.verify(null, Buffer.from(challengeMessage), pubKeyObj, signature);
  if (!valid) throw new Error('Generated keypair failed self-verification');

  let agent = findAgentByPublicKey(publicKey);
  if (!agent) {
    createAgent(publicKey, displayName, createAgentSlug(displayName, publicKey));
    agent = findAgentByPublicKey(publicKey);
  }

  const glyphHash = generateGlyphHash(publicKey);
  verifyAgent(publicKey, glyphHash);
  agent = findAgentByPublicKey(publicKey);

  const receipt = issueSystemReceipt(agent, 'registration', {
    intentHash: crypto.createHash('sha256').update(`register:${publicKey}`).digest('hex'),
    actionRef: 'sigil://register/keyless',
    resultHash: crypto.createHash('sha256').update(`verified:${agent.verified_at}`).digest('hex'),
    payload: { method: 'keyless', nonce },
  });

  logEvent('registration_started', { publicKey, displayName });
  logEvent('agent_verified', {
    agentId: agent.id,
    publicKey,
    displayName,
    glyphHash,
    detail: `Keyless registration. Receipt: ${receipt.hash}`,
  });

  return { agent: findAgentByPublicKey(publicKey), receipt, publicKey };
}

app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}));

app.use(cors({
  origin(origin, cb) {
    if (!origin) return cb(null, true);
    if (corsOrigins.has(origin)) return cb(null, true);
    return cb(new Error('CORS origin denied'));
  },
  methods: ['GET', 'POST', 'PATCH'],
  allowedHeaders: ['Content-Type'],
  maxAge: 86400,
}));

app.use(express.json({ limit: '64kb' }));
app.use(maxBodySize(64 * 1024));
app.use(globalLimit);

app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path} ${res.statusCode} ${duration}ms`);
  });
  next();
});

app.get('/api/health', (req, res) => {
  const readiness = getProtocolReadiness();
  res.json({
    status: 'operational',
    uptime: Math.floor((Date.now() - startTime) / 1000),
    version: VERSION,
    chain: 'solana',
    network: process.env.SOLANA_NETWORK || 'mainnet-beta',
    productionReady: readiness.productionReady,
    features: {
      registration: true,
      receipts: true,
      anchors: true,
      staking: true,
      passports: true,
      actionChallenges: true,
      passportOnChainMint: readiness.passport.runtimeReady,
      passportCollectionConfigured: readiness.passport.collectionConfigured,
      agentVerification: true,
      verificationBadge: true,
      stakingOnChainEnabled: STAKING_ONCHAIN_ENABLED,
      stakingOnChainReady: readiness.staking.runtimeReady,
      stakingProgramConfigured: readiness.staking.canonicalProgramConfigured,
    },
  });
});

app.get('/api/config', (req, res) => {
  const readiness = getProtocolReadiness();
  res.json({
    protocolVersion: VERSION,
    network: process.env.SOLANA_NETWORK || 'mainnet-beta',
    productionReady: readiness.productionReady,
    staking: {
      minStake: MIN_STAKE,
      maxStake: MAX_STAKE,
      cooldownDays: COOLDOWN_DAYS,
      emergencySlashBps: EMERGENCY_SLASH_BPS,
      onChain: STAKING_ONCHAIN_ENABLED,
      mintAddress: STAKING_MINT_ADDRESS,
      tokenProgramId: STAKING_TOKEN_PROGRAM_ID.toBase58(),
      vaultOwnerPublicKey: (() => {
        try {
          const owner = stakingVaultOwnerPublicKey();
          return owner ? owner.toBase58() : null;
        } catch {
          return null;
        }
      })(),
      withdrawalsEnabled: Boolean(STAKING_AUTHORITY_SECRET),
    },
    passport: {
      tokenProgramId: TOKEN_2022_PROGRAM_ID.toBase58(),
      symbol: PASSPORT_SYMBOL,
      legacyIssueEnabled: LEGACY_PASSPORT_ISSUE_ENABLED,
      onChainMetadata: true,
      metadataImmutable: true,
      collectionAddress: PASSPORT_COLLECTION,
    },
    addresses: {
      sigilMint: STAKING_MINT_ADDRESS,
      stakingProgramId: STAKING_PROGRAM_ID,
      passportCollection: PASSPORT_COLLECTION,
      token2022ProgramId: TOKEN_2022_PROGRAM_ID.toBase58(),
      rpcEndpoint: SOLANA_RPC_URL,
    },
    readiness: {
      productionReady: readiness.productionReady,
      checks: readiness.checks,
      blocking: readiness.blocking,
    },
  });
});

app.get('/api/readiness', (req, res) => {
  const readiness = getProtocolReadiness();
  res.json({
    version: VERSION,
    network: process.env.SOLANA_NETWORK || 'mainnet-beta',
    productionReady: readiness.productionReady,
    staking: readiness.staking,
    passport: readiness.passport,
    checks: readiness.checks,
    blocking: readiness.blocking,
  });
});

app.get('/api/events', relaxedLimit, (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit || 20), 100);
    const events = getRecentEvents(limit);
    res.json({
      events: events.map((e) => ({
        id: e.id,
        type: e.event_type,
        publicKey: e.public_key,
        displayName: e.display_name,
        glyphHash: e.glyph_hash,
        detail: e.detail,
        createdAt: e.created_at,
      })),
    });
  } catch (err) {
    console.error('[EVENTS ERROR]', err);
    res.status(500).json({ error: 'Internal server error', code: 'INTERNAL' });
  }
});

app.get('/api/stats', (req, res) => {
  try {
    const stats = getAgentStats();
    res.json({
      ...stats,
      protocolVersion: VERSION,
    });
  } catch (err) {
    console.error('[STATS ERROR]', err);
    res.status(500).json({ error: 'Internal server error', code: 'INTERNAL' });
  }
});

app.get('/api/register', (req, res) => {
  res.json({
    endpoint: 'POST /api/register',
    description: 'Register your autonomous agent on SIGIL Protocol.',
    flows: {
      keyless: 'POST /api/register with {"displayName":"my-agent"}',
      wallet: 'POST /api/register with {"publicKey":"...","displayName":"my-agent"} then POST /api/verify',
    },
    protocol: `SIGIL v${VERSION}`,
  });
});

app.post('/api/auth/action-challenge', actionChallengeLimit, (req, res) => {
  try {
    const {
      publicKey,
      scope,
      action,
      payload,
      sessionId,
      domain,
    } = req.body || {};
    const requestOrigin = requestOriginFromReq(req);

    const validation = validateActionChallengeInput({
      publicKey,
      scope,
      action,
      payload,
      sessionId,
      domain,
      requestOrigin,
    });
    if (!validation.ok) {
      return res.status(validation.status).json({ error: validation.error, code: validation.code });
    }

    const challenge = issueActionChallenge({
      publicKey,
      scope,
      action,
      payload,
      sessionId: validation.sessionId,
      domain: validation.domain,
      requestOrigin,
    });

    return res.json({
      challenge: {
        nonce: challenge.nonce,
        message: challenge.message,
        expiresAt: challenge.expiresAt,
      },
    });
  } catch (err) {
    console.error('[ACTION CHALLENGE ERROR]', err);
    return res.status(500).json({ error: 'Internal server error', code: 'INTERNAL' });
  }
});

app.post('/api/register/agent', moderateLimit, (req, res) => {
  try {
    const displayName = normalizeDisplayName(req.body?.displayName);
    if (!displayName) {
      return res.status(400).json({
        error: 'displayName is required (2-64 characters)',
        code: 'INVALID_NAME',
      });
    }

    const { agent, receipt, publicKey } = keylessRegistration(displayName);
    const refreshed = recalcAgentState(publicKey) || agent;

    res.json({
      success: true,
      message: 'Agent registered and verified via keyless proof-of-agency flow',
      agent: formatAgentPayload(refreshed, req),
      receipt,
      keys: {
        publicKey,
      },
    });
  } catch (err) {
    console.error('[KEYLESS REGISTER ERROR]', err);
    res.status(500).json({ error: 'Internal server error', code: 'INTERNAL' });
  }
});

app.post('/api/register', moderateLimit, (req, res) => {
  try {
    const displayName = normalizeDisplayName(req.body?.displayName);
    const publicKey = req.body?.publicKey;

    // Keyless flow.
    if (!publicKey) {
      if (!displayName) {
        return res.status(400).json({
          error: 'displayName is required (2-64 characters)',
          code: 'INVALID_NAME',
        });
      }

      const { agent, receipt, publicKey: generatedKey } = keylessRegistration(displayName);
      const refreshed = recalcAgentState(generatedKey) || agent;

      return res.json({
        success: true,
        agent: formatAgentPayload(refreshed, req),
        receipt,
        keys: {
          publicKey: generatedKey,
        },
      });
    }

    // Wallet flow.
    if (!isValidPublicKey(publicKey)) {
      return res.status(400).json({ error: 'Invalid public key format', code: 'INVALID_KEY' });
    }

    let agent = findAgentByPublicKey(publicKey);
    if (agent && agent.status === 'verified') {
      const refreshed = recalcAgentState(publicKey) || agent;
      return res.json({
        message: 'Agent already verified',
        agent: formatAgentPayload(refreshed, req),
      });
    }

    if (!agent) {
      const normalizedName = displayName || `agent-${publicKey.slice(0, 6).toLowerCase()}`;
      createAgent(publicKey, normalizedName, createAgentSlug(normalizedName, publicKey));
      logEvent('registration_started', { publicKey, displayName: normalizedName });
      agent = findAgentByPublicKey(publicKey);
    }

    const challenge = generateChallenge();
    dbCreateChallenge(publicKey, challenge.nonce, challenge.message, challenge.expiresAt);
    logEvent('challenge_issued', { publicKey, displayName: agent.display_name });

    return res.json({
      challenge: {
        nonce: challenge.nonce,
        message: challenge.message,
        expiresAt: challenge.expiresAt,
      },
    });
  } catch (err) {
    console.error('[REGISTER ERROR]', err);
    return res.status(500).json({ error: 'Internal server error', code: 'INTERNAL' });
  }
});

app.post('/api/verify', moderateLimit, (req, res) => {
  try {
    const { publicKey, nonce, signature } = req.body || {};

    if (!publicKey || !nonce || !signature) {
      return res.status(400).json({
        error: 'publicKey, nonce, and signature are required',
        code: 'INVALID_INPUT',
      });
    }
    if (!isValidPublicKey(publicKey)) {
      return res.status(400).json({ error: 'Invalid public key format', code: 'INVALID_KEY' });
    }

    const challenge = findChallengeByNonce(nonce);
    if (!challenge) return res.status(404).json({ error: 'Challenge not found', code: 'NOT_FOUND' });
    if (challenge.public_key !== publicKey) {
      return res.status(400).json({ error: 'Public key mismatch', code: 'INVALID_KEY' });
    }
    if (challenge.status === 'completed') {
      return res.status(400).json({ error: 'Challenge already used', code: 'ALREADY_VERIFIED' });
    }
    if (isChallengeExpired(challenge.expires_at)) {
      return res.status(400).json({ error: 'Challenge expired', code: 'CHALLENGE_EXPIRED' });
    }

    const valid = verifySignature(challenge.message, signature, publicKey);
    if (!valid) {
      return res.status(400).json({ error: 'Invalid signature', code: 'INVALID_SIGNATURE' });
    }

    const glyphHash = generateGlyphHash(publicKey);
    verifyAgent(publicKey, glyphHash);
    completeChallenge(nonce);

    const agent = findAgentByPublicKey(publicKey);
    const receipt = issueSystemReceipt(agent, 'registration', {
      intentHash: crypto.createHash('sha256').update(`register:${publicKey}`).digest('hex'),
      actionRef: 'sigil://register/wallet',
      resultHash: crypto.createHash('sha256').update(`verified:${agent.verified_at}`).digest('hex'),
      payload: { nonce, method: 'wallet' },
    });

    recalcAgentState(publicKey);

    logEvent('agent_verified', {
      agentId: agent.id,
      publicKey,
      displayName: agent.display_name,
      glyphHash,
      detail: `Receipt: ${receipt.hash}`,
    });

    const refreshed = findAgentByPublicKey(publicKey);
    return res.json({
      agent: formatAgentPayload(refreshed, req),
      receipt,
    });
  } catch (err) {
    console.error('[VERIFY ERROR]', err);
    return res.status(500).json({ error: 'Internal server error', code: 'INTERNAL' });
  }
});

app.get('/api/agent/:publicKey', relaxedLimit, (req, res) => {
  try {
    const { publicKey } = req.params;
    const agent = findAgentByPublicKey(publicKey);
    if (!agent) return res.status(404).json({ error: 'Agent not found', code: 'NOT_FOUND' });

    const refreshed = recalcAgentState(publicKey) || agent;
    const receiptCount = getReceiptCount(agent.id);
    const latestReceipt = getLatestReceipt(agent.id);
    const anchorCount = getAnchorCount(agent.id);
    const latestAnchor = getLatestAnchor(agent.id);
    const passport = getPassportByAgent(agent.id);

    return res.json({
      agent: formatAgentPayload(refreshed, req),
      receipts: {
        count: receiptCount,
        latest: latestReceipt ? {
          seq: latestReceipt.seq,
          hash: latestReceipt.receipt_hash,
          type: latestReceipt.receipt_type,
          createdAt: latestReceipt.created_at,
        } : null,
      },
      anchors: {
        count: anchorCount,
        latest: latestAnchor ? {
          root: latestAnchor.merkle_root,
          startSeq: latestAnchor.range_start,
          endSeq: latestAnchor.range_end,
          count: latestAnchor.receipt_count,
          createdAt: latestAnchor.created_at,
          txSignature: latestAnchor.tx_signature,
        } : null,
      },
      passport: passport ? {
        mintAddress: passport.mint_address,
        metadataUri: passport.metadata_uri,
        imageUri: passport.image_uri,
        status: passport.status,
        mintedAt: passport.minted_at,
      } : null,
    });
  } catch (err) {
    console.error('[AGENT ERROR]', err);
    return res.status(500).json({ error: 'Internal server error', code: 'INTERNAL' });
  }
});

app.patch('/api/agent/:publicKey', moderateLimit, (req, res) => {
  try {
    const { publicKey } = req.params;
    const { metadata } = req.body || {};
    if (!metadata || typeof metadata !== 'object') {
      return res.status(400).json({ error: 'metadata object is required', code: 'INVALID_INPUT' });
    }

    const agent = findAgentByPublicKey(publicKey);
    if (!agent) return res.status(404).json({ error: 'Agent not found', code: 'NOT_FOUND' });

    const allowed = ['bio', 'avatar', 'website', 'twitter', 'tags', 'capabilities'];
    const cleaned = {};
    for (const key of allowed) {
      if (metadata[key] !== undefined) cleaned[key] = metadata[key];
    }

    updateAgentMetadata(publicKey, cleaned);
    logEvent('metadata_updated', {
      agentId: agent.id,
      publicKey,
      displayName: agent.display_name,
      glyphHash: agent.glyph_hash,
    });

    return res.json({ message: 'Metadata updated', metadata: cleaned });
  } catch (err) {
    console.error('[PATCH AGENT ERROR]', err);
    return res.status(500).json({ error: 'Internal server error', code: 'INTERNAL' });
  }
});

app.get('/api/agents', relaxedLimit, (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit || 50), 500);
    const offset = Math.max(Number(req.query.offset || 0), 0);
    const tier = req.query.tier != null ? Number(req.query.tier) : null;
    const { agents, total } = listVerifiedAgents(limit, offset, Number.isFinite(tier) ? tier : null);

    const payload = agents.map((agent) => formatAgentPayload(agent, req));
    return res.json({ agents: payload, total });
  } catch (err) {
    console.error('[AGENTS ERROR]', err);
    return res.status(500).json({ error: 'Internal server error', code: 'INTERNAL' });
  }
});

app.post('/api/receipts', strictLimit, (req, res) => {
  try {
    const {
      publicKey,
      type = 'action',
      seq,
      timestamp,
      intentHash,
      actionRef,
      resultHash,
      prevReceiptHash = null,
      receiptHash = null,
      signature,
      payload = null,
    } = req.body || {};

    if (!publicKey || !isValidPublicKey(publicKey)) {
      return res.status(400).json({ error: 'Invalid publicKey', code: 'INVALID_KEY' });
    }
    if (!intentHash || !actionRef || !resultHash) {
      return res.status(400).json({
        error: 'intentHash, actionRef, and resultHash are required',
        code: 'INVALID_INPUT',
      });
    }
    if (!Number.isInteger(seq) || seq <= 0) {
      return res.status(400).json({ error: 'seq must be a positive integer', code: 'INVALID_SEQ' });
    }
    if (!signature) {
      return res.status(400).json({ error: 'signature is required', code: 'INVALID_SIGNATURE' });
    }

    const agent = findAgentByPublicKey(publicKey);
    if (!agent || agent.status !== 'verified') {
      return res.status(404).json({ error: 'Verified agent not found', code: 'NOT_FOUND' });
    }

    const canonical = {
      type,
      seq,
      timestamp: timestamp || nowIso(),
      intentHash,
      actionRef,
      resultHash,
      prevReceiptHash,
    };
    const message = buildReceiptPreimage(publicKey, canonical);
    if (!verifySignature(message, signature, publicKey)) {
      return res.status(400).json({ error: 'Signature check failed', code: 'INVALID_SIGNATURE' });
    }

    const saved = storeSignedReceipt(agent, {
      ...canonical,
      receiptHash,
      signature,
      payload,
    });

    if (!saved.ok) {
      return res.status(400).json({ error: saved.message, code: saved.code });
    }

    recalcAgentState(publicKey);
    logEvent('receipt_submitted', {
      agentId: agent.id,
      publicKey,
      displayName: agent.display_name,
      glyphHash: agent.glyph_hash,
      detail: `Receipt seq ${saved.receipt.seq} hash ${saved.receipt.hash.slice(0, 16)}...`,
    });

    return res.json({ receipt: saved.receipt });
  } catch (err) {
    console.error('[RECEIPT ERROR]', err);
    return res.status(500).json({ error: 'Internal server error', code: 'INTERNAL' });
  }
});

app.get('/api/receipts/:publicKey', relaxedLimit, (req, res) => {
  try {
    const { publicKey } = req.params;
    const limit = Math.min(Number(req.query.limit || 50), 250);
    const beforeSeq = req.query.beforeSeq ? Number(req.query.beforeSeq) : null;
    const agent = findAgentByPublicKey(publicKey);
    if (!agent) return res.status(404).json({ error: 'Agent not found', code: 'NOT_FOUND' });

    const rows = listReceiptsByAgent(agent.id, limit, Number.isFinite(beforeSeq) ? beforeSeq : null);
    return res.json({
      publicKey,
      receipts: rows.map((r) => ({
        seq: r.seq,
        type: r.receipt_type,
        hash: r.receipt_hash,
        prevHash: r.prev_hash,
        intentHash: r.intent_hash,
        actionRef: r.action_ref,
        resultHash: r.result_hash,
        signature: r.signature,
        payload: parseMetadata(r.payload),
        createdAt: r.created_at,
      })),
    });
  } catch (err) {
    console.error('[RECEIPTS ERROR]', err);
    return res.status(500).json({ error: 'Internal server error', code: 'INTERNAL' });
  }
});

app.post('/api/anchors', strictLimit, (req, res) => {
  try {
    const {
      publicKey,
      startSeq,
      endSeq,
      root = null,
      txSignature = null,
      evidenceUri = null,
    } = req.body || {};

    if (!publicKey || !isValidPublicKey(publicKey)) {
      return res.status(400).json({ error: 'Invalid publicKey', code: 'INVALID_KEY' });
    }

    const rangeCheck = validateAnchorRange({ startSeq, endSeq });
    if (!rangeCheck.ok) return res.status(400).json({ error: rangeCheck.message, code: rangeCheck.code });

    const agent = findAgentByPublicKey(publicKey);
    if (!agent || agent.status !== 'verified') {
      return res.status(404).json({ error: 'Verified agent not found', code: 'NOT_FOUND' });
    }

    const contiguous = canAnchorRange(agent.id, startSeq);
    if (!contiguous.ok) {
      return res.status(400).json({ error: contiguous.message, code: contiguous.code });
    }

    const built = buildAnchorForRange(agent.id, startSeq, endSeq);
    if (!built.ok) return res.status(400).json({ error: built.message, code: built.code });

    if (root && String(root).toLowerCase() !== built.merkleRoot.toLowerCase()) {
      return res.status(400).json({ error: 'Provided root does not match computed root', code: 'ROOT_MISMATCH' });
    }

    persistAnchor(agent.id, {
      merkleRoot: built.merkleRoot,
      startSeq,
      endSeq,
      receiptCount: built.receiptCount,
      txSignature,
      evidenceUri,
    });

    recalcAgentState(publicKey);
    logEvent('anchor_committed', {
      agentId: agent.id,
      publicKey,
      displayName: agent.display_name,
      glyphHash: agent.glyph_hash,
      detail: `Range ${startSeq}-${endSeq} root ${built.merkleRoot.slice(0, 16)}...`,
    });

    return res.json({
      anchor: {
        root: built.merkleRoot,
        startSeq,
        endSeq,
        count: built.receiptCount,
        txSignature,
      },
    });
  } catch (err) {
    console.error('[ANCHOR ERROR]', err);
    return res.status(500).json({ error: 'Internal server error', code: 'INTERNAL' });
  }
});

app.get('/api/anchors/:publicKey', relaxedLimit, (req, res) => {
  try {
    const { publicKey } = req.params;
    const limit = Math.min(Number(req.query.limit || 25), 100);
    const agent = findAgentByPublicKey(publicKey);
    if (!agent) return res.status(404).json({ error: 'Agent not found', code: 'NOT_FOUND' });

    const rows = listAnchorsByAgent(agent.id, limit);
    return res.json({
      publicKey,
      anchors: rows.map((a) => ({
        root: a.merkle_root,
        startSeq: a.range_start,
        endSeq: a.range_end,
        count: a.receipt_count,
        txSignature: a.tx_signature,
        evidenceUri: a.evidence_uri,
        createdAt: a.created_at,
      })),
    });
  } catch (err) {
    console.error('[ANCHORS ERROR]', err);
    return res.status(500).json({ error: 'Internal server error', code: 'INTERNAL' });
  }
});

app.post('/api/anchors/verify', relaxedLimit, (req, res) => {
  try {
    const { root, leaf, proof = [], index = 0 } = req.body || {};
    if (!root || !leaf) {
      return res.status(400).json({ error: 'root and leaf are required', code: 'INVALID_INPUT' });
    }
    const valid = verifyMerkleProof({ root, leaf, proof, index });
    return res.json({ valid });
  } catch (err) {
    console.error('[ANCHOR VERIFY ERROR]', err);
    return res.status(500).json({ error: 'Internal server error', code: 'INTERNAL' });
  }
});

app.get('/api/staking/positions/:stakerPublicKey', relaxedLimit, (req, res) => {
  try {
    const { stakerPublicKey } = req.params;
    if (!isValidPublicKey(stakerPublicKey)) {
      return res.status(400).json({ error: 'Invalid staker public key', code: 'INVALID_KEY' });
    }

    const rows = listStakePositionsForWallet(stakerPublicKey);
    return res.json({
      stakerPublicKey,
      positions: rows.map((row) => ({
        agentPublicKey: row.agent_public_key,
        agentName: row.agent_display_name,
        tier: row.agent_tier,
        amount: Number(row.amount || 0),
        cooldownAmount: Number(row.cooldown_amount || 0),
        cooldownStartedAt: row.cooldown_started_at,
        lastAction: row.last_action,
        updatedAt: row.updated_at,
      })),
    });
  } catch (err) {
    console.error('[STAKING POSITIONS ERROR]', err);
    return res.status(500).json({ error: 'Internal server error', code: 'INTERNAL' });
  }
});

app.get('/api/leaderboard/top-patrons', relaxedLimit, (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit || 20), 100);
    const patrons = listTopPatrons(limit).map((row) => {
      const totalStaked = Number(row.total_staked || 0);
      const agentsBacked = Number(row.agents_backed || 0);
      const stakeScore = Math.min(totalStaked / 200000, 1) * 40;
      const diversityScore = Math.min(agentsBacked / 10, 1) * 30;
      const durationScore = 20; // Placeholder until duration-weight endpoint is added.
      const patronScore = Math.round(stakeScore + diversityScore + durationScore);
      return {
        stakerPublicKey: row.staker_public_key,
        totalStaked,
        agentsBacked,
        patronScore,
      };
    });
    return res.json({ patrons });
  } catch (err) {
    console.error('[LEADERBOARD PATRONS ERROR]', err);
    return res.status(500).json({ error: 'Internal server error', code: 'INTERNAL' });
  }
});

app.get('/api/leaderboard/rising', relaxedLimit, (req, res) => {
  try {
    const days = Math.min(Math.max(Number(req.query.days || 7), 1), 30);
    const limit = Math.min(Number(req.query.limit || 20), 100);
    const rising = listRisingAgents(days, limit).map((row) => ({
      publicKey: row.public_key,
      displayName: row.display_name,
      tier: row.tier,
      totalStaked: Number(row.stake_amount || 0),
      recentStake: Number(row.recent_stake_7d || 0),
      newStakers: Number(row.new_stakers_7d || 0),
    }));
    return res.json({ days, rising });
  } catch (err) {
    console.error('[LEADERBOARD RISING ERROR]', err);
    return res.status(500).json({ error: 'Internal server error', code: 'INTERNAL' });
  }
});

app.post('/api/staking/stake-prepare', mutationLimit, async (req, res) => {
  try {
    if (!STAKING_ONCHAIN_ENABLED) {
      return res.status(400).json({
        error: 'On-chain staking mode is disabled',
        code: 'STAKING_ONCHAIN_DISABLED',
      });
    }

    const {
      stakerPublicKey,
      agentPublicKey,
      amount,
      signature,
      nonce,
      sessionId,
      domain,
    } = req.body || {};
    const requestOrigin = requestOriginFromReq(req);
    const amountNumber = Number(amount || 0);

    if (!isValidPublicKey(stakerPublicKey) || !isValidPublicKey(agentPublicKey)) {
      return res.status(400).json({ error: 'Invalid public keys', code: 'INVALID_KEY' });
    }
    if (!Number.isFinite(amountNumber) || amountNumber < MIN_STAKE || amountNumber > MAX_STAKE) {
      return res.status(400).json({ error: `Stake amount must be ${MIN_STAKE}-${MAX_STAKE}`, code: 'INVALID_AMOUNT' });
    }

    const agent = findAgentByPublicKey(agentPublicKey);
    if (!agent || agent.status !== 'verified') {
      return res.status(404).json({ error: 'Verified agent not found', code: 'NOT_FOUND' });
    }

    const canonical = { stakerPublicKey, agentPublicKey, amount: amountNumber };
    const auth = consumeActionChallenge({
      publicKey: stakerPublicKey,
      scope: 'staking',
      action: 'stake',
      sessionId,
      domain,
      requestOrigin,
      payload: canonical,
      nonce,
      signature,
    });
    if (!auth.ok) {
      return res.status(auth.status).json({ error: auth.error, code: auth.code });
    }

    const prepared = await buildStakeTransferTransaction({
      stakerPublicKey,
      amountTokens: amountNumber,
    });
    if (!prepared.ok) {
      return res.status(prepared.status).json({ error: prepared.error, code: prepared.code });
    }

    return res.json({
      success: true,
      mode: 'onchain-spl-transfer',
      ...prepared,
    });
  } catch (err) {
    console.error('[STAKING PREPARE ERROR]', err);
    return res.status(500).json({ error: 'Internal server error', code: 'INTERNAL' });
  }
});

app.post('/api/staking/stake-finalize', mutationLimit, async (req, res) => {
  try {
    if (!STAKING_ONCHAIN_ENABLED) {
      return res.status(400).json({
        error: 'On-chain staking mode is disabled',
        code: 'STAKING_ONCHAIN_DISABLED',
      });
    }

    const {
      stakerPublicKey,
      agentPublicKey,
      amount,
      txSignature,
      signature,
      nonce,
      sessionId,
      domain,
    } = req.body || {};
    const requestOrigin = requestOriginFromReq(req);
    const amountNumber = Number(amount || 0);

    if (!isValidPublicKey(stakerPublicKey) || !isValidPublicKey(agentPublicKey)) {
      return res.status(400).json({ error: 'Invalid public keys', code: 'INVALID_KEY' });
    }
    if (!Number.isFinite(amountNumber) || amountNumber < MIN_STAKE || amountNumber > MAX_STAKE) {
      return res.status(400).json({ error: `Stake amount must be ${MIN_STAKE}-${MAX_STAKE}`, code: 'INVALID_AMOUNT' });
    }

    const normalizedTx = normalizeSolanaSignature(txSignature);
    if (!normalizedTx) {
      return res.status(400).json({ error: 'Invalid txSignature format', code: 'INVALID_TX' });
    }
    if (getStakingTxBySignature(normalizedTx)) {
      return res.status(409).json({ error: 'Stake transaction already finalized', code: 'TX_ALREADY_FINALIZED' });
    }

    const agent = findAgentByPublicKey(agentPublicKey);
    if (!agent || agent.status !== 'verified') {
      return res.status(404).json({ error: 'Verified agent not found', code: 'NOT_FOUND' });
    }

    const auth = consumeActionChallenge({
      publicKey: stakerPublicKey,
      scope: 'staking',
      action: 'stake',
      sessionId,
      domain,
      requestOrigin,
      payload: {
        stakerPublicKey,
        agentPublicKey,
        amount: amountNumber,
        txSignature: normalizedTx,
      },
      nonce,
      signature,
    });
    if (!auth.ok) {
      return res.status(auth.status).json({ error: auth.error, code: auth.code });
    }

    const onChain = await verifyStakeTransferOnChain({
      stakerPublicKey,
      amountTokens: amountNumber,
      txSignature: normalizedTx,
    });
    if (!onChain.ok) {
      return res.status(onChain.status).json({ error: onChain.error, code: onChain.code });
    }

    const existingRows = listStakePositionsForWallet(stakerPublicKey)
      .filter((row) => row.agent_public_key === agentPublicKey);
    const existing = existingRows[0] || null;
    const newAmount = Number(existing?.amount || 0) + amountNumber;

    upsertStakePosition({
      stakerPublicKey,
      agentDbId: agent.id,
      amount: newAmount,
      cooldownAmount: Number(existing?.cooldown_amount || 0),
      cooldownStartedAt: existing?.cooldown_started_at || null,
      lastAction: 'stake',
    });

    createStakingTxLedger({
      txSignature: normalizedTx,
      stakerPublicKey,
      agentDbId: agent.id,
      action: 'stake_deposit',
      amount: amountNumber,
    });

    issueSystemReceipt(agent, 'stake.confirm', {
      intentHash: crypto.createHash('sha256').update(`stake:${stakerPublicKey}:${amountNumber}`).digest('hex'),
      actionRef: 'sigil://staking/stake/onchain',
      resultHash: crypto.createHash('sha256').update(`stake_total:${newAmount}`).digest('hex'),
      payload: {
        stakerPublicKey,
        amount: amountNumber,
        txSignature: normalizedTx,
        mintAddress: onChain.mintAddress,
        vaultAtaAddress: onChain.vaultAtaAddress,
      },
    });

    const refreshed = recalcAgentState(agentPublicKey) || findAgentByPublicKey(agentPublicKey);
    logEvent('staking_stake', {
      agentId: agent.id,
      publicKey: agentPublicKey,
      displayName: agent.display_name,
      glyphHash: agent.glyph_hash,
      detail: `On-chain stake tx ${normalizedTx.slice(0, 10)}...`,
    });

    return res.json({
      success: true,
      agent: formatAgentPayload(refreshed, req),
      staking: aggregateAgentStaking(agent.id),
      onChain: {
        txSignature: normalizedTx,
        mintAddress: onChain.mintAddress,
        sourceAtaAddress: onChain.sourceAtaAddress,
        vaultAtaAddress: onChain.vaultAtaAddress,
      },
    });
  } catch (err) {
    console.error('[STAKING FINALIZE ERROR]', err);
    return res.status(500).json({ error: 'Internal server error', code: 'INTERNAL' });
  }
});

app.post('/api/staking/complete-unstake-prepare', mutationLimit, async (req, res) => {
  try {
    if (!STAKING_ONCHAIN_ENABLED) {
      return res.status(400).json({
        error: 'On-chain staking mode is disabled',
        code: 'STAKING_ONCHAIN_DISABLED',
      });
    }

    const {
      stakerPublicKey,
      agentPublicKey,
      signature,
      nonce,
      sessionId,
      domain,
    } = req.body || {};
    const requestOrigin = requestOriginFromReq(req);

    if (!isValidPublicKey(stakerPublicKey) || !isValidPublicKey(agentPublicKey)) {
      return res.status(400).json({ error: 'Invalid public keys', code: 'INVALID_KEY' });
    }

    const agent = findAgentByPublicKey(agentPublicKey);
    if (!agent || agent.status !== 'verified') {
      return res.status(404).json({ error: 'Verified agent not found', code: 'NOT_FOUND' });
    }

    const existingRows = listStakePositionsForWallet(stakerPublicKey)
      .filter((row) => row.agent_public_key === agentPublicKey);
    const existing = existingRows[0] || null;
    if (!existing || Number(existing.cooldown_amount || 0) <= 0 || !existing.cooldown_started_at) {
      return res.status(400).json({ error: 'No active cooldown to complete', code: 'NO_COOLDOWN' });
    }

    const cooldownEndsAt = new Date(existing.cooldown_started_at).getTime() + (COOLDOWN_DAYS * 86400 * 1000);
    if (Date.now() < cooldownEndsAt) {
      return res.status(400).json({ error: 'Cooldown not yet complete', code: 'COOLDOWN_ACTIVE' });
    }

    const canonical = { stakerPublicKey, agentPublicKey };
    const auth = consumeActionChallenge({
      publicKey: stakerPublicKey,
      scope: 'staking',
      action: 'complete_unstake',
      sessionId,
      domain,
      requestOrigin,
      payload: canonical,
      nonce,
      signature,
    });
    if (!auth.ok) {
      return res.status(auth.status).json({ error: auth.error, code: auth.code });
    }

    const returnAmountTokens = Number(existing.cooldown_amount || 0);
    const prepared = await buildVaultPayoutTransaction({
      stakerPublicKey,
      returnAmountTokens,
    });
    if (!prepared.ok) {
      return res.status(prepared.status).json({ error: prepared.error, code: prepared.code });
    }

    return res.json({
      success: true,
      mode: 'onchain-spl-transfer',
      action: 'complete_unstake',
      returnAmountTokens,
      ...prepared,
    });
  } catch (err) {
    console.error('[COMPLETE UNSTAKE PREPARE ERROR]', err);
    return res.status(500).json({ error: 'Internal server error', code: 'INTERNAL' });
  }
});

app.post('/api/staking/complete-unstake-finalize', mutationLimit, async (req, res) => {
  try {
    if (!STAKING_ONCHAIN_ENABLED) {
      return res.status(400).json({
        error: 'On-chain staking mode is disabled',
        code: 'STAKING_ONCHAIN_DISABLED',
      });
    }

    const {
      stakerPublicKey,
      agentPublicKey,
      txSignature,
      signature,
      nonce,
      sessionId,
      domain,
    } = req.body || {};
    const requestOrigin = requestOriginFromReq(req);

    if (!isValidPublicKey(stakerPublicKey) || !isValidPublicKey(agentPublicKey)) {
      return res.status(400).json({ error: 'Invalid public keys', code: 'INVALID_KEY' });
    }

    const normalizedTx = normalizeSolanaSignature(txSignature);
    if (!normalizedTx) {
      return res.status(400).json({ error: 'Invalid txSignature format', code: 'INVALID_TX' });
    }
    if (getStakingTxBySignature(normalizedTx)) {
      return res.status(409).json({ error: 'Unstake transaction already finalized', code: 'TX_ALREADY_FINALIZED' });
    }

    const agent = findAgentByPublicKey(agentPublicKey);
    if (!agent || agent.status !== 'verified') {
      return res.status(404).json({ error: 'Verified agent not found', code: 'NOT_FOUND' });
    }

    const existingRows = listStakePositionsForWallet(stakerPublicKey)
      .filter((row) => row.agent_public_key === agentPublicKey);
    const existing = existingRows[0] || null;
    if (!existing || Number(existing.cooldown_amount || 0) <= 0 || !existing.cooldown_started_at) {
      return res.status(400).json({ error: 'No active cooldown to complete', code: 'NO_COOLDOWN' });
    }
    const cooldownEndsAt = new Date(existing.cooldown_started_at).getTime() + (COOLDOWN_DAYS * 86400 * 1000);
    if (Date.now() < cooldownEndsAt) {
      return res.status(400).json({ error: 'Cooldown not yet complete', code: 'COOLDOWN_ACTIVE' });
    }

    const returnAmountTokens = Number(existing.cooldown_amount || 0);
    const auth = consumeActionChallenge({
      publicKey: stakerPublicKey,
      scope: 'staking',
      action: 'complete_unstake',
      sessionId,
      domain,
      requestOrigin,
      payload: {
        stakerPublicKey,
        agentPublicKey,
        returnAmountTokens,
        txSignature: normalizedTx,
      },
      nonce,
      signature,
    });
    if (!auth.ok) {
      return res.status(auth.status).json({ error: auth.error, code: auth.code });
    }

    const onChain = await verifyVaultPayoutOnChain({
      stakerPublicKey,
      amountTokens: returnAmountTokens,
      txSignature: normalizedTx,
    });
    if (!onChain.ok) {
      return res.status(onChain.status).json({ error: onChain.error, code: onChain.code });
    }

    const nextAmount = Number(existing.amount || 0);
    if (nextAmount <= 0) {
      deleteStakePosition(stakerPublicKey, agent.id);
    } else {
      upsertStakePosition({
        stakerPublicKey,
        agentDbId: agent.id,
        amount: nextAmount,
        cooldownAmount: 0,
        cooldownStartedAt: null,
        lastAction: 'complete_unstake',
      });
    }

    createStakingTxLedger({
      txSignature: normalizedTx,
      stakerPublicKey,
      agentDbId: agent.id,
      action: 'unstake_withdraw',
      amount: returnAmountTokens,
    });

    issueSystemReceipt(agent, 'stake.complete_unstake', {
      intentHash: crypto.createHash('sha256').update(`complete_unstake:${stakerPublicKey}`).digest('hex'),
      actionRef: 'sigil://staking/complete_unstake/onchain',
      resultHash: crypto.createHash('sha256').update('unstake_completed').digest('hex'),
      payload: { stakerPublicKey, txSignature: normalizedTx, amount: returnAmountTokens },
    });

    const refreshed = recalcAgentState(agentPublicKey) || findAgentByPublicKey(agentPublicKey);
    logEvent('staking_complete_unstake', {
      agentId: agent.id,
      publicKey: agentPublicKey,
      displayName: agent.display_name,
      glyphHash: agent.glyph_hash,
      detail: `On-chain unstake tx ${normalizedTx.slice(0, 10)}...`,
    });

    return res.json({
      success: true,
      agent: formatAgentPayload(refreshed, req),
      staking: aggregateAgentStaking(agent.id),
      onChain: {
        txSignature: normalizedTx,
        mintAddress: onChain.mintAddress,
        vaultAtaAddress: onChain.vaultAtaAddress,
        stakerAtaAddress: onChain.stakerAtaAddress,
        amountTokens: returnAmountTokens,
      },
    });
  } catch (err) {
    console.error('[COMPLETE UNSTAKE FINALIZE ERROR]', err);
    return res.status(500).json({ error: 'Internal server error', code: 'INTERNAL' });
  }
});

app.post('/api/staking/emergency-unstake-prepare', mutationLimit, async (req, res) => {
  try {
    if (!STAKING_ONCHAIN_ENABLED) {
      return res.status(400).json({
        error: 'On-chain staking mode is disabled',
        code: 'STAKING_ONCHAIN_DISABLED',
      });
    }

    const {
      stakerPublicKey,
      agentPublicKey,
      signature,
      nonce,
      sessionId,
      domain,
    } = req.body || {};
    const requestOrigin = requestOriginFromReq(req);

    if (!isValidPublicKey(stakerPublicKey) || !isValidPublicKey(agentPublicKey)) {
      return res.status(400).json({ error: 'Invalid public keys', code: 'INVALID_KEY' });
    }

    const agent = findAgentByPublicKey(agentPublicKey);
    if (!agent || agent.status !== 'verified') {
      return res.status(404).json({ error: 'Verified agent not found', code: 'NOT_FOUND' });
    }

    const existingRows = listStakePositionsForWallet(stakerPublicKey)
      .filter((row) => row.agent_public_key === agentPublicKey);
    const existing = existingRows[0] || null;
    if (!existing) {
      return res.status(400).json({ error: 'No stake position found', code: 'NO_POSITION' });
    }
    const total = Number(existing.amount || 0) + Number(existing.cooldown_amount || 0);
    if (total <= 0) {
      return res.status(400).json({ error: 'Nothing to emergency-unstake', code: 'NO_POSITION' });
    }

    const canonical = { stakerPublicKey, agentPublicKey, total };
    const auth = consumeActionChallenge({
      publicKey: stakerPublicKey,
      scope: 'staking',
      action: 'emergency_unstake',
      sessionId,
      domain,
      requestOrigin,
      payload: canonical,
      nonce,
      signature,
    });
    if (!auth.ok) {
      return res.status(auth.status).json({ error: auth.error, code: auth.code });
    }

    const slash = Math.floor((total * EMERGENCY_SLASH_BPS) / 10000);
    const returned = total - slash;
    const prepared = await buildVaultPayoutTransaction({
      stakerPublicKey,
      returnAmountTokens: returned,
    });
    if (!prepared.ok) {
      return res.status(prepared.status).json({ error: prepared.error, code: prepared.code });
    }

    return res.json({
      success: true,
      mode: 'onchain-spl-transfer',
      action: 'emergency_unstake',
      total,
      slash,
      returned,
      ...prepared,
    });
  } catch (err) {
    console.error('[EMERGENCY UNSTAKE PREPARE ERROR]', err);
    return res.status(500).json({ error: 'Internal server error', code: 'INTERNAL' });
  }
});

app.post('/api/staking/emergency-unstake-finalize', mutationLimit, async (req, res) => {
  try {
    if (!STAKING_ONCHAIN_ENABLED) {
      return res.status(400).json({
        error: 'On-chain staking mode is disabled',
        code: 'STAKING_ONCHAIN_DISABLED',
      });
    }

    const {
      stakerPublicKey,
      agentPublicKey,
      txSignature,
      signature,
      nonce,
      sessionId,
      domain,
    } = req.body || {};
    const requestOrigin = requestOriginFromReq(req);

    if (!isValidPublicKey(stakerPublicKey) || !isValidPublicKey(agentPublicKey)) {
      return res.status(400).json({ error: 'Invalid public keys', code: 'INVALID_KEY' });
    }

    const normalizedTx = normalizeSolanaSignature(txSignature);
    if (!normalizedTx) {
      return res.status(400).json({ error: 'Invalid txSignature format', code: 'INVALID_TX' });
    }
    if (getStakingTxBySignature(normalizedTx)) {
      return res.status(409).json({ error: 'Emergency unstake transaction already finalized', code: 'TX_ALREADY_FINALIZED' });
    }

    const agent = findAgentByPublicKey(agentPublicKey);
    if (!agent || agent.status !== 'verified') {
      return res.status(404).json({ error: 'Verified agent not found', code: 'NOT_FOUND' });
    }

    const existingRows = listStakePositionsForWallet(stakerPublicKey)
      .filter((row) => row.agent_public_key === agentPublicKey);
    const existing = existingRows[0] || null;
    if (!existing) {
      return res.status(400).json({ error: 'No stake position found', code: 'NO_POSITION' });
    }
    const total = Number(existing.amount || 0) + Number(existing.cooldown_amount || 0);
    if (total <= 0) {
      return res.status(400).json({ error: 'Nothing to emergency-unstake', code: 'NO_POSITION' });
    }

    const slash = Math.floor((total * EMERGENCY_SLASH_BPS) / 10000);
    const returned = total - slash;
    const auth = consumeActionChallenge({
      publicKey: stakerPublicKey,
      scope: 'staking',
      action: 'emergency_unstake',
      sessionId,
      domain,
      requestOrigin,
      payload: {
        stakerPublicKey,
        agentPublicKey,
        total,
        slash,
        returned,
        txSignature: normalizedTx,
      },
      nonce,
      signature,
    });
    if (!auth.ok) {
      return res.status(auth.status).json({ error: auth.error, code: auth.code });
    }

    const onChain = await verifyVaultPayoutOnChain({
      stakerPublicKey,
      amountTokens: returned,
      txSignature: normalizedTx,
    });
    if (!onChain.ok) {
      return res.status(onChain.status).json({ error: onChain.error, code: onChain.code });
    }

    deleteStakePosition(stakerPublicKey, agent.id);
    createStakingTxLedger({
      txSignature: normalizedTx,
      stakerPublicKey,
      agentDbId: agent.id,
      action: 'emergency_withdraw',
      amount: returned,
    });

    issueSystemReceipt(agent, 'stake.emergency_unstake', {
      intentHash: crypto.createHash('sha256').update(`emergency_unstake:${stakerPublicKey}:${total}`).digest('hex'),
      actionRef: 'sigil://staking/emergency_unstake/onchain',
      resultHash: crypto.createHash('sha256').update(`returned:${returned}:slashed:${slash}`).digest('hex'),
      payload: { stakerPublicKey, total, slash, returned, txSignature: normalizedTx },
    });

    const refreshed = recalcAgentState(agentPublicKey) || findAgentByPublicKey(agentPublicKey);
    logEvent('staking_emergency_unstake', {
      agentId: agent.id,
      publicKey: agentPublicKey,
      displayName: agent.display_name,
      glyphHash: agent.glyph_hash,
      detail: `On-chain emergency tx ${normalizedTx.slice(0, 10)}...`,
    });

    return res.json({
      success: true,
      agent: formatAgentPayload(refreshed, req),
      staking: aggregateAgentStaking(agent.id),
      emergency: {
        total,
        slash,
        returned,
      },
      onChain: {
        txSignature: normalizedTx,
        mintAddress: onChain.mintAddress,
        vaultAtaAddress: onChain.vaultAtaAddress,
        stakerAtaAddress: onChain.stakerAtaAddress,
        amountTokens: returned,
      },
    });
  } catch (err) {
    console.error('[EMERGENCY UNSTAKE FINALIZE ERROR]', err);
    return res.status(500).json({ error: 'Internal server error', code: 'INTERNAL' });
  }
});

async function stakeMutation(req, res, action) {
  const {
    stakerPublicKey,
    agentPublicKey,
    signature,
    nonce,
    sessionId,
    domain,
  } = req.body || {};
  const requestOrigin = requestOriginFromReq(req);
  const amount = Number(req.body?.amount || 0);

  if (!isValidPublicKey(stakerPublicKey) || !isValidPublicKey(agentPublicKey)) {
    return res.status(400).json({ error: 'Invalid public keys', code: 'INVALID_KEY' });
  }

  const agent = findAgentByPublicKey(agentPublicKey);
  if (!agent || agent.status !== 'verified') {
    return res.status(404).json({ error: 'Verified agent not found', code: 'NOT_FOUND' });
  }

  const existingRows = listStakePositionsForWallet(stakerPublicKey)
    .filter((row) => row.agent_public_key === agentPublicKey);
  const existing = existingRows[0] || null;
  let stakingChainTx = null;

  if (action === 'stake') {
    if (STAKING_ONCHAIN_ENABLED) {
      return res.status(400).json({
        error: 'On-chain staking mode requires /api/staking/stake-prepare and /api/staking/stake-finalize',
        code: 'STAKE_ONCHAIN_REQUIRED',
      });
    }

    if (!Number.isFinite(amount) || amount < MIN_STAKE || amount > MAX_STAKE) {
      return res.status(400).json({ error: `Stake amount must be ${MIN_STAKE}-${MAX_STAKE}`, code: 'INVALID_AMOUNT' });
    }

    const canonical = { stakerPublicKey, agentPublicKey, amount };
    const auth = consumeActionChallenge({
      publicKey: stakerPublicKey,
      scope: 'staking',
      action,
      sessionId,
      domain,
      requestOrigin,
      payload: canonical,
      nonce,
      signature,
    });
    if (!auth.ok) {
      return res.status(auth.status).json({ error: auth.error, code: auth.code });
    }

    const newAmount = Number(existing?.amount || 0) + amount;
    upsertStakePosition({
      stakerPublicKey,
      agentDbId: agent.id,
      amount: newAmount,
      cooldownAmount: Number(existing?.cooldown_amount || 0),
      cooldownStartedAt: existing?.cooldown_started_at || null,
      lastAction: 'stake',
    });

    issueSystemReceipt(agent, 'stake.confirm', {
      intentHash: crypto.createHash('sha256').update(`stake:${stakerPublicKey}:${amount}`).digest('hex'),
      actionRef: 'sigil://staking/stake',
      resultHash: crypto.createHash('sha256').update(`stake_total:${newAmount}`).digest('hex'),
      payload: { stakerPublicKey, amount },
    });
  }

  if (action === 'begin_unstake') {
    if (!existing || Number(existing.amount || 0) <= 0) {
      return res.status(400).json({ error: 'No active position to unstake', code: 'NO_ACTIVE_STAKE' });
    }
    if (!Number.isFinite(amount) || amount <= 0 || amount > Number(existing.amount || 0)) {
      return res.status(400).json({ error: 'Invalid unstake amount', code: 'INVALID_AMOUNT' });
    }

    const canonical = { stakerPublicKey, agentPublicKey, amount };
    const auth = consumeActionChallenge({
      publicKey: stakerPublicKey,
      scope: 'staking',
      action,
      sessionId,
      domain,
      requestOrigin,
      payload: canonical,
      nonce,
      signature,
    });
    if (!auth.ok) {
      return res.status(auth.status).json({ error: auth.error, code: auth.code });
    }

    upsertStakePosition({
      stakerPublicKey,
      agentDbId: agent.id,
      amount: Number(existing.amount || 0) - amount,
      cooldownAmount: Number(existing.cooldown_amount || 0) + amount,
      cooldownStartedAt: nowIso(),
      lastAction: 'begin_unstake',
    });

    issueSystemReceipt(agent, 'stake.begin_unstake', {
      intentHash: crypto.createHash('sha256').update(`begin_unstake:${stakerPublicKey}:${amount}`).digest('hex'),
      actionRef: 'sigil://staking/begin_unstake',
      resultHash: crypto.createHash('sha256').update(`cooldown:${amount}`).digest('hex'),
      payload: { stakerPublicKey, amount },
    });
  }

  if (action === 'cancel_unstake') {
    if (!existing || Number(existing.cooldown_amount || 0) <= 0) {
      return res.status(400).json({ error: 'No active cooldown to cancel', code: 'NO_COOLDOWN' });
    }
    const canonical = { stakerPublicKey, agentPublicKey };
    const auth = consumeActionChallenge({
      publicKey: stakerPublicKey,
      scope: 'staking',
      action,
      sessionId,
      domain,
      requestOrigin,
      payload: canonical,
      nonce,
      signature,
    });
    if (!auth.ok) {
      return res.status(auth.status).json({ error: auth.error, code: auth.code });
    }

    upsertStakePosition({
      stakerPublicKey,
      agentDbId: agent.id,
      amount: Number(existing.amount || 0) + Number(existing.cooldown_amount || 0),
      cooldownAmount: 0,
      cooldownStartedAt: null,
      lastAction: 'cancel_unstake',
    });

    issueSystemReceipt(agent, 'stake.cancel_unstake', {
      intentHash: crypto.createHash('sha256').update(`cancel_unstake:${stakerPublicKey}`).digest('hex'),
      actionRef: 'sigil://staking/cancel_unstake',
      resultHash: crypto.createHash('sha256').update('cooldown_cancelled').digest('hex'),
      payload: { stakerPublicKey },
    });
  }

  if (action === 'complete_unstake') {
    if (!existing || Number(existing.cooldown_amount || 0) <= 0 || !existing.cooldown_started_at) {
      return res.status(400).json({ error: 'No active cooldown to complete', code: 'NO_COOLDOWN' });
    }
    const cooldownEndsAt = new Date(existing.cooldown_started_at).getTime() + (COOLDOWN_DAYS * 86400 * 1000);
    if (Date.now() < cooldownEndsAt) {
      return res.status(400).json({ error: 'Cooldown not yet complete', code: 'COOLDOWN_ACTIVE' });
    }
    const canonical = { stakerPublicKey, agentPublicKey };
    const auth = consumeActionChallenge({
      publicKey: stakerPublicKey,
      scope: 'staking',
      action,
      sessionId,
      domain,
      requestOrigin,
      payload: canonical,
      nonce,
      signature,
    });
    if (!auth.ok) {
      return res.status(auth.status).json({ error: auth.error, code: auth.code });
    }

    if (STAKING_ONCHAIN_ENABLED) {
      return res.status(400).json({
        error: 'On-chain staking mode requires /api/staking/complete-unstake-prepare and /api/staking/complete-unstake-finalize',
        code: 'UNSTAKE_ONCHAIN_REQUIRED',
      });
    }

    const nextAmount = Number(existing.amount || 0);
    if (nextAmount <= 0) {
      deleteStakePosition(stakerPublicKey, agent.id);
    } else {
      upsertStakePosition({
        stakerPublicKey,
        agentDbId: agent.id,
        amount: nextAmount,
        cooldownAmount: 0,
        cooldownStartedAt: null,
        lastAction: 'complete_unstake',
      });
    }

    issueSystemReceipt(agent, 'stake.complete_unstake', {
      intentHash: crypto.createHash('sha256').update(`complete_unstake:${stakerPublicKey}`).digest('hex'),
      actionRef: 'sigil://staking/complete_unstake',
      resultHash: crypto.createHash('sha256').update('unstake_completed').digest('hex'),
      payload: { stakerPublicKey, txSignature: stakingChainTx },
    });
  }

  if (action === 'emergency_unstake') {
    if (!existing) {
      return res.status(400).json({ error: 'No stake position found', code: 'NO_POSITION' });
    }
    const total = Number(existing.amount || 0) + Number(existing.cooldown_amount || 0);
    if (total <= 0) {
      return res.status(400).json({ error: 'Nothing to emergency-unstake', code: 'NO_POSITION' });
    }
    const canonical = { stakerPublicKey, agentPublicKey, total };
    const auth = consumeActionChallenge({
      publicKey: stakerPublicKey,
      scope: 'staking',
      action,
      sessionId,
      domain,
      requestOrigin,
      payload: canonical,
      nonce,
      signature,
    });
    if (!auth.ok) {
      return res.status(auth.status).json({ error: auth.error, code: auth.code });
    }

    const slash = Math.floor((total * EMERGENCY_SLASH_BPS) / 10000);
    const returned = total - slash;

    if (STAKING_ONCHAIN_ENABLED) {
      return res.status(400).json({
        error: 'On-chain staking mode requires /api/staking/emergency-unstake-prepare and /api/staking/emergency-unstake-finalize',
        code: 'UNSTAKE_ONCHAIN_REQUIRED',
      });
    }

    deleteStakePosition(stakerPublicKey, agent.id);

    issueSystemReceipt(agent, 'stake.emergency_unstake', {
      intentHash: crypto.createHash('sha256').update(`emergency_unstake:${stakerPublicKey}:${total}`).digest('hex'),
      actionRef: 'sigil://staking/emergency_unstake',
      resultHash: crypto.createHash('sha256').update(`returned:${returned}:slashed:${slash}`).digest('hex'),
      payload: { stakerPublicKey, total, slash, returned, txSignature: stakingChainTx },
    });
  }

  const refreshed = recalcAgentState(agentPublicKey) || findAgentByPublicKey(agentPublicKey);
  logEvent(`staking_${action}`, {
    agentId: agent.id,
    publicKey: agentPublicKey,
    displayName: agent.display_name,
    glyphHash: agent.glyph_hash,
    detail: `Staker ${stakerPublicKey.slice(0, 8)}... action ${action}`,
  });

  return res.json({
    success: true,
    agent: formatAgentPayload(refreshed, req),
    staking: aggregateAgentStaking(agent.id),
    onChain: stakingChainTx ? { txSignature: stakingChainTx } : null,
  });
}

app.post('/api/staking/stake', mutationLimit, (req, res) => {
  stakeMutation(req, res, 'stake').catch((err) => {
    console.error('[STAKING MUTATION ERROR]', err);
    res.status(500).json({ error: 'Internal server error', code: 'INTERNAL' });
  });
});
app.post('/api/staking/begin-unstake', mutationLimit, (req, res) => {
  stakeMutation(req, res, 'begin_unstake').catch((err) => {
    console.error('[STAKING MUTATION ERROR]', err);
    res.status(500).json({ error: 'Internal server error', code: 'INTERNAL' });
  });
});
app.post('/api/staking/cancel-unstake', mutationLimit, (req, res) => {
  stakeMutation(req, res, 'cancel_unstake').catch((err) => {
    console.error('[STAKING MUTATION ERROR]', err);
    res.status(500).json({ error: 'Internal server error', code: 'INTERNAL' });
  });
});
app.post('/api/staking/complete-unstake', mutationLimit, (req, res) => {
  stakeMutation(req, res, 'complete_unstake').catch((err) => {
    console.error('[STAKING MUTATION ERROR]', err);
    res.status(500).json({ error: 'Internal server error', code: 'INTERNAL' });
  });
});
app.post('/api/staking/emergency-unstake', mutationLimit, (req, res) => {
  stakeMutation(req, res, 'emergency_unstake').catch((err) => {
    console.error('[STAKING MUTATION ERROR]', err);
    res.status(500).json({ error: 'Internal server error', code: 'INTERNAL' });
  });
});

app.get('/api/passport/:publicKey', relaxedLimit, (req, res) => {
  try {
    const { publicKey } = req.params;
    const agent = findAgentByPublicKey(publicKey);
    if (!agent) return res.status(404).json({ error: 'Agent not found', code: 'NOT_FOUND' });

    const record = getPassportByAgent(agent.id);
    if (!record) {
      return res.json({
        publicKey,
        status: 'not-issued',
        onChain: false,
      });
    }

    const status = isLegacySimulatedPassportRecord(record) ? 'legacy_simulated' : record.status;

    return res.json({
      publicKey,
      status,
      onChain: status === 'minted',
      mintAddress: record.mint_address,
      metadataUri: record.metadata_uri,
      imageUri: record.image_uri,
      txSignature: record.tx_signature,
      mintedAt: record.minted_at,
      ownerPublicKey: record.owner_public_key,
    });
  } catch (err) {
    console.error('[PASSPORT ERROR]', err);
    return res.status(500).json({ error: 'Internal server error', code: 'INTERNAL' });
  }
});

app.get('/api/passport/:publicKey/metadata', relaxedLimit, (req, res) => {
  try {
    const { publicKey } = req.params;
    const agent = findAgentByPublicKey(publicKey);
    if (!agent) return res.status(404).json({ error: 'Agent not found', code: 'NOT_FOUND' });
    const metadata = buildPassportMetadata({
      agent,
      baseUrl: baseUrlFromReq(req),
      collectionAddress: PASSPORT_COLLECTION,
    });
    return res.json(metadata);
  } catch (err) {
    console.error('[PASSPORT META ERROR]', err);
    return res.status(500).json({ error: 'Internal server error', code: 'INTERNAL' });
  }
});

app.post('/api/passport/:publicKey/mint-prepare', mutationLimit, async (req, res) => {
  try {
    const { publicKey } = req.params;
    const {
      ownerPublicKey,
      signature,
      nonce,
      sessionId,
      domain,
    } = req.body || {};
    const requestOrigin = requestOriginFromReq(req);

    if (!isValidPublicKey(publicKey) || !isValidPublicKey(ownerPublicKey)) {
      return res.status(400).json({ error: 'Invalid public key format', code: 'INVALID_KEY' });
    }

    const agent = findAgentByPublicKey(publicKey);
    if (!agent || agent.status !== 'verified') {
      return res.status(404).json({ error: 'Verified agent not found', code: 'NOT_FOUND' });
    }
    const existingPassport = getPassportByAgent(agent.id);
    if (
      existingPassport
      && existingPassport.status === 'minted'
      && existingPassport.owner_public_key
      && existingPassport.owner_public_key !== ownerPublicKey
    ) {
      return res.status(409).json({
        error: 'Passport is already minted for this agent by a different wallet',
        code: 'PASSPORT_ALREADY_ISSUED',
      });
    }

    const auth = consumeActionChallenge({
      publicKey: ownerPublicKey,
      scope: 'passport',
      action: 'issue',
      sessionId,
      domain,
      requestOrigin,
      payload: {
        agentPublicKey: publicKey,
        ownerPublicKey,
      },
      nonce,
      signature,
    });
    if (!auth.ok) {
      return res.status(auth.status).json({ error: auth.error, code: auth.code });
    }

    const metadataUri = normalizeMetadataUri(baseUrlFromReq(req), publicKey);
    const tokenMetadataFields = buildPassportTokenMetadataFields(agent, metadataUri);
    const prepared = await buildPassportMintTransaction({
      ownerPublicKey,
      agentPublicKey: publicKey,
      metadataUri,
      tokenMetadataFields,
    });

    return res.json({
      success: true,
      mode: 'token2022-nontransferable',
      ...prepared,
    });
  } catch (err) {
    console.error('[PASSPORT MINT PREPARE ERROR]', err);
    return res.status(500).json({ error: 'Internal server error', code: 'INTERNAL' });
  }
});

app.post('/api/passport/:publicKey/mint-finalize', mutationLimit, async (req, res) => {
  try {
    const { publicKey } = req.params;
    const {
      ownerPublicKey,
      mintAddress,
      txSignature = null,
      signature,
      nonce,
      sessionId,
      domain,
    } = req.body || {};
    const requestOrigin = requestOriginFromReq(req);

    if (!isValidPublicKey(publicKey) || !isValidPublicKey(ownerPublicKey) || !isValidPublicKey(mintAddress)) {
      return res.status(400).json({ error: 'Invalid public key format', code: 'INVALID_KEY' });
    }
    const normalizedTxSignature = txSignature == null || txSignature === ''
      ? null
      : normalizeSolanaSignature(txSignature);
    if (txSignature != null && txSignature !== '' && !normalizedTxSignature) {
      return res.status(400).json({ error: 'Invalid txSignature format', code: 'INVALID_TX' });
    }

    const agent = findAgentByPublicKey(publicKey);
    if (!agent || agent.status !== 'verified') {
      return res.status(404).json({ error: 'Verified agent not found', code: 'NOT_FOUND' });
    }
    const existingPassport = getPassportByAgent(agent.id);
    if (
      existingPassport
      && existingPassport.status === 'minted'
      && existingPassport.owner_public_key
      && existingPassport.mint_address
      && (
        existingPassport.owner_public_key !== ownerPublicKey
        || existingPassport.mint_address !== mintAddress
      )
    ) {
      return res.status(409).json({
        error: 'Passport is already minted for this agent and cannot be overwritten',
        code: 'PASSPORT_ALREADY_ISSUED',
      });
    }

    const auth = consumeActionChallenge({
      publicKey: ownerPublicKey,
      scope: 'passport',
      action: 'finalize',
      sessionId,
      domain,
      requestOrigin,
      payload: {
        agentPublicKey: publicKey,
        ownerPublicKey,
        mintAddress,
        txSignature: normalizedTxSignature,
      },
      nonce,
      signature,
    });
    if (!auth.ok) {
      return res.status(auth.status).json({ error: auth.error, code: auth.code });
    }

    const chainCheck = await verifyPassportMintOnChain({
      ownerPublicKey,
      agentPublicKey: publicKey,
      mintAddress,
      metadataUriExpected: normalizeMetadataUri(baseUrlFromReq(req), publicKey),
      txSignature: normalizedTxSignature,
    });
    if (!chainCheck.ok) {
      return res.status(chainCheck.status).json({ error: chainCheck.error, code: chainCheck.code });
    }

    const metadataUri = normalizeMetadataUri(baseUrlFromReq(req), publicKey);
    upsertPassportRecord({
      agentDbId: agent.id,
      ownerPublicKey,
      mintAddress,
      metadataUri,
      imageUri: `${baseUrlFromReq(req)}/api/glyph/${encodeURIComponent(publicKey)}`,
      status: 'minted',
      txSignature: normalizedTxSignature,
      mintedAt: nowIso(),
    });

    issueSystemReceipt(agent, 'passport.minted', {
      intentHash: crypto.createHash('sha256').update(`passport_mint:${ownerPublicKey}`).digest('hex'),
      actionRef: 'sigil://passport/mint-token2022',
      resultHash: crypto.createHash('sha256').update(`passport_mint:${mintAddress}`).digest('hex'),
      payload: {
        ownerPublicKey,
        mintAddress,
        txSignature: normalizedTxSignature,
        ataAddress: chainCheck.ataAddress,
      },
    });

    recalcAgentState(publicKey);
    logEvent('passport_issued', {
      agentId: agent.id,
      publicKey,
      displayName: agent.display_name,
      glyphHash: agent.glyph_hash,
      detail: `On-chain mint ${mintAddress}${normalizedTxSignature ? ` tx ${normalizedTxSignature.slice(0, 10)}...` : ''}`,
    });

    return res.json({
      success: true,
      passport: {
        mintAddress,
        metadataUri,
        imageUri: `${baseUrlFromReq(req)}/api/glyph/${encodeURIComponent(publicKey)}`,
        txSignature: normalizedTxSignature,
        ownerPublicKey,
        status: 'minted',
      },
      verification: {
        onChain: true,
        ataAddress: chainCheck.ataAddress,
        mint: chainCheck.mint,
      },
    });
  } catch (err) {
    console.error('[PASSPORT MINT FINALIZE ERROR]', err);
    return res.status(500).json({ error: 'Internal server error', code: 'INTERNAL' });
  }
});

app.post('/api/passport/:publicKey/issue', mutationLimit, (req, res) => {
  try {
    if (!LEGACY_PASSPORT_ISSUE_ENABLED) {
      return res.status(410).json({
        error: 'Legacy passport issue route is disabled. Use /mint-prepare and /mint-finalize for real on-chain passports.',
        code: 'LEGACY_ROUTE_DISABLED',
      });
    }
    const { publicKey } = req.params;
    const {
      ownerPublicKey,
      signature,
      nonce,
      sessionId,
      domain,
    } = req.body || {};
    const requestOrigin = requestOriginFromReq(req);
    if (!isValidPublicKey(publicKey) || !isValidPublicKey(ownerPublicKey)) {
      return res.status(400).json({ error: 'Invalid public key format', code: 'INVALID_KEY' });
    }

    const agent = findAgentByPublicKey(publicKey);
    if (!agent || agent.status !== 'verified') {
      return res.status(404).json({ error: 'Verified agent not found', code: 'NOT_FOUND' });
    }

    const auth = consumeActionChallenge({
      publicKey: ownerPublicKey,
      scope: 'passport',
      action: 'issue',
      sessionId,
      domain,
      requestOrigin,
      payload: {
        agentPublicKey: publicKey,
        ownerPublicKey,
      },
      nonce,
      signature,
    });
    if (!auth.ok) {
      return res.status(auth.status).json({ error: auth.error, code: auth.code });
    }

    const metadataUri = normalizeMetadataUri(baseUrlFromReq(req), publicKey);
    const mintAddress = deterministicPassportMint(publicKey, agent.glyph_hash);
    upsertPassportRecord({
      agentDbId: agent.id,
      ownerPublicKey,
      mintAddress,
      metadataUri,
      imageUri: `${baseUrlFromReq(req)}/api/glyph/${encodeURIComponent(publicKey)}`,
      status: 'legacy_simulated',
      txSignature: null,
      mintedAt: nowIso(),
    });

    issueSystemReceipt(agent, 'passport.issued', {
      intentHash: crypto.createHash('sha256').update(`passport_issue:${ownerPublicKey}`).digest('hex'),
      actionRef: 'sigil://passport/issue',
      resultHash: crypto.createHash('sha256').update(`passport_mint:${mintAddress}`).digest('hex'),
      payload: { ownerPublicKey, mintAddress, metadataUri },
    });

    recalcAgentState(publicKey);
    logEvent('passport_issued', {
      agentId: agent.id,
      publicKey,
      displayName: agent.display_name,
      glyphHash: agent.glyph_hash,
      detail: `Legacy simulated mint ${mintAddress}`,
    });

    return res.json({
      success: true,
      passport: {
        mintAddress,
        metadataUri,
        imageUri: `${baseUrlFromReq(req)}/api/glyph/${encodeURIComponent(publicKey)}`,
        status: 'legacy_simulated',
      },
      message: 'Legacy simulated passport path only. Use /mint-prepare + /mint-finalize for real Token-2022 mints.',
    });
  } catch (err) {
    console.error('[PASSPORT ISSUE ERROR]', err);
    return res.status(500).json({ error: 'Internal server error', code: 'INTERNAL' });
  }
});

app.get('/api/verification/agent/:publicKey', relaxedLimit, async (req, res) => {
  try {
    const { publicKey } = req.params;
    const requirePassport = String(req.query.requirePassport || '0') === '1';
    const verification = await buildAgentVerificationPayload({ publicKey, requirePassport, req });
    if (!verification.ok) {
      return res.status(verification.status).json({ error: verification.error, code: verification.code });
    }
    return res.json(verification.payload);
  } catch (err) {
    console.error('[AGENT VERIFICATION ERROR]', err);
    return res.status(500).json({ error: 'Internal server error', code: 'INTERNAL' });
  }
});

app.get('/api/verification/agent/:publicKey/compact', relaxedLimit, async (req, res) => {
  try {
    const { publicKey } = req.params;
    const requirePassport = String(req.query.requirePassport || '0') === '1';
    const verification = await buildAgentVerificationPayload({ publicKey, requirePassport, req });
    if (!verification.ok) {
      return res.status(verification.status).json({ error: verification.error, code: verification.code });
    }

    const failedChecks = verification.payload.attestation.criticalChecks
      .filter((check) => !check.pass)
      .map((check) => check.key);

    return res.json({
      publicKey: verification.payload.publicKey,
      checkedAt: verification.payload.attestation.checkedAt,
      requirePassport,
      criticalPass: verification.payload.attestation.criticalPass,
      failedChecks,
      confidence: verification.payload.attestation.criticalPass ? 'high' : 'low',
      profileUrl: verification.payload.profileUrl,
      badgeSvgUrl: verification.payload.docs.badgeSvg,
    });
  } catch (err) {
    console.error('[AGENT VERIFICATION COMPACT ERROR]', err);
    return res.status(500).json({ error: 'Internal server error', code: 'INTERNAL' });
  }
});

app.get('/api/verification/badge/:publicKey.svg', relaxedLimit, async (req, res) => {
  try {
    const { publicKey } = req.params;
    const requirePassport = String(req.query.requirePassport || '0') === '1';
    const verification = await buildAgentVerificationPayload({ publicKey, requirePassport, req });

    let svg;
    if (!verification.ok) {
      svg = buildVerificationBadgeSvg({
        publicKey,
        displayName: 'Unknown Agent',
        criticalPass: false,
        requirePassport,
        failedChecks: [verification.code || 'not_found'],
        checkedAt: nowIso(),
      });
    } else {
      const failedChecks = verification.payload.attestation.criticalChecks
        .filter((check) => !check.pass)
        .map((check) => check.key);
      svg = buildVerificationBadgeSvg({
        publicKey: verification.payload.publicKey,
        displayName: verification.payload.displayName,
        criticalPass: verification.payload.attestation.criticalPass,
        requirePassport,
        failedChecks,
        checkedAt: verification.payload.attestation.checkedAt,
      });
    }

    res.set('Content-Type', 'image/svg+xml');
    res.set('Cache-Control', 'public, max-age=120');
    return res.send(svg);
  } catch (err) {
    console.error('[AGENT VERIFICATION BADGE ERROR]', err);
    return res.status(500).json({ error: 'Internal server error', code: 'INTERNAL' });
  }
});

app.get('/.well-known/sigil.json', relaxedLimit, (req, res) => {
  const base = baseUrlFromReq(req);
  res.json({
    protocol: 'SIGIL',
    version: VERSION,
    network: process.env.SOLANA_NETWORK || 'mainnet-beta',
    rpcEndpoint: SOLANA_RPC_URL,
    verification: {
      full: `${base}/api/verification/agent/:publicKey?requirePassport=1`,
      compact: `${base}/api/verification/agent/:publicKey/compact?requirePassport=1`,
      badge: `${base}/api/verification/badge/:publicKey.svg?requirePassport=1`,
    },
    docs: {
      homepage: `${base}/index.html`,
      verifyConsole: `${base}/verify.html`,
      whitepaper: `${base}/whitepaper.html`,
    },
  });
});

app.get('/api/glyph/:publicKey/meta', relaxedLimit, (req, res) => {
  try {
    const { publicKey } = req.params;
    const agent = findAgentByPublicKey(publicKey);
    if (!agent || agent.status !== 'verified') {
      return res.status(404).json({ error: 'Agent not found or not verified', code: 'NOT_FOUND' });
    }

    return res.json({
      glyphHash: agent.glyph_hash,
      displayName: agent.display_name,
      tier: agent.tier,
      verifiedAt: agent.verified_at,
      publicKey: agent.public_key,
      receiptCount: getReceiptCount(agent.id),
      svgUrl: `/api/glyph/${encodeURIComponent(publicKey)}`,
    });
  } catch (err) {
    console.error('[GLYPH META ERROR]', err);
    return res.status(500).json({ error: 'Internal server error', code: 'INTERNAL' });
  }
});

app.get('/api/glyph/:publicKey', relaxedLimit, (req, res) => {
  try {
    const { publicKey } = req.params;
    const agent = findAgentByPublicKey(publicKey);
    if (!agent || agent.status !== 'verified') {
      return res.status(404).json({ error: 'Agent not found or not verified', code: 'NOT_FOUND' });
    }

    ensureGlyphCacheDir();
    const cacheFile = join(GLYPHS_DIR, `${agent.glyph_hash}.svg`);
    if (existsSync(cacheFile)) {
      const cached = readFileSync(cacheFile, 'utf-8');
      res.set('Content-Type', 'image/svg+xml');
      res.set('Cache-Control', 'public, max-age=86400');
      return res.send(cached);
    }

    const svg = renderGlyphCard({
      glyphHash: agent.glyph_hash,
      displayName: agent.display_name || 'Anonymous Agent',
      tier: agent.tier || 1,
      status: agent.status,
      verifiedAt: agent.verified_at,
      publicKey: agent.public_key,
      persistenceScore: Number(agent.persistence_score || 0),
    });
    writeFileSync(cacheFile, svg, 'utf-8');

    res.set('Content-Type', 'image/svg+xml');
    res.set('Cache-Control', 'public, max-age=86400');
    return res.send(svg);
  } catch (err) {
    console.error('[GLYPH ERROR]', err);
    return res.status(500).json({ error: 'Internal server error', code: 'INTERNAL' });
  }
});

app.use(express.static(SITE_ROOT, {
  extensions: ['html'],
  index: 'index.html',
}));

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  return res.sendFile(join(SITE_ROOT, 'index.html'));
});

app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'Not found', code: 'NOT_FOUND' });
  }
  return res.status(404).send('Not found');
});

initDatabase();

// Seed recalculation on startup for consistency.
try {
  const rows = getDb().prepare("SELECT public_key FROM agents WHERE status = 'verified'").all();
  for (const row of rows) recalcAgentState(row.public_key);
} catch (err) {
  console.warn('[INIT] Agent recalculation failed:', err.message);
}

const server = app.listen(PORT, () => {
  console.log(`
╔═════════════════════════════════════════════╗
║ SIGIL Protocol API v${VERSION}                  ║
║ Port: ${PORT.toString().padEnd(33, ' ')}║
║ Chain: Solana (${(process.env.SOLANA_NETWORK || 'mainnet-beta').padEnd(21, ' ')})║
║ Status: OPERATIONAL                        ║
╚═════════════════════════════════════════════╝
`);
});

function shutdown(signal) {
  console.log(`\n[${signal}] Shutting down gracefully...`);
  server.close(() => {
    closeDatabase();
    process.exit(0);
  });
  setTimeout(() => {
    console.error('[SHUTDOWN] Forced shutdown after timeout');
    process.exit(1);
  }, 5000);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
