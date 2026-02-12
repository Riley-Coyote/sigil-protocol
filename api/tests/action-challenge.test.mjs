import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import nacl from 'tweetnacl';
import bs58 from 'bs58';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function signMessage(message, secretKey) {
  const bytes = new TextEncoder().encode(message);
  const sig = nacl.sign.detached(bytes, secretKey);
  return bs58.encode(Buffer.from(sig));
}

async function waitForHealth(baseUrl, timeoutMs = 12000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const resp = await fetch(`${baseUrl}/api/health`);
      if (resp.ok) return;
    } catch {
      // server not ready yet
    }
    await sleep(120);
  }
  throw new Error('Server did not become healthy in time');
}

async function startServer({ port, dbPath, extraEnv = {} }) {
  const proc = spawn('node', ['api/server.mjs'], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      SIGIL_DB_PATH: dbPath,
      CORS_ORIGINS: `http://localhost:${port}`,
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stderr = '';
  proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  proc.stdout.on('data', () => {});

  try {
    await waitForHealth(`http://localhost:${port}`);
    return { proc, stderr: () => stderr };
  } catch (err) {
    if (proc.exitCode == null) proc.kill('SIGTERM');
    throw err;
  }
}

test('readiness endpoint reports blocking config and truthful health feature flags', { timeout: 30000 }, async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'sigil-readiness-test-'));
  const dbPath = join(tmp, 'sigil.db');
  const port = 35000 + Math.floor(Math.random() * 900);
  const base = `http://localhost:${port}`;

  const { proc } = await startServer({
    port,
    dbPath,
    extraEnv: {
      SIGIL_STAKING_ONCHAIN: 'true',
      SIGIL_MINT: 'not-a-key',
      SIGIL_STAKING_VAULT_OWNER: 'bad-key',
      SIGIL_STAKING_PROGRAM_ID: 'bad-program',
      SIGIL_PASSPORT_COLLECTION: 'bad-collection',
    },
  });

  try {
    const readiness = await getJson(`${base}/api/readiness`);
    assert.equal(readiness.ok, true, `readiness failed: ${JSON.stringify(readiness.json)}`);
    assert.equal(readiness.json.productionReady, false);

    const byKey = new Map((readiness.json.checks || []).map((check) => [check.key, check]));
    assert.equal(byKey.get('staking.onchain_enabled')?.pass, true);
    assert.equal(byKey.get('staking.mint_address')?.pass, false);
    assert.equal(byKey.get('staking.vault_owner')?.pass, false);
    assert.equal(byKey.get('staking.program_id')?.pass, false);
    assert.equal(byKey.get('passport.collection')?.pass, false);

    const health = await getJson(`${base}/api/health`);
    assert.equal(health.ok, true, `health failed: ${JSON.stringify(health.json)}`);
    assert.equal(health.json.productionReady, false);
    assert.equal(health.json.features?.stakingOnChainEnabled, true);
    assert.equal(health.json.features?.stakingOnChainReady, false);
    assert.equal(health.json.features?.stakingProgramConfigured, false);
    assert.equal(health.json.features?.passportCollectionConfigured, false);
  } finally {
    await stopServer(proc);
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('on-chain stake finalize requires signed action challenge', { timeout: 30000 }, async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'sigil-finalize-auth-test-'));
  const dbPath = join(tmp, 'sigil.db');
  const port = 34000 + Math.floor(Math.random() * 900);
  const base = `http://localhost:${port}`;

  const { proc } = await startServer({
    port,
    dbPath,
    extraEnv: {
      SIGIL_STAKING_ONCHAIN: 'true',
      SIGIL_MINT: '4jja37YHJWuGBHMicmHXFUENa7DpD7JcUUS47C4QBAGS',
      SIGIL_STAKING_VAULT_OWNER: 'FJPwP1KPByGQiHyrahSNdX2ruD5ARynrk3EURxgg8u6u',
    },
  });

  try {
    const kp = nacl.sign.keyPair();
    const publicKey = bs58.encode(Buffer.from(kp.publicKey));

    const reg = await postJson(`${base}/api/register`, {
      publicKey,
      displayName: 'finalize-auth-test-agent',
    }, base);
    assert.equal(reg.ok, true, `register failed: ${JSON.stringify(reg.json)}`);

    const verifySig = signMessage(reg.json.challenge.message, kp.secretKey);
    const verify = await postJson(`${base}/api/verify`, {
      publicKey,
      nonce: reg.json.challenge.nonce,
      signature: verifySig,
    }, base);
    assert.equal(verify.ok, true, `verify failed: ${JSON.stringify(verify.json)}`);

    const finalize = await postJson(`${base}/api/staking/stake-finalize`, {
      stakerPublicKey: publicKey,
      agentPublicKey: publicKey,
      amount: 1500,
      txSignature: '2'.repeat(64),
    }, base);

    assert.equal(finalize.ok, false);
    assert.equal(finalize.status, 400);
    assert.equal(finalize.json.code, 'INVALID_SIGNATURE');
  } finally {
    await stopServer(proc);
    rmSync(tmp, { recursive: true, force: true });
  }
});

