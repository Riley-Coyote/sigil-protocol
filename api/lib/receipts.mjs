import { createHash } from 'crypto';
import {
  createReceipt,
  getLatestReceipt,
  getNextReceiptSeq,
  listReceiptHashesInRange,
  updateAgentLastReceipt,
} from './database.mjs';

function sha256Hex(input) {
  return createHash('sha256').update(input).digest('hex');
}

export function normalizeReceiptPayload(payload = {}) {
  const canonical = {
    type: payload.type || 'action',
    seq: Number(payload.seq || 0),
    timestamp: payload.timestamp || new Date().toISOString(),
    intentHash: payload.intentHash || '',
    actionRef: payload.actionRef || '',
    resultHash: payload.resultHash || '',
    prevReceiptHash: payload.prevReceiptHash || null,
  };

  return canonical;
}

export function buildReceiptPreimage(publicKey, payload) {
  const normalized = normalizeReceiptPayload(payload);
  return [
    'SIGIL_RECEIPT_V1',
    publicKey,
    normalized.type,
    String(normalized.seq),
    normalized.timestamp,
    normalized.intentHash,
    normalized.actionRef,
    normalized.resultHash,
    normalized.prevReceiptHash || '',
  ].join('|');
}

export function computeReceiptHash(publicKey, payload) {
  return sha256Hex(buildReceiptPreimage(publicKey, payload));
}

export function issueSystemReceipt(agent, receiptType, {
  intentHash = 'system-intent',
  actionRef = 'system://event',
  resultHash = 'system-result',
  payload = null,
} = {}) {
  const seq = getNextReceiptSeq(agent.id);
  const prev = getLatestReceipt(agent.id);
  const timestamp = new Date().toISOString();
  const receiptPayload = {
    type: receiptType,
    seq,
    timestamp,
    intentHash,
    actionRef,
    resultHash,
    prevReceiptHash: prev ? prev.receipt_hash : null,
  };
  const receiptHash = computeReceiptHash(agent.public_key, receiptPayload);

  createReceipt({
    agentDbId: agent.id,
    seq,
    receiptType,
    receiptHash,
    prevHash: receiptPayload.prevReceiptHash,
    intentHash,
    actionRef,
    resultHash,
    signature: null,
    payload,
    createdAt: timestamp,
  });

  updateAgentLastReceipt(agent.id, timestamp);

  return {
    seq,
    hash: receiptHash,
    type: receiptType,
    timestamp,
  };
}

export function validateReceiptSubmission(agent, incoming) {
  const latest = getLatestReceipt(agent.id);
  const expectedSeq = latest ? latest.seq + 1 : 1;
  const expectedPrev = latest ? latest.receipt_hash : null;

  if (incoming.seq !== expectedSeq) {
    return { ok: false, code: 'INVALID_SEQ', message: `Expected seq ${expectedSeq}` };
  }

  if ((incoming.prevReceiptHash || null) !== expectedPrev) {
    return { ok: false, code: 'INVALID_PREV_HASH', message: 'prevReceiptHash does not match latest receipt hash' };
  }

  const expectedHash = computeReceiptHash(agent.public_key, incoming);
  if (incoming.receiptHash && incoming.receiptHash !== expectedHash) {
    return { ok: false, code: 'INVALID_RECEIPT_HASH', message: 'receiptHash does not match canonical preimage' };
  }

  return {
    ok: true,
    expectedHash,
    expectedSeq,
  };
}

export function storeSignedReceipt(agent, incoming) {
  const result = validateReceiptSubmission(agent, incoming);
  if (!result.ok) return result;

  createReceipt({
    agentDbId: agent.id,
    seq: incoming.seq,
    receiptType: incoming.type || 'action',
    receiptHash: result.expectedHash,
    prevHash: incoming.prevReceiptHash || null,
    intentHash: incoming.intentHash,
    actionRef: incoming.actionRef,
    resultHash: incoming.resultHash,
    signature: incoming.signature || null,
    payload: incoming.payload || null,
    createdAt: incoming.timestamp || new Date().toISOString(),
  });

  updateAgentLastReceipt(agent.id, incoming.timestamp || new Date().toISOString());

  return {
    ok: true,
    receipt: {
      seq: incoming.seq,
      hash: result.expectedHash,
      type: incoming.type || 'action',
      timestamp: incoming.timestamp || new Date().toISOString(),
    },
  };
}

export function receiptRangeHashes(agentDbId, startSeq, endSeq) {
  const rows = listReceiptHashesInRange(agentDbId, startSeq, endSeq);
  return rows.map((r) => r.receipt_hash);
}
