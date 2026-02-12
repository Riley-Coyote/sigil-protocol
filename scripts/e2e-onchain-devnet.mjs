#!/usr/bin/env node
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import {
  clusterApiUrl,
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
} from '@solana/web3.js';
import {
  TOKEN_2022_PROGRAM_ID,
  createMint,
  getMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from '@solana/spl-token';
import nacl from 'tweetnacl';
import bs58 from 'bs58';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const DEFAULT_RPC = clusterApiUrl('devnet');
const DEFAULT_TARGET_SOL = 1;
const STAKE_AMOUNT = 1500;

function parseArgs(argv) {
  const args = {
    rpcUrl: process.env.SOLANA_RPC_URL || DEFAULT_RPC,
    port: Number(process.env.E2E_PORT || (36000 + Math.floor(Math.random() * 700))),
    targetSol: Number(process.env.E2E_TARGET_SOL || DEFAULT_TARGET_SOL),
    fundedSecret: process.env.E2E_FUNDED_SECRET || null,
    vaultAuthoritySecret: process.env.E2E_VAULT_AUTHORITY_SECRET || null,
  };

  for (const token of argv) {
    if (token.startsWith('--rpc-url=')) {
      args.rpcUrl = token.split('=').slice(1).join('=').trim() || args.rpcUrl;
      continue;
    }
    if (token.startsWith('--port=')) {
      const value = Number(token.split('=').slice(1).join('='));
      if (Number.isFinite(value) && value > 0) args.port = value;
      continue;
    }
    if (token.startsWith('--target-sol=')) {
      const value = Number(token.split('=').slice(1).join('='));
      if (Number.isFinite(value) && value > 0) args.targetSol = value;
      continue;
    }
    if (token === '--help' || token === '-h') {
      printHelp();
      process.exit(0);
    }
  }

  return args;
}

function printHelp() {
  console.log(`SIGIL real on-chain e2e (devnet)\n\nUsage:\n  node scripts/e2e-onchain-devnet.mjs [options]\n\nOptions:\n  --rpc-url=<url>      Solana RPC URL (default: ${DEFAULT_RPC})\n  --port=<port>        Local API port for test server\n  --target-sol=<sol>   Minimum SOL to fund test keypairs with airdrop\n  -h, --help           Show help\n\nEnvironment overrides:\n  E2E_FUNDED_SECRET           funded keypair secret (base58 or JSON array)\n  E2E_VAULT_AUTHORITY_SECRET  optional separate vault authority secret\n`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createSessionId() {
  return crypto.randomBytes(24).toString('hex');
}

function signMessageBase58(message, secretKey) {
  const bytes = new TextEncoder().encode(message);
  const signature = nacl.sign.detached(bytes, secretKey);
  return bs58.encode(Buffer.from(signature));
}

function parseKeypairSecret(secret) {
  if (typeof secret !== 'string' || !secret.trim()) return null;
  const trimmed = secret.trim();
  try {
    if (trimmed.startsWith('[')) {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return Keypair.fromSecretKey(Uint8Array.from(parsed));
      }
    }
  } catch {
    // fallback to base58 parsing
  }
  try {
    return Keypair.fromSecretKey(bs58.decode(trimmed));
  } catch {
    return null;
  }
}

async function waitForHealth(baseUrl, timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const resp = await fetch(`${baseUrl}/api/health`);
      if (resp.ok) return;
    } catch {
      // ignore until process is ready
    }
    await sleep(150);
  }
  throw new Error('API server did not become healthy in time');
}

