/**
 * SIGIL Protocol — Input Validation Middleware
 * 
 * Validates and sanitizes request bodies before they hit route handlers.
 * Rejects malformed input early with clear error messages.
 */

// Max lengths for string fields
const LIMITS = {
  publicKey: 64,       // Solana base58 pubkeys are 32-44 chars
  displayName: 64,
  nonce: 128,
  signature: 256,
};

// Solana base58 character set
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

// Display name: alphanumeric, hyphens, underscores, spaces. No special chars.
const DISPLAY_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9 _-]{0,62}[a-zA-Z0-9]$/;

/**
 * Sanitize a string: trim, remove null bytes, limit length.
 */
function sanitize(str, maxLen) {
  if (typeof str !== 'string') return str;
  return str.trim().replace(/\0/g, '').slice(0, maxLen);
}

/**
 * Validate registration request body.
 */
export function validateRegister(req, res, next) {
  const { publicKey, displayName } = req.body;

  if (!publicKey || typeof publicKey !== 'string') {
    return res.status(400).json({ error: 'publicKey is required and must be a string', code: 'INVALID_INPUT' });
  }

  const cleanKey = sanitize(publicKey, LIMITS.publicKey);
  if (!BASE58_RE.test(cleanKey)) {
    return res.status(400).json({ error: 'Invalid public key format (expected Solana base58)', code: 'INVALID_KEY' });
  }

  // Sanitize display name if provided
  if (displayName !== undefined && displayName !== null) {
    if (typeof displayName !== 'string') {
      return res.status(400).json({ error: 'displayName must be a string', code: 'INVALID_INPUT' });
    }
    const cleanName = sanitize(displayName, LIMITS.displayName);
    if (cleanName.length > 0 && !DISPLAY_NAME_RE.test(cleanName)) {
      return res.status(400).json({
        error: 'displayName must be alphanumeric (hyphens, underscores, spaces allowed), 2-64 chars',
        code: 'INVALID_INPUT'
      });
    }
    req.body.displayName = cleanName || null;
  }

  req.body.publicKey = cleanKey;
  next();
}

/**
 * Validate verification request body.
 */
export function validateVerify(req, res, next) {
  const { publicKey, nonce, signature } = req.body;

  if (!publicKey || typeof publicKey !== 'string') {
    return res.status(400).json({ error: 'publicKey is required', code: 'INVALID_INPUT' });
  }
  if (!nonce || typeof nonce !== 'string') {
    return res.status(400).json({ error: 'nonce is required', code: 'INVALID_INPUT' });
  }
  if (!signature || typeof signature !== 'string') {
    return res.status(400).json({ error: 'signature is required', code: 'INVALID_INPUT' });
  }

  const cleanKey = sanitize(publicKey, LIMITS.publicKey);
  if (!BASE58_RE.test(cleanKey)) {
    return res.status(400).json({ error: 'Invalid public key format', code: 'INVALID_KEY' });
  }

  req.body.publicKey = cleanKey;
  req.body.nonce = sanitize(nonce, LIMITS.nonce);
  req.body.signature = sanitize(signature, LIMITS.signature);
  next();
}

/**
 * Reject oversized request bodies (defense against payload bombs).
 */
export function maxBodySize(maxBytes = 10 * 1024) {
  return (req, res, next) => {
    const contentLength = parseInt(req.headers['content-length'] || '0', 10);
    if (contentLength > maxBytes) {
      return res.status(413).json({ error: 'Request body too large', code: 'PAYLOAD_TOO_LARGE' });
    }
    next();
  };
}
