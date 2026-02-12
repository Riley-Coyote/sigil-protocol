import { createAnchor, getLatestAnchor } from './database.mjs';
import { computeMerkleRoot } from './merkle.mjs';
import { receiptRangeHashes } from './receipts.mjs';

export function validateAnchorRange({ startSeq, endSeq }) {
  if (!Number.isInteger(startSeq) || !Number.isInteger(endSeq)) {
    return { ok: false, code: 'INVALID_RANGE', message: 'startSeq and endSeq must be integers' };
  }
  if (startSeq <= 0 || endSeq <= 0 || endSeq < startSeq) {
    return { ok: false, code: 'INVALID_RANGE', message: 'Anchor range must be positive and contiguous' };
  }
  return { ok: true };
}

export function canAnchorRange(agentDbId, startSeq) {
  const latest = getLatestAnchor(agentDbId);
  if (!latest) return { ok: true };
  if (startSeq !== latest.range_end + 1) {
    return {
      ok: false,
      code: 'NON_CONTIGUOUS_RANGE',
      message: `Next anchor must start at seq ${latest.range_end + 1}`,
      latest,
    };
  }
  return { ok: true, latest };
}

export function buildAnchorForRange(agentDbId, startSeq, endSeq) {
  const hashes = receiptRangeHashes(agentDbId, startSeq, endSeq);
  if (hashes.length !== (endSeq - startSeq + 1)) {
    return {
      ok: false,
      code: 'MISSING_RECEIPTS',
      message: 'Receipt range is incomplete; cannot anchor',
      expected: endSeq - startSeq + 1,
      found: hashes.length,
    };
  }

  const merkleRoot = computeMerkleRoot(hashes);
  return {
    ok: true,
    merkleRoot,
    receiptCount: hashes.length,
    hashes,
  };
}

export function persistAnchor(agentDbId, {
  merkleRoot,
  startSeq,
  endSeq,
  receiptCount,
  txSignature,
  evidenceUri,
}) {
  createAnchor({
    agentDbId,
    merkleRoot,
    rangeStart: startSeq,
    rangeEnd: endSeq,
    receiptCount,
    txSignature: txSignature || null,
    evidenceUri: evidenceUri || null,
  });
}