async function startServer({ port, dbPath, env }) {
  const proc = spawn('node', ['api/server.mjs'], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      SIGIL_DB_PATH: dbPath,
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stderr = '';
  proc.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  await waitForHealth(`http://localhost:${port}`);
  return { proc, stderr: () => stderr };
}

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

async function fetchJson(baseUrl, path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      'content-type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  const json = text ? JSON.parse(text) : {};
  return { ok: response.ok, status: response.status, json };
}

async function postJson(baseUrl, path, body) {
  return fetchJson(baseUrl, path, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

function mustOk(resp, context) {
  if (!resp.ok) {
    throw new Error(`${context} failed (${resp.status}): ${JSON.stringify(resp.json)}`);
  }
  return resp.json;
}

async function ensureBalance(connection, keypair, targetSol) {
  const targetLamports = Math.ceil(targetSol * LAMPORTS_PER_SOL);

  for (let attempt = 1; attempt <= 8; attempt += 1) {
    const current = await connection.getBalance(keypair.publicKey, 'confirmed');
    if (current >= targetLamports) return;

    try {
      const sig = await connection.requestAirdrop(keypair.publicKey, LAMPORTS_PER_SOL);
      await connection.confirmTransaction(sig, 'confirmed');
    } catch (err) {
      if (String(err?.message || '').includes('429 Too Many Requests')) {
        throw new Error(`Airdrop rate-limited on ${connection.rpcEndpoint}. Set E2E_FUNDED_SECRET to a funded devnet keypair or retry later.`);
      }
      if (attempt === 8) throw err;
    }

    await sleep(1000 * attempt);
  }

  const finalBalance = await connection.getBalance(keypair.publicKey, 'confirmed');
  if (finalBalance < targetLamports) {
    throw new Error(`Unable to fund ${keypair.publicKey.toBase58()} with airdrop`);
  }
}

async function submitPreparedTransaction(connection, signer, prepared) {
  assert.ok(prepared?.transactionBase64, 'Prepared transaction payload is missing');
  const txBytes = Buffer.from(prepared.transactionBase64, 'base64');
  const tx = Transaction.from(txBytes);
  tx.sign(signer);

  const signature = await connection.sendRawTransaction(tx.serialize(), {
    preflightCommitment: 'confirmed',
  });

  if (prepared.blockhash && prepared.lastValidBlockHeight) {
    await connection.confirmTransaction(
      {
        signature,
        blockhash: prepared.blockhash,
        lastValidBlockHeight: prepared.lastValidBlockHeight,
      },
      'confirmed',
    );
  } else {
    await connection.confirmTransaction(signature, 'confirmed');
  }

  return signature;
}

async function requestActionAuth({
  baseUrl,
  signer,
  publicKey,
  sessionId,
  domain,
  scope,
  action,
  payload,
}) {
  const challengeResp = await postJson(baseUrl, '/api/auth/action-challenge', {
    publicKey,
    scope,
    action,
    sessionId,
    domain,
    payload,
  });
  const challengeData = mustOk(challengeResp, `action challenge (${scope}:${action})`);
  const challenge = challengeData.challenge;
  assert.ok(challenge?.message, 'Action challenge message missing');
  assert.ok(challenge?.nonce, 'Action challenge nonce missing');

  return {
    signature: signMessageBase58(challenge.message, signer.secretKey),
    nonce: challenge.nonce,
    sessionId,
    domain,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const connection = new Connection(args.rpcUrl, 'confirmed');
  const staker = parseKeypairSecret(args.fundedSecret) || Keypair.generate();
  const vaultAuthority = parseKeypairSecret(args.vaultAuthoritySecret) || staker;
  const passportCollection = Keypair.generate().publicKey.toBase58();

  if (args.fundedSecret) {
    console.log('Using funded keypair from E2E_FUNDED_SECRET.');
  } else {
    console.log('Funding test wallet via devnet airdrop...');
    await ensureBalance(connection, staker, args.targetSol);
  }

  console.log('Creating real SPL mint + funding staker wallet...');
  const mint = await createMint(
    connection,
    staker,
    staker.publicKey,
    null,
    0,
  );
  const stakerAta = await getOrCreateAssociatedTokenAccount(
    connection,
    staker,
    mint,
    staker.publicKey,
  );
  await getOrCreateAssociatedTokenAccount(
    connection,
    staker,
    mint,
    vaultAuthority.publicKey,
    true,
  );
  await mintTo(connection, staker, mint, stakerAta.address, staker.publicKey, 25_000n);

  const tmp = mkdtempSync(join(tmpdir(), 'sigil-e2e-devnet-'));
  const dbPath = join(tmp, 'sigil.db');
  const baseUrl = `http://localhost:${args.port}`;

  const { proc, stderr } = await startServer({
    port: args.port,
    dbPath,
    env: {
      PUBLIC_BASE_URL: baseUrl,
      CORS_ORIGINS: baseUrl,
      SOLANA_NETWORK: 'devnet',
      SOLANA_RPC_URL: args.rpcUrl,
      STAKE_COOLDOWN_DAYS: '0',
      MIN_STAKE: '1',
      MAX_STAKE: '50000',
      SIGIL_STAKING_ONCHAIN: 'true',
      SIGIL_MINT: mint.toBase58(),
      SIGIL_STAKING_TOKEN_PROGRAM: 'token',
      SIGIL_STAKING_VAULT_OWNER: vaultAuthority.publicKey.toBase58(),
      SIGIL_STAKING_AUTHORITY_SECRET: JSON.stringify(Array.from(vaultAuthority.secretKey)),
      SIGIL_STAKING_PROGRAM_ID: SystemProgram.programId.toBase58(),
      SIGIL_PASSPORT_COLLECTION: passportCollection,
      SIGIL_ALLOW_LEGACY_PASSPORT_ISSUE: 'false',
    },
  });

  try {
    const stakerPublicKey = staker.publicKey.toBase58();
    const sessionId = createSessionId();
    const domain = baseUrl;

    console.log('Registering and verifying agent keypair...');
    const registerResp = await postJson(baseUrl, '/api/register', {
      publicKey: stakerPublicKey,
      displayName: 'sigil-devnet-e2e-agent',
    });
    const registerData = mustOk(registerResp, 'agent register');

    const verifyResp = await postJson(baseUrl, '/api/verify', {
      publicKey: stakerPublicKey,
      nonce: registerData.challenge.nonce,
      signature: signMessageBase58(registerData.challenge.message, staker.secretKey),
    });
    mustOk(verifyResp, 'agent verify');

    console.log('Executing real on-chain stake flow...');
    const stakePayload = {
      stakerPublicKey,
      agentPublicKey: stakerPublicKey,
      amount: STAKE_AMOUNT,
    };
    const stakeAuth = await requestActionAuth({
      baseUrl,
      signer: staker,
      publicKey: stakerPublicKey,
      sessionId,
      domain,
      scope: 'staking',
      action: 'stake',
      payload: stakePayload,
    });
    const stakePrepareResp = await postJson(baseUrl, '/api/staking/stake-prepare', {
      ...stakePayload,
      ...stakeAuth,
    });
    const stakePrepared = mustOk(stakePrepareResp, 'stake prepare');
    const stakeTxSignature = await submitPreparedTransaction(connection, staker, stakePrepared);

    const stakeFinalizeAuth = await requestActionAuth({
      baseUrl,
      signer: staker,
      publicKey: stakerPublicKey,
      sessionId,
      domain,
      scope: 'staking',
      action: 'stake',
      payload: {
        ...stakePayload,
        txSignature: stakeTxSignature,
      },
    });
    const stakeFinalizeResp = await postJson(baseUrl, '/api/staking/stake-finalize', {
      ...stakePayload,
      txSignature: stakeTxSignature,
      ...stakeFinalizeAuth,
    });
    mustOk(stakeFinalizeResp, 'stake finalize');

    const positionsAfterStakeResp = await fetchJson(baseUrl, `/api/staking/positions/${encodeURIComponent(stakerPublicKey)}`, {
      headers: {},
    });
    const positionsAfterStake = mustOk(positionsAfterStakeResp, 'positions after stake');
    const stakedPosition = (positionsAfterStake.positions || []).find((row) => row.agentPublicKey === stakerPublicKey);
    assert.ok(stakedPosition, 'Expected staked position to exist');
    assert.equal(Number(stakedPosition.amount || 0), STAKE_AMOUNT, 'Unexpected staked amount after finalize');

    console.log('Executing complete-unstake prepare/finalize flow...');
    const beginUnstakePayload = {
      stakerPublicKey,
      agentPublicKey: stakerPublicKey,
      amount: STAKE_AMOUNT,
    };
    const beginAuth = await requestActionAuth({
      baseUrl,
      signer: staker,
      publicKey: stakerPublicKey,
      sessionId,
      domain,
      scope: 'staking',
      action: 'begin_unstake',
      payload: beginUnstakePayload,
    });
    const beginResp = await postJson(baseUrl, '/api/staking/begin-unstake', {
      ...beginUnstakePayload,
      ...beginAuth,
    });
    mustOk(beginResp, 'begin unstake');

    const completePayload = {
      stakerPublicKey,
      agentPublicKey: stakerPublicKey,
    };
    const completePrepareAuth = await requestActionAuth({
      baseUrl,
      signer: staker,
      publicKey: stakerPublicKey,
      sessionId,
      domain,
      scope: 'staking',
      action: 'complete_unstake',
      payload: completePayload,
    });
    const completePrepareResp = await postJson(baseUrl, '/api/staking/complete-unstake-prepare', {
      ...completePayload,
      ...completePrepareAuth,
    });
    const completePrepared = mustOk(completePrepareResp, 'complete unstake prepare');
    const completeTxSignature = await submitPreparedTransaction(connection, staker, completePrepared);

    const completeFinalizeAuth = await requestActionAuth({
      baseUrl,
      signer: staker,
      publicKey: stakerPublicKey,
      sessionId,
      domain,
      scope: 'staking',
      action: 'complete_unstake',
      payload: {
        ...completePayload,
        returnAmountTokens: Number(completePrepared.returnAmountTokens || STAKE_AMOUNT),
        txSignature: completeTxSignature,
      },
    });
    const completeFinalizeResp = await postJson(baseUrl, '/api/staking/complete-unstake-finalize', {
      ...completePayload,
      txSignature: completeTxSignature,
      ...completeFinalizeAuth,
    });
    mustOk(completeFinalizeResp, 'complete unstake finalize');

    const positionsAfterUnstakeResp = await fetchJson(baseUrl, `/api/staking/positions/${encodeURIComponent(stakerPublicKey)}`);
    const positionsAfterUnstake = mustOk(positionsAfterUnstakeResp, 'positions after unstake');
    const remaining = (positionsAfterUnstake.positions || []).find((row) => row.agentPublicKey === stakerPublicKey);
    assert.ok(!remaining || Number(remaining.amount || 0) === 0, 'Expected no active stake after complete unstake');

    console.log('Executing real Token-2022 passport mint flow...');
    const passportIssuePayload = {
      agentPublicKey: stakerPublicKey,
      ownerPublicKey: stakerPublicKey,
    };
    const issueAuth = await requestActionAuth({
      baseUrl,
      signer: staker,
      publicKey: stakerPublicKey,
      sessionId,
      domain,
      scope: 'passport',
      action: 'issue',
      payload: passportIssuePayload,
    });
    const passportPrepareResp = await postJson(baseUrl, `/api/passport/${encodeURIComponent(stakerPublicKey)}/mint-prepare`, {
      ownerPublicKey: stakerPublicKey,
      ...issueAuth,
    });
    const passportPrepared = mustOk(passportPrepareResp, 'passport mint prepare');

    const passportTxSignature = passportPrepared.alreadyExists
      ? null
      : await submitPreparedTransaction(connection, staker, passportPrepared);

    const finalizeAuth = await requestActionAuth({
      baseUrl,
      signer: staker,
      publicKey: stakerPublicKey,
      sessionId,
      domain,
      scope: 'passport',
      action: 'finalize',
      payload: {
        ...passportIssuePayload,
        mintAddress: passportPrepared.mintAddress,
        txSignature: passportTxSignature,
      },
    });
    const passportFinalizeResp = await postJson(baseUrl, `/api/passport/${encodeURIComponent(stakerPublicKey)}/mint-finalize`, {
      ownerPublicKey: stakerPublicKey,
      mintAddress: passportPrepared.mintAddress,
      txSignature: passportTxSignature,
      ...finalizeAuth,
    });
    mustOk(passportFinalizeResp, 'passport mint finalize');

    const passportLookupResp = await fetchJson(baseUrl, `/api/passport/${encodeURIComponent(stakerPublicKey)}`);
    const passport = mustOk(passportLookupResp, 'passport lookup');
    assert.equal(passport.status, 'minted', 'Passport status should be minted');
    assert.equal(passport.onChain, true, 'Passport should be marked onChain=true');
    assert.equal(passport.mintAddress, passportPrepared.mintAddress, 'Passport mint mismatch');

    const mintedState = await getMint(
      connection,
      new PublicKey(passportPrepared.mintAddress),
      'confirmed',
      TOKEN_2022_PROGRAM_ID,
    );
    assert.equal(mintedState.supply, 1n, 'Passport mint supply must be 1');
    assert.equal(mintedState.mintAuthority, null, 'Passport mint authority must be revoked');

    const readinessResp = await fetchJson(baseUrl, '/api/readiness');
    const readiness = mustOk(readinessResp, 'readiness check');
    assert.equal(readiness.productionReady, true, 'Readiness should report productionReady=true under full env config');

    console.log('\nE2E SUCCESS');
    console.log(`- Agent: ${stakerPublicKey}`);
    console.log(`- Staking mint: ${mint.toBase58()}`);
    console.log(`- Stake tx: ${stakeTxSignature}`);
    console.log(`- Complete unstake tx: ${completeTxSignature}`);
    console.log(`- Passport mint: ${passportPrepared.mintAddress}`);
    if (passportTxSignature) {
      console.log(`- Passport tx: ${passportTxSignature}`);
    }
    console.log(`- API readiness: productionReady=${readiness.productionReady}`);
  } catch (err) {
    console.error(`\nE2E FAILED: ${err.message}`);
    if (stderr()) {
      console.error('\nServer stderr:\n' + stderr());
    }
    process.exitCode = 1;
  } finally {
    await stopServer(proc);
    rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(`Fatal error: ${err.message}`);
  process.exit(1);
});
