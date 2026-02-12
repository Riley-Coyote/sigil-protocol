import test from 'node:test';
import assert from 'node:assert/strict';

import { computeMerkleRoot, verifyMerkleProof } from '../lib/merkle.mjs';
import { buildReceiptPreimage, computeReceiptHash } from '../lib/receipts.mjs';
import { derivePassportMintSeed, derivePassportMintAddress } from '../lib/passports.mjs';

test('merkle root is deterministic for identical leaf order', () => {
  const leaves = ['a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64), 'd'.repeat(64)];
  const rootA = computeMerkleRoot(leaves);
  const rootB = computeMerkleRoot(leaves);
  assert.equal(rootA, rootB);
});

test('merkle proof verifies simple two-leaf tree', () => {
  const leafA = 'a'.repeat(64);
  const leafB = 'b'.repeat(64);
  const root = computeMerkleRoot([leafA, leafB]);
  const valid = verifyMerkleProof({ leaf: leafA, proof: [leafB], index: 0, root });
  assert.equal(valid, true);
});

test('receipt preimage and hash are stable', () => {
  const payload = {
    type: 'tool_call',
    seq: 7,
    timestamp: '2026-02-11T00:00:00.000Z',
    intentHash: '1'.repeat(64),
    actionRef: 'tool://search?q=sigil',
    resultHash: '2'.repeat(64),
    prevReceiptHash: '3'.repeat(64),
  };
  const preimage = buildReceiptPreimage('AgentPublicKey11111111111111111111111111111', payload);
  const hashA = computeReceiptHash('AgentPublicKey11111111111111111111111111111', payload);
  const hashB = computeReceiptHash('AgentPublicKey11111111111111111111111111111', payload);
  assert.match(preimage, /SIGIL_RECEIPT_V1/);
  assert.equal(hashA, hashB);
});

test('passport seed and mint address derivation are deterministic', async () => {
  const owner = '11111111111111111111111111111111';
  const agent = 'AgentPublicKey11111111111111111111111111111';
  const seedA = derivePassportMintSeed(owner, agent);
  const seedB = derivePassportMintSeed(owner, agent);
  assert.equal(seedA, seedB);
  assert.equal(seedA.length, 32);

  const mintA = await derivePassportMintAddress(owner, agent);
  const mintB = await derivePassportMintAddress(owner, agent);
  assert.equal(mintA.mintAddress, mintB.mintAddress);
  assert.equal(mintA.seed, mintB.seed);
});
