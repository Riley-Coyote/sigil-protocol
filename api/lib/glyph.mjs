import { createHash } from 'crypto';

/**
 * Generate a deterministic glyph hash from a public key.
 * First 16 hex chars of SHA-256(publicKey).
 */
export function generateGlyphHash(publicKey) {
  return createHash('sha256').update(publicKey).digest('hex').substring(0, 16);
}

/**
 * Generate a receipt hash.
 * SHA-256 of `${publicKey}:${receiptType}:${timestamp}`
 */
export function generateReceiptHash(publicKey, receiptType, timestamp) {
  const input = `${publicKey}:${receiptType}:${timestamp}`;
  return createHash('sha256').update(input).digest('hex');
}
