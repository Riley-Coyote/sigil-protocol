/**
 * SIGIL Protocol — ID Card Renderer v4
 * 
 * Sigil Mark algorithm ported from GPT's passport renderer.
 * 41×41 matrix with finder patterns, timing rails, SHA-256 bitstream,
 * radial wave blending, and partial symmetry in a central ring.
 */

import { createHash } from 'crypto';

// ===== HASH + PRNG =====
function fnv1a32(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

function mulberry32(a) {
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1) >>> 0;
    t ^= (t + Math.imul(t ^ (t >>> 7), t | 61)) >>> 0;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sha256hex(str) {
  return createHash('sha256').update(str).digest('hex');
}

// ===== SIGIL MARK MATRIX (41×41) =====
function buildSigilMatrix(seedStr) {
  const N = 41;
  const mat = Array.from({ length: N }, () => Array(N).fill(0));

  // Finder patterns (9×9 in 3 corners)
  function finder(fx, fy) {
    for (let j = 0; j < 9; j++) {
      for (let i = 0; i < 9; i++) {
        const xx = fx + i, yy = fy + j;
        const edge = (i === 0 || j === 0 || i === 8 || j === 8);
        const ring = (i === 2 || j === 2 || i === 6 || j === 6);
        const core = (i >= 3 && i <= 5 && j >= 3 && j <= 5);
        if (edge || ring || core) mat[yy][xx] = 1;
      }
    }
  }
  finder(1, 1);
  finder(N - 10, 1);
  finder(1, N - 10);

  // Timing rails
  for (let i = 10; i < N - 10; i++) {
    mat[9][i] = (i % 2 === 0) ? 1 : 0;
    mat[i][9] = (i % 2 === 0) ? 1 : 0;
  }

  // Alignment micro-target (7×7 in bottom-right area)
  const ax = N - 13, ay = N - 13;
  for (let j = 0; j < 7; j++) {
    for (let i = 0; i < 7; i++) {
      const xx = ax + i, yy = ay + j;
      const edge = (i === 0 || j === 0 || i === 6 || j === 6);
      const core = (i >= 2 && i <= 4 && j >= 2 && j <= 4);
      if (edge || core) mat[yy][xx] = 1;
    }
  }

  // SHA-256 bitstream (6 rounds)
  const bytes = [];
  for (let k = 0; k < 6; k++) {
    const hex = sha256hex(seedStr + '|k:' + k);
    for (let i = 0; i < hex.length; i += 2) {
      bytes.push(parseInt(hex.substr(i, 2), 16));
    }
  }
  let bitIdx = 0;
  function nextBit() {
    const byte = bytes[Math.floor(bitIdx / 8)] || 0;
    const bit = (byte >> (7 - (bitIdx % 8))) & 1;
    bitIdx++;
    return bit;
  }

  // Fill remaining cells: SHA-256 bits blended with radial wave
  const cx = (N - 1) / 2, cy = (N - 1) / 2;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      if (mat[y][x] === 1) continue;
      if (y === 0 || x === 0 || y === N - 1 || x === N - 1) continue;
      if (y === 9 || x === 9) continue;

      const b = nextBit();
      const dx = x - cx, dy = y - cy;
      const d = Math.sqrt(dx * dx + dy * dy);
      const wave = 0.5 + 0.5 * Math.sin(d * 0.65 + (x * 0.18) - (y * 0.12));
      const v = (b * 0.65) + (wave * 0.35);
      mat[y][x] = (v > 0.58) ? 1 : 0;
    }
  }

  // Enforce 2-axis symmetry in central ring (radius 9-15)
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const dx = Math.abs(x - cx), dy = Math.abs(y - cy);
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < 9 || d > 15) continue;
      const a = mat[y][x] + mat[y][N - 1 - x] + mat[N - 1 - y][x] + mat[N - 1 - y][N - 1 - x];
      const val = (a >= 2) ? 1 : 0;
      mat[y][x] = mat[y][N - 1 - x] = mat[N - 1 - y][x] = mat[N - 1 - y][N - 1 - x] = val;
    }
  }

  return mat;
}