async function stopServer(proc) {
  if (proc.exitCode != null) return;
  proc.kill('SIGTERM');
  await Promise.race([
    once(proc, 'exit'),
    sleep(5000).then(() => {
      if (proc.exitCode == null) proc.kill('SIGKILL');
    }),
  ]);
}

async function postJson(url, body, origin) {
  const headers = { 'content-type': 'application/json' };
  if (origin) headers.origin = origin;
  const resp = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const json = await resp.json().catch(() => ({}));
  return { status: resp.status, ok: resp.ok, json };
}

async function getJson(url, origin) {
  const headers = {};
  if (origin) headers.origin = origin;
  const resp = await fetch(url, { headers });
  const json = await resp.json().catch(() => ({}));
  return { status: resp.status, ok: resp.ok, json };
}

test('action challenge is replay-safe and bound to session/domain', { timeout: 35000 }, async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'sigil-action-test-'));
  const dbPath = join(tmp, 'sigil.db');
  const port = 33000 + Math.floor(Math.random() * 900);
  const base = `http://localhost:${port}`;
  const domain = base;
  const sessionId = 'session_abc123XYZ987654321';

  const { proc } = await startServer({ port, dbPath });
  try {
    const kp = nacl.sign.keyPair();
    const publicKey = bs58.encode(Buffer.from(kp.publicKey));

    const reg = await postJson(`${base}/api/register`, {
      publicKey,
      displayName: 'action-test-agent',
    });
    assert.equal(reg.ok, true, `register failed: ${JSON.stringify(reg.json)}`);
    assert.ok(reg.json?.challenge?.message);
    assert.ok(reg.json?.challenge?.nonce);

    const verifySignature = signMessage(reg.json.challenge.message, kp.secretKey);
    const verify = await postJson(`${base}/api/verify`, {
      publicKey,
      nonce: reg.json.challenge.nonce,
      signature: verifySignature,
    });
    assert.equal(verify.ok, true, `verify failed: ${JSON.stringify(verify.json)}`);

    const verifyApiLoose = await getJson(
      `${base}/api/verification/agent/${encodeURIComponent(publicKey)}?requirePassport=0`,
      domain,
    );
    assert.equal(verifyApiLoose.ok, true, `verification(loose) failed: ${JSON.stringify(verifyApiLoose.json)}`);
    assert.equal(Boolean(verifyApiLoose.json.attestation?.criticalPass), true);

    const verifyApiStrict = await getJson(
      `${base}/api/verification/agent/${encodeURIComponent(publicKey)}?requirePassport=1`,
      domain,
    );
    assert.equal(verifyApiStrict.ok, true, `verification(strict) failed: ${JSON.stringify(verifyApiStrict.json)}`);
    assert.equal(Boolean(verifyApiStrict.json.attestation?.criticalPass), false);

    const verifyCompact = await getJson(
      `${base}/api/verification/agent/${encodeURIComponent(publicKey)}/compact?requirePassport=0`,
      domain,
    );
    assert.equal(verifyCompact.ok, true, `verification(compact) failed: ${JSON.stringify(verifyCompact.json)}`);
    assert.equal(Boolean(verifyCompact.json.criticalPass), true);

    const badgeResp = await fetch(
      `${base}/api/verification/badge/${encodeURIComponent(publicKey)}.svg?requirePassport=0`,
      { headers: { origin: domain } },
    );
    const badgeBody = await badgeResp.text();
    assert.equal(badgeResp.ok, true, `badge failed: ${badgeBody}`);
    assert.equal(badgeBody.includes('<svg'), true);
    assert.equal(badgeBody.includes('PASS'), true);

    const stakingPrepareDisabled = await postJson(`${base}/api/staking/stake-prepare`, {
      stakerPublicKey: publicKey,
      agentPublicKey: publicKey,
      amount: 1500,
    }, domain);
    assert.equal(stakingPrepareDisabled.ok, false);
    assert.equal(stakingPrepareDisabled.json.code, 'STAKING_ONCHAIN_DISABLED');

    const payload = {
      stakerPublicKey: publicKey,
      agentPublicKey: publicKey,
      amount: 1500,
    };

    const challenge = await postJson(`${base}/api/auth/action-challenge`, {
      publicKey,
      scope: 'staking',
      action: 'stake',
      sessionId,
      domain,
      payload,
    }, domain);
    assert.equal(challenge.ok, true, `challenge failed: ${JSON.stringify(challenge.json)}`);
    assert.ok(challenge.json.challenge?.message);
    assert.ok(challenge.json.challenge?.nonce);

    const challengeSig = signMessage(challenge.json.challenge.message, kp.secretKey);
    const stake = await postJson(`${base}/api/staking/stake`, {
      ...payload,
      nonce: challenge.json.challenge.nonce,
      signature: challengeSig,
      sessionId,
      domain,
    }, domain);
    assert.equal(stake.ok, true, `stake failed: ${JSON.stringify(stake.json)}`);

    const replay = await postJson(`${base}/api/staking/stake`, {
      ...payload,
      nonce: challenge.json.challenge.nonce,
      signature: challengeSig,
      sessionId,
      domain,
    }, domain);
    assert.equal(replay.ok, false);
    assert.equal(replay.json.code, 'CHALLENGE_USED');

    const challenge2 = await postJson(`${base}/api/auth/action-challenge`, {
      publicKey,
      scope: 'staking',
      action: 'stake',
      sessionId,
      domain,
      payload,
    }, domain);
    assert.equal(challenge2.ok, true, `second challenge failed: ${JSON.stringify(challenge2.json)}`);
    const challengeSig2 = signMessage(challenge2.json.challenge.message, kp.secretKey);

    const badSession = await postJson(`${base}/api/staking/stake`, {
      ...payload,
      nonce: challenge2.json.challenge.nonce,
      signature: challengeSig2,
      sessionId: 'session_DIFFERENT_1234567890',
      domain,
    }, domain);
    assert.equal(badSession.ok, false);
    assert.equal(badSession.json.code, 'INVALID_SESSION');

    const payloadMismatch = await postJson(`${base}/api/staking/stake`, {
      ...payload,
      amount: 1555,
      nonce: challenge2.json.challenge.nonce,
      signature: challengeSig2,
      sessionId,
      domain,
    }, domain);
    assert.equal(payloadMismatch.ok, false);
    assert.equal(payloadMismatch.json.code, 'PAYLOAD_MISMATCH');

    const originMismatch = await postJson(`${base}/api/auth/action-challenge`, {
      publicKey,
      scope: 'staking',
      action: 'stake',
      sessionId,
      domain: 'http://localhost:3000',
      payload,
    }, domain);
    assert.equal(originMismatch.ok, false);
    assert.equal(originMismatch.json.code, 'ORIGIN_MISMATCH');

    const passportChallenge = await postJson(`${base}/api/auth/action-challenge`, {
      publicKey,
      scope: 'passport',
      action: 'issue',
      sessionId,
      domain,
      payload: {
        agentPublicKey: publicKey,
        ownerPublicKey: publicKey,
      },
    }, domain);
    assert.equal(passportChallenge.ok, true, `passport challenge failed: ${JSON.stringify(passportChallenge.json)}`);
    const passportSig = signMessage(passportChallenge.json.challenge.message, kp.secretKey);

    const badPassportSession = await postJson(`${base}/api/passport/${encodeURIComponent(publicKey)}/mint-prepare`, {
      ownerPublicKey: publicKey,
      signature: passportSig,
      nonce: passportChallenge.json.challenge.nonce,
      sessionId: 'session_DIFFERENT_1234567890',
      domain,
    }, domain);
    assert.equal(badPassportSession.ok, false);
    assert.equal(badPassportSession.json.code, 'INVALID_SESSION');

    const finalizeChallenge = await postJson(`${base}/api/auth/action-challenge`, {
      publicKey,
      scope: 'passport',
      action: 'finalize',
      sessionId,
      domain,
      payload: {
        agentPublicKey: publicKey,
        ownerPublicKey: publicKey,
        mintAddress: publicKey,
        txSignature: null,
      },
    }, domain);
    assert.equal(finalizeChallenge.ok, true, `finalize challenge failed: ${JSON.stringify(finalizeChallenge.json)}`);
    const finalizeSig = signMessage(finalizeChallenge.json.challenge.message, kp.secretKey);

    const badFinalizeSession = await postJson(`${base}/api/passport/${encodeURIComponent(publicKey)}/mint-finalize`, {
      ownerPublicKey: publicKey,
      mintAddress: publicKey,
      txSignature: null,
      signature: finalizeSig,
      nonce: finalizeChallenge.json.challenge.nonce,
      sessionId: 'session_DIFFERENT_1234567890',
      domain,
    }, domain);
    assert.equal(badFinalizeSession.ok, false);
    assert.equal(badFinalizeSession.json.code, 'INVALID_SESSION');
  } finally {
    await stopServer(proc);
    rmSync(tmp, { recursive: true, force: true });
  }
});
