import { nanoid } from 'nanoid';
import nacl from 'tweetnacl';
import bs58 from 'bs58';

const BASE58_REGEX = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * Validate a Solana public key format (base58, 32-44 chars).
 */
export function isValidPublicKey(key) {
  if (!key || typeof key !== 'string') return false;
  return BASE58_REGEX.test(key);
}

/**
 * Generate a challenge for an agent to sign.
 * Returns { nonce, message, expiresAt }
 */
export function generateChallenge() {
  const nonce = nanoid(32);
  const timestamp = Date.now();
  const message = `SIGIL:VERIFY:${nonce}:${timestamp}`;
  const expiresAt = new Date(timestamp + 5 * 60 * 1000).toISOString(); // 5 minutes

  return { nonce, message, expiresAt };
}

/**
 * Verify an Ed25519 signature against a message and public key.
 * @param {string} message - The original message that was signed
 * @param {string} signatureBase58 - Base58-encoded signature
 * @param {string} publicKeyBase58 - Base58-encoded public key
 * @returns {boolean}
 */
export function verifySignature(message, signatureBase58, publicKeyBase58) {
  try {
    const messageBytes = new TextEncoder().encode(message);
    const signatureBytes = bs58.decode(signatureBase58);
    const publicKeyBytes = bs58.decode(publicKeyBase58);

    if (signatureBytes.length !== 64) return false;
    if (publicKeyBytes.length !== 32) return false;

    return nacl.sign.detached.verify(messageBytes, signatureBytes, publicKeyBytes);
  } catch {
    return false;
  }
}

/**
 * Check if a challenge has expired.
 */
export function isChallengeExpired(expiresAt) {
  return new Date(expiresAt) < new Date();
}