// ===== RENDER SIGIL MARK AS SVG =====
function renderSigilMark(mat, ox, oy, size, seed32) {
  const N = mat.length;
  const pad = Math.round(size * 0.06);
  const inner = size - pad * 2;
  const mod = Math.floor(inner / N);
  const used = mod * N;
  const startX = ox + Math.floor((size - used) / 2);
  const startY = oy + Math.floor((size - used) / 2);
  const gap = Math.max(1, Math.floor(mod * 0.12)); // gap between modules

  const rnd = mulberry32(seed32 ^ 0xA51CEB1D);
  const elements = [];

  // Frame
  elements.push(`<rect x="${ox}" y="${oy}" width="${size}" height="${size}" rx="4" fill="rgba(0,0,0,0.35)" stroke="rgba(255,255,255,0.1)" stroke-width="1.5"/>`);
  elements.push(`<rect x="${ox + 4}" y="${oy + 4}" width="${size - 8}" height="${size - 8}" rx="3" fill="none" stroke="rgba(255,255,255,0.04)" stroke-width="0.5"/>`);

  // Modules
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      if (!mat[j][i]) continue;
      const mx = startX + i * mod;
      const my = startY + j * mod;
      const s = mod - gap;

      const t = rnd();
      const alpha = (0.6 + 0.35 * t).toFixed(3);

      // Finder patterns stay as solid squares
      const inFinder = (i <= 9 && j <= 9) || (i >= N - 10 && j <= 9) || (i <= 9 && j >= N - 10);

      if (inFinder || t > 0.55) {
        elements.push(`<rect x="${mx}" y="${my}" width="${s}" height="${s}" fill="rgba(220,222,225,${alpha})"/>`);
      } else {
        // Dot module for variety
        const r = s * 0.4;
        const cx = mx + s / 2;
        const cy = my + s / 2;
        elements.push(`<circle cx="${cx}" cy="${cy}" r="${r}" fill="rgba(220,222,225,${alpha})"/>`);
      }
    }
  }

  // Corner reticle marks
  const q = 6;
  const rl = 16;
  elements.push(`<g stroke="rgba(255,255,255,0.1)" stroke-width="1" fill="none">`);
  elements.push(`<path d="M${ox + q} ${oy + q + rl} L${ox + q} ${oy + q} L${ox + q + rl} ${oy + q}"/>`);
  elements.push(`<path d="M${ox + size - q} ${oy + q + rl} L${ox + size - q} ${oy + q} L${ox + size - q - rl} ${oy + q}"/>`);
  elements.push(`<path d="M${ox + q} ${oy + size - q - rl} L${ox + q} ${oy + size - q} L${ox + q + rl} ${oy + size - q}"/>`);
  elements.push(`<path d="M${ox + size - q} ${oy + size - q - rl} L${ox + size - q} ${oy + size - q} L${ox + size - q - rl} ${oy + size - q}"/>`);
  elements.push(`</g>`);

  return elements.join('\n      ');
}

// ===== GUILLOCHE BACKGROUND =====
function generateGuilloche(w, h) {
  const lines = [];
  for (let y = 0; y < h; y += 4) {
    lines.push(`<line x1="0" y1="${y}" x2="${w}" y2="${y}" stroke="rgba(255,255,255,0.012)" stroke-width="0.5"/>`);
  }
  for (let x = 0; x < w; x += 4) {
    lines.push(`<line x1="${x}" y1="0" x2="${x}" y2="${h}" stroke="rgba(255,255,255,0.008)" stroke-width="0.5"/>`);
  }
  for (let i = -h; i < w + h; i += 14) {
    lines.push(`<line x1="${i}" y1="0" x2="${i + h}" y2="${h}" stroke="rgba(255,255,255,0.006)" stroke-width="0.3"/>`);
  }
  return lines.join('\n    ');
}

// ===== MICROTEXT =====
function microtext(text, x, y, w, opacity = 0.04) {
  const repeats = Math.ceil(w / (text.length * 3.2));
  const full = (text + ' · ').repeat(repeats);
  return `<text x="${x}" y="${y}" font-size="3.5" fill="rgba(255,255,255,${opacity})" letter-spacing="0.8">${full}</text>`;
}

import { hexToBase58 } from './base58.mjs';

