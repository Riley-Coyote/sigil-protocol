/**
 * SIGIL Protocol — Tiered Rate Limiter
 * 
 * Per-IP sliding window with configurable limits per route tier.
 * Tiers: strict (registration), moderate (verification), relaxed (reads).
 */

const buckets = new Map(); // key: `${ip}:${tier}` → { timestamps[] }

// Cleanup stale entries every 2 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of buckets) {
    // Remove if no requests in 2× the longest window (30 min)
    if (now - entry.lastSeen > 30 * 60 * 1000) {
      buckets.delete(key);
    }
  }
}, 2 * 60 * 1000).unref();

/**
 * Create a rate limiter middleware with specific limits.
 * @param {number} max - Max requests allowed in window
 * @param {number} windowMs - Window size in milliseconds
 * @param {string} tier - Bucket tier name (for per-route separation)
 */
export function createRateLimit(max, windowMs, tier = 'default') {
  return (req, res, next) => {
    const ip = req.ip || req.headers['x-forwarded-for'] || req.connection.remoteAddress || 'unknown';
    const key = `${ip}:${tier}`;
    const now = Date.now();

    let entry = buckets.get(key);
    if (!entry) {
      entry = { timestamps: [], lastSeen: now };
      buckets.set(key, entry);
    }
    entry.lastSeen = now;

    // Sliding window: remove timestamps outside the window
    entry.timestamps = entry.timestamps.filter(t => now - t < windowMs);

    if (entry.timestamps.length >= max) {
      const retryAfter = Math.ceil((entry.timestamps[0] + windowMs - now) / 1000);
      res.set('Retry-After', String(retryAfter));
      res.set('X-RateLimit-Limit', String(max));
      res.set('X-RateLimit-Remaining', '0');
      res.set('X-RateLimit-Reset', String(Math.ceil((entry.timestamps[0] + windowMs) / 1000)));

      console.log(`[RATE LIMIT] ${ip} blocked on ${tier} (${entry.timestamps.length}/${max} in ${windowMs / 1000}s)`);

      return res.status(429).json({
        error: `Rate limit exceeded. Try again in ${retryAfter} seconds.`,
        code: 'RATE_LIMITED',
        retryAfter
      });
    }

    entry.timestamps.push(now);

    // Set rate limit headers
    res.set('X-RateLimit-Limit', String(max));
    res.set('X-RateLimit-Remaining', String(max - entry.timestamps.length));

    next();
  };
}

// Pre-configured tiers
export const strictLimit = createRateLimit(3, 15 * 60 * 1000, 'strict');     // 3 per 15 min (registration)
export const moderateLimit = createRateLimit(5, 5 * 60 * 1000, 'moderate');  // 5 per 5 min (verification)
export const relaxedLimit = createRateLimit(60, 60 * 1000, 'relaxed');       // 60 per min (reads)
export const actionChallengeLimit = createRateLimit(20, 5 * 60 * 1000, 'action_challenge'); // nonce challenges
export const mutationLimit = createRateLimit(20, 5 * 60 * 1000, 'mutation'); // signed state changes

// Global fallback — catches anything not explicitly limited
export const globalLimit = createRateLimit(120, 60 * 1000, 'global');        // 120 per min overall

// Backward compat
export const rateLimit = relaxedLimit;
