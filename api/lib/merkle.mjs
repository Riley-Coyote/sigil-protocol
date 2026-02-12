import { createHash } from 'crypto';

function sha256Hex(input) {
  return createHash('sha256').update(input).digest('hex');
}

export function normalizeLeaf(value) {
  if (!value) return sha256Hex('');
  if (/^[a-f0-9]{64}$/i.test(value)) return value.toLowerCase();
  return sha256Hex(String(value));
}

export function computeMerkleRoot(leavesInput) {
  const leaves = leavesInput.map(normalizeLeaf);
  if (leaves.length === 0) return sha256Hex('');

  let level = [...leaves];
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i];
      const right = level[i + 1] || level[i];
      next.push(sha256Hex(`${left}${right}`));
    }
    level = next;
  }
  return level[0];
}

export function verifyMerkleProof({ leaf, proof, root, index }) {
  if (!Array.isArray(proof) || proof.length === 0) {
    return normalizeLeaf(leaf) === String(root || '').toLowerCase();
  }

  let hash = normalizeLeaf(leaf);
  let idx = Number(index || 0);

  for (const siblingRaw of proof) {
    const sibling = normalizeLeaf(siblingRaw);
    if (idx % 2 === 0) {
      hash = sha256Hex(`${hash}${sibling}`);
    } else {
      hash = sha256Hex(`${sibling}${hash}`);
    }
    idx = Math.floor(idx / 2);
  }

  return hash === String(root || '').toLowerCase();
}