// ===== MAIN RENDERER =====
export function renderGlyphCard(agent) {
  const {
    publicKey,
    displayName = 'unnamed',
    glyphHash,
    tier = 0,
    status = 'pending',
    verifiedAt,
    persistenceScore = 0,
  } = agent;

  const isVerified = status === 'verified';
  const agentDid = `did:sigil:${glyphHash.slice(0, 8)}-${glyphHash.slice(8)}`;
  const shortHash = `⏀${hexToBase58(glyphHash)}`;
  const profileUrl = `sigilprotocol.xyz/agent/${glyphHash.slice(0, 8)}`;
  const shortKey = `${publicKey.slice(0, 6)}···${publicKey.slice(-5)}`;
  const tierLabels = { 0: 'tier 0 (alive)', 1: 'tier 1 (key control)', 2: 'tier 2 (staked)', 3: 'tier 3 (persistent)' };
  const tierLabel = tierLabels[tier] || `tier ${tier}`;
  const verifiedDate = verifiedAt ? new Date(verifiedAt).toISOString().split('T')[0] : '—';
  const docNumber = `SGL-${glyphHash.slice(0, 4).toUpperCase()}-${glyphHash.slice(4, 8).toUpperCase()}`;

  // Build the seed string matching GPT's format (adapted to our data)
  const seedStr = [publicKey, glyphHash, displayName, 'tier:' + tier, 'net:Solana'].join('|');
  const seed32 = fnv1a32(seedStr);

  // Serial + checksum
  const serial = sha256hex(seedStr + '|serial').slice(0, 12).toUpperCase();
  const checksum = sha256hex(seedStr + '|check').slice(0, 8).toUpperCase();

  // Receipt root preview
  const receiptRoot = sha256hex(seedStr + '|receipt_root').slice(0, 48);

  // Build matrix
  const mat = buildSigilMatrix(seedStr);

  // Layout
  const W = 560;
  const H = 380;
  const m = 20; // margin
  const markSize = 190;
  const markX = W - m - markSize - 10;
  const markY = 78;

  const fieldX = m + 12;
  const fieldW = W - markSize - m * 2 - 40;

  // Truncate long values to fit within available space
  function truncVal(str, maxChars) {
    if (str.length <= maxChars) return str;
    return str.slice(0, maxChars - 1) + '…';
  }

  const guilloche = generateGuilloche(W, H);
  const sigilMark = renderSigilMark(mat, markX, markY, markSize, seed32);

  // Field definitions — document style (label left, value right, horizontal rules)
  const labelColW = 90;
  const fields = [
    { label: 'AGENT_ID', value: truncVal(displayName, 22), bold: true },
    { label: 'DID', value: truncVal(agentDid, 28) },
    { label: 'GLYPH_HASH', value: truncVal(shortHash, 22) },
    { label: 'PROFILE', value: truncVal(profileUrl, 28) },
    { label: 'BOND', value: truncVal(tierLabel, 22) },
    { label: 'ISSUED', value: verifiedDate },
    { label: 'SERIAL', value: docNumber },
  ];

  const rowH = 28;
  const fieldStartY = 84;

  // Section title
  let fieldsSvg = `
    <text x="${fieldX}" y="${fieldStartY - 8}" font-size="6.5" font-weight="400" fill="rgba(255,255,255,0.28)" letter-spacing="2.5">IDENTITY FIELDS</text>`;

  fields.forEach((f, i) => {
    const y = fieldStartY + i * rowH;
    // Labels: light weight, wide tracking, very muted — like a form field label
    // Values: medium weight, tighter, brighter — the actual data
    fieldsSvg += `
    <text x="${fieldX}" y="${y + 16}" font-size="6.5" font-weight="400" fill="rgba(255,255,255,0.22)" letter-spacing="1.8">${f.label}</text>
    <text x="${fieldX + labelColW}" y="${y + 16}" font-size="${f.bold ? '11.5' : '9.5'}" font-weight="${f.bold ? '600' : '400'}" fill="rgba(255,255,255,${f.bold ? '0.92' : '0.72'})" letter-spacing="${f.bold ? '0.3' : '0.2'}">${f.value}</text>
    <line x1="${fieldX}" y1="${y + rowH - 2}" x2="${fieldX + fieldW}" y2="${y + rowH - 2}" stroke="rgba(255,255,255,0.03)" stroke-width="0.5"/>`;
  });

  // Receipt root box below fields
  const receiptY = fieldStartY + fields.length * rowH + 12;
  fieldsSvg += `
    <rect x="${fieldX}" y="${receiptY}" width="${fieldW}" height="52" rx="4" fill="rgba(0,0,0,0.2)" stroke="rgba(255,255,255,0.06)" stroke-width="0.75"/>
    <text x="${fieldX + 10}" y="${receiptY + 16}" font-size="6.5" font-weight="700" fill="rgba(255,255,255,0.4)" letter-spacing="1.5">LATEST RECEIPT ROOT</text>
    <text x="${fieldX + 10}" y="${receiptY + 32}" font-size="7" font-weight="600" fill="rgba(255,255,255,0.65)">root: ${receiptRoot.slice(0, 32)}…</text>
    <text x="${fieldX + 10}" y="${receiptY + 44}" font-size="5.5" fill="rgba(255,255,255,0.25)">off-chain receipts · on-chain anchored epoch roots</text>`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
  <defs>
    <style>
      @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;500;600;700&amp;display=swap');
      text { font-family: 'JetBrains Mono', 'SF Mono', 'Consolas', monospace; }
    </style>
    <clipPath id="card"><rect width="${W}" height="${H}" rx="8"/></clipPath>
  </defs>

  <g clip-path="url(#card)">
    <!-- Base -->
    <rect width="${W}" height="${H}" fill="#060606"/>
    
    <!-- Guilloche -->
    ${guilloche}
    
    <!-- Borders -->
    <rect width="${W}" height="${H}" fill="none" stroke="rgba(255,255,255,0.08)" stroke-width="1" rx="8"/>
    <rect x="5" y="5" width="${W - 10}" height="${H - 10}" fill="none" stroke="rgba(255,255,255,0.03)" stroke-width="0.5" rx="6"/>
    
    <!-- Microtext -->
    ${microtext('SIGIL PROTOCOL IDENTITY VERIFICATION SYSTEM', 7, H - 6, W - 14)}
    ${microtext('SOULBOUND CREDENTIAL NON-TRANSFERABLE ON-CHAIN VERIFIABLE', 7, 8, W - 14)}
    
    <!-- ⏀ Watermark -->
    <text x="${W / 2}" y="${H / 2 + 15}" font-size="100" fill="rgba(255,255,255,0.01)" text-anchor="middle" dominant-baseline="middle">⏀</text>
    
    <!-- Header bar -->
    <rect x="${m}" y="${m}" width="${W - m * 2}" height="42" rx="4" fill="rgba(255,255,255,0.02)" stroke="rgba(255,255,255,0.04)" stroke-width="0.5"/>
    
    <text x="${m + 12}" y="${m + 14}" font-size="6.5" font-weight="400" fill="rgba(255,255,255,0.22)" letter-spacing="3.5">SIGIL PROTOCOL</text>
    <text x="${m + 12}" y="${m + 30}" font-size="13" font-weight="600" fill="rgba(255,255,255,0.88)" letter-spacing="1.5">IDENTITY CARD</text>
    <text x="${m + 12}" y="${m + 40}" font-size="5.5" font-weight="300" fill="rgba(255,255,255,0.18)" letter-spacing="0.8">public verifiable credential</text>
    
    <!-- Doc number -->
    <text x="${W - m - 10}" y="${m + 15}" font-size="6" font-weight="300" fill="rgba(255,255,255,0.16)" text-anchor="end" letter-spacing="1.2">${docNumber}</text>
    
    <!-- Verified badge -->
    ${isVerified ? `
    <rect x="${W - m - 82}" y="${m + 22}" width="62" height="17" rx="2" fill="rgba(74,222,128,0.08)" stroke="rgba(74,222,128,0.4)" stroke-width="0.75"/>
    <circle cx="${W - m - 71}" cy="${m + 30.5}" r="2" fill="rgba(74,222,128,0.9)"/>
    <text x="${W - m - 64}" y="${m + 34}" font-size="7.5" font-weight="600" fill="rgba(74,222,128,0.9)" letter-spacing="1.2">VERIFIED</text>
    ` : `
    <rect x="${W - m - 82}" y="${m + 22}" width="62" height="17" rx="2" fill="rgba(255,255,255,0.02)" stroke="rgba(255,255,255,0.1)" stroke-width="0.75"/>
    <text x="${W - m - 51}" y="${m + 34}" font-size="7.5" font-weight="600" fill="rgba(255,255,255,0.25)" text-anchor="middle" letter-spacing="1.2">PENDING</text>
    `}
    
    <!-- Divider -->
    <line x1="${m}" y1="72" x2="${W - m}" y2="72" stroke="rgba(255,255,255,0.04)" stroke-width="0.5"/>
    
    <!-- Fields -->
    ${fieldsSvg}
    
    <!-- Sigil Mark -->
    <text x="${markX + markSize / 2}" y="${markY - 6}" font-size="6" font-weight="400" fill="rgba(255,255,255,0.2)" text-anchor="middle" letter-spacing="2.5">SIGIL MARK</text>
    ${sigilMark}
    
    <!-- Mark caption -->
    <text x="${markX + markSize / 2}" y="${markY + markSize + 14}" font-size="4.5" font-weight="300" fill="rgba(255,255,255,0.13)" text-anchor="middle" letter-spacing="1">deterministic · verifiable · unique</text>
    <text x="${markX + markSize / 2}" y="${markY + markSize + 24}" font-size="4.5" font-weight="300" fill="rgba(255,255,255,0.1)" text-anchor="middle" letter-spacing="0.5">${shortKey}</text>
    
    <!-- Footer -->
    <line x1="${m}" y1="${H - 30}" x2="${W - m}" y2="${H - 30}" stroke="rgba(255,255,255,0.04)" stroke-width="0.5"/>
    <text x="${m + 4}" y="${H - 16}" font-size="5.5" font-weight="300" fill="rgba(255,255,255,0.14)" letter-spacing="0.8">non-transferable · on-chain verifiable · soulbound</text>
    <text x="${W - m - 4}" y="${H - 16}" font-size="6" font-weight="400" fill="rgba(255,255,255,0.18)" text-anchor="end" letter-spacing="0.5">⏀ SIGIL v0.5.0</text>
    
    <!-- Serial + Checksum -->
    <text x="${m + 4}" y="${H - 6}" font-size="4" font-weight="300" fill="rgba(255,255,255,0.08)" letter-spacing="1">serial: ${serial} · checksum: ${checksum}</text>
  </g>
</svg>`;
}
