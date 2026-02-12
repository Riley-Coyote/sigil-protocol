import { createHash } from 'crypto';
import { PublicKey } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';

function sha256Hex(input) {
  return createHash('sha256').update(input).digest('hex');
}

export function buildPassportMetadata({ agent, baseUrl, collectionAddress = null }) {
  const passportId = `sigil-passport-${agent.glyph_hash}`;
  const image = `${baseUrl}/api/glyph/${encodeURIComponent(agent.public_key)}`;
  const collection = collectionAddress
    ? { name: 'SIGIL Passport Collection', family: collectionAddress }
    : undefined;
  return {
    name: `${agent.display_name || 'Anonymous Agent'} · SIGIL Passport`,
    symbol: 'SIGIL',
    description: 'Soulbound AI agent identity passport for SIGIL Protocol.',
    image,
    external_url: `${baseUrl}/agent.html?key=${encodeURIComponent(agent.public_key)}`,
    attributes: [
      { trait_type: 'Protocol', value: 'SIGIL' },
      { trait_type: 'Public Key', value: agent.public_key },
      { trait_type: 'Glyph Hash', value: agent.glyph_hash },
      { trait_type: 'Tier', value: String(agent.tier || 1) },
      { trait_type: 'Verified At', value: agent.verified_at || '' },
      { trait_type: 'Soulbound', value: 'true' },
    ],
    properties: {
      category: 'image',
      creators: [],
      files: [{ uri: image, type: 'image/svg+xml' }],
      collection,
    },
    extensions: {
      passport_id: passportId,
      standard: 'sigil-passport-v1',
      soulbound: true,
      collection: collectionAddress || null,
    },
  };
}

export function deterministicPassportMint(publicKey, glyphHash) {
  // Placeholder mint-like deterministic identifier for environments
  // where production minting infra is not configured.
  const digest = sha256Hex(`${publicKey}:${glyphHash}:sigil-passport-v1`);
  return `SIM${digest.slice(0, 40).toUpperCase()}`;
}

export function normalizeMetadataUri(baseUrl, publicKey) {
  return `${baseUrl}/api/passport/${encodeURIComponent(publicKey)}/metadata`;
}

export function derivePassportMintSeed(ownerPublicKey, agentPublicKey) {
  const digest = sha256Hex(`sigil-passport-v1:${ownerPublicKey}:${agentPublicKey}`);
  // createWithSeed enforces <= 32 bytes seed.
  return digest.slice(0, 32);
}

export async function derivePassportMintAddress(ownerPublicKey, agentPublicKey) {
  const owner = new PublicKey(ownerPublicKey);
  const seed = derivePassportMintSeed(ownerPublicKey, agentPublicKey);
  const mint = await PublicKey.createWithSeed(owner, seed, TOKEN_2022_PROGRAM_ID);
  return {
    seed,
    mintAddress: mint.toBase58(),
  };
}
