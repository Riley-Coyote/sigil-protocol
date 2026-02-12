#!/usr/bin/env node
import crypto from 'crypto';

import { Connection, Keypair, PublicKey, Transaction } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import nacl from 'tweetnacl';
import bs58 from 'bs58';

const DEFAULT_BASE_URL = 'https://sigilprotocol.xyz';
const baseUrl = String(process.env.SMOKE_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, '');
const domain = baseUrl;
const sessionId = `smoke_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
const walletSecretRaw = process.env.SMOKE_WALLET_SECRET || '';

if (!walletSecretRaw.trim()) {
  console.error('SMOKE_WALLET_SECRET is required (base58 secret or JSON array secret key bytes).');
  process.exit(1);
}

function parseSecretKey(raw) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) throw new Error('Empty secret key');
  if (trimmed.startsWith('[')) {
    return Uint8Array.from(JSON.parse(trimmed));
  }
  if (/^\d+(,\d+)+$/.test(trimmed)) {
    return Uint8Array.from(trimmed.split(',').map((value) => Number(value.trim())));
  }
  return Uint8Array.from(bs58.decode(trimmed));
}

function signMessageBase58(message, secretKey) {
  const bytes = new TextEncoder().encode(message);
  const sig = nacl.sign.detached(bytes, secretKey);
  return bs58.encode(Buffer.from(sig));
}

async function fetchJson(path, init = {}) {
  const resp = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      origin: baseUrl,
      'content-type': 'application/json',
      ...(init.headers || {}),
    },
  });
  const raw = await resp.text();
  let json = {};
  try {
    json = raw ? JSON.parse(raw) : {};
  } catch {
    json = { raw };
  }
  return { ok: resp.ok, status: resp.status, json, raw };
}

async function postJson(path, body) {
  return fetchJson(path, {
    method: 'POST',
    body: JSON.stringify(body || {}),
  });
}

async function sendPreparedTransaction(connection, transactionBase64, signer) {
  const txBytes = Buffer.from(transactionBase64, 'base64');
  const tx = Transaction.from(txBytes);
  tx.partialSign(signer);
  const sig = await connection.sendRawTransaction(tx.serialize(), { preflightCommitment: 'confirmed' });
  await connection.confirmTransaction(sig, 'confirmed');
  return sig;
}

async function challengeAndSign({ walletPublicKey, walletSecretKey, scope, action, payload }) {
  const challengeResp = await postJson('/api/auth/action-challenge', {
    publicKey: walletPublicKey,
    scope,
    action,
    payload,
    sessionId,
    domain,
  });
  if (!challengeResp.ok) {
    throw new Error(`challenge failed (${challengeResp.status}): ${challengeResp.raw}`);
  }
  const challenge = challengeResp.json?.challenge;
  if (!challenge?.nonce || !challenge?.message) {
    throw new Error('challenge response missing nonce/message');
  }
  const signature = signMessageBase58(challenge.message, walletSecretKey);
  return { nonce: challenge.nonce, signature };
}

async function registerAndVerifyAgent() {
  const agentKeypair = nacl.sign.keyPair();
  const agentPublicKey = bs58.encode(Buffer.from(agentKeypair.publicKey));
  const displayName = `mainnet-smoke-${Date.now().toString(36)}`;

  const registerResp = await postJson('/api/register', {
    publicKey: agentPublicKey,
    displayName,
  });
  if (!registerResp.ok) {
    throw new Error(`register failed (${registerResp.status}): ${registerResp.raw}`);
  }

  const challenge = registerResp.json?.challenge;
  if (!challenge?.nonce || !challenge?.message) {
    throw new Error('register response missing challenge');
  }

  const verifyResp = await postJson('/api/verify', {
    publicKey: agentPublicKey,
    nonce: challenge.nonce,
    signature: signMessageBase58(challenge.message, agentKeypair.secretKey),
  });
  if (!verifyResp.ok) {
    throw new Error(`verify failed (${verifyResp.status}): ${verifyResp.raw}`);
  }

  return {
    agentPublicKey,
    displayName,
  };
}

async function main() {
  const walletSecret = parseSecretKey(walletSecretRaw);
  const walletKeypair = Keypair.fromSecretKey(walletSecret);
  const walletPublicKey = walletKeypair.publicKey.toBase58();

  const configResp = await fetchJson('/api/config', { method: 'GET', headers: { origin: baseUrl } });
  if (!configResp.ok) {
    throw new Error(`/api/config failed (${configResp.status}): ${configResp.raw}`);
  }

  const rpcEndpoint = configResp.json?.addresses?.rpcEndpoint;
  const stakingMint = configResp.json?.staking?.mintAddress;
  const stakingTokenProgramId = configResp.json?.staking?.tokenProgramId;
  const onChainStaking = Boolean(configResp.json?.staking?.onChain);
  const minStake = Number(configResp.json?.staking?.minStake || 0);
  const connection = new Connection(rpcEndpoint, 'confirmed');

  const agent = await registerAndVerifyAgent();
  const summary = {
    baseUrl,
    walletPublicKey,
    agentPublicKey: agent.agentPublicKey,
    network: configResp.json?.network,
    staking: {
      onChain: onChainStaking,
      minStake,
      attempted: false,
      ok: false,
      skipped: false,
      reason: null,
      txSignature: null,
    },
    passport: {
      attempted: false,
      ok: false,
      mintAddress: null,
      txSignature: null,
      alreadyExists: false,
      reason: null,
    },
  };

  const solBalanceLamports = await connection.getBalance(walletKeypair.publicKey, 'confirmed');
  const solBalance = solBalanceLamports / 1_000_000_000;
  summary.walletSol = solBalance;

  if (!rpcEndpoint) throw new Error('rpcEndpoint missing from /api/config');

  // Passport flow.
  summary.passport.attempted = true;
  try {
    const issueAuth = await challengeAndSign({
      walletPublicKey,
      walletSecretKey: walletSecret,
      scope: 'passport',
      action: 'issue',
      payload: {
        agentPublicKey: agent.agentPublicKey,
        ownerPublicKey: walletPublicKey,
      },
    });

    const prepareResp = await postJson(`/api/passport/${encodeURIComponent(agent.agentPublicKey)}/mint-prepare`, {
      ownerPublicKey: walletPublicKey,
      signature: issueAuth.signature,
      nonce: issueAuth.nonce,
      sessionId,
      domain,
    });
    if (!prepareResp.ok) {
      throw new Error(`mint-prepare failed (${prepareResp.status}): ${prepareResp.raw}`);
    }

    const prepared = prepareResp.json;
    summary.passport.mintAddress = prepared.mintAddress || null;
    summary.passport.alreadyExists = Boolean(prepared.alreadyExists);

    let txSignature = null;
    if (!prepared.alreadyExists) {
      txSignature = await sendPreparedTransaction(connection, prepared.transactionBase64, walletKeypair);
    }

    const finalizeAuth = await challengeAndSign({
      walletPublicKey,
      walletSecretKey: walletSecret,
      scope: 'passport',
      action: 'finalize',
      payload: {
        agentPublicKey: agent.agentPublicKey,
        ownerPublicKey: walletPublicKey,
        mintAddress: prepared.mintAddress,
        txSignature,
      },
    });

    const finalizeResp = await postJson(`/api/passport/${encodeURIComponent(agent.agentPublicKey)}/mint-finalize`, {
      ownerPublicKey: walletPublicKey,
      mintAddress: prepared.mintAddress,
      txSignature,
      signature: finalizeAuth.signature,
      nonce: finalizeAuth.nonce,
      sessionId,
      domain,
    });
    if (!finalizeResp.ok) {
      throw new Error(`mint-finalize failed (${finalizeResp.status}): ${finalizeResp.raw}`);
    }

    summary.passport.ok = true;
    summary.passport.txSignature = txSignature;
  } catch (err) {
    summary.passport.reason = err.message;
  }

  // Staking flow.
  summary.staking.attempted = true;
  if (!onChainStaking) {
    summary.staking.skipped = true;
    summary.staking.reason = 'On-chain staking disabled on target API';
  } else if (!stakingMint || !stakingTokenProgramId || !Number.isFinite(minStake) || minStake <= 0) {
    summary.staking.skipped = true;
    summary.staking.reason = 'Staking config incomplete on target API';
  } else {
    try {
      const mintPk = new PublicKey(stakingMint);
      const tokenProgramPk = new PublicKey(stakingTokenProgramId);
      const ownerPk = walletKeypair.publicKey;
      const ownerAta = getAssociatedTokenAddressSync(mintPk, ownerPk, false, tokenProgramPk);
      const tokenAccounts = await connection.getParsedTokenAccountsByOwner(ownerPk, { mint: mintPk }, 'confirmed');
      const tokenBalance = tokenAccounts.value.reduce((sum, row) => (
        sum + Number(row.account?.data?.parsed?.info?.tokenAmount?.uiAmount || 0)
      ), 0);

      summary.staking.tokenBalance = tokenBalance;
      summary.staking.tokenAccount = ownerAta.toBase58();
      if (tokenBalance < minStake) {
        summary.staking.skipped = true;
        summary.staking.reason = `Wallet token balance ${tokenBalance} < min stake ${minStake}`;
      } else {
        const amount = minStake;
        const stakeAuth = await challengeAndSign({
          walletPublicKey,
          walletSecretKey: walletSecret,
          scope: 'staking',
          action: 'stake',
          payload: {
            stakerPublicKey: walletPublicKey,
            agentPublicKey: agent.agentPublicKey,
            amount,
          },
        });

        const prepareResp = await postJson('/api/staking/stake-prepare', {
          stakerPublicKey: walletPublicKey,
          agentPublicKey: agent.agentPublicKey,
          amount,
          signature: stakeAuth.signature,
          nonce: stakeAuth.nonce,
          sessionId,
          domain,
        });
        if (!prepareResp.ok) {
          throw new Error(`stake-prepare failed (${prepareResp.status}): ${prepareResp.raw}`);
        }

        const txSignature = await sendPreparedTransaction(connection, prepareResp.json.transactionBase64, walletKeypair);

        const finalizeAuth = await challengeAndSign({
          walletPublicKey,
          walletSecretKey: walletSecret,
          scope: 'staking',
          action: 'stake',
          payload: {
            stakerPublicKey: walletPublicKey,
            agentPublicKey: agent.agentPublicKey,
            amount,
            txSignature,
          },
        });

        const finalizeResp = await postJson('/api/staking/stake-finalize', {
          stakerPublicKey: walletPublicKey,
          agentPublicKey: agent.agentPublicKey,
          amount,
          txSignature,
          signature: finalizeAuth.signature,
          nonce: finalizeAuth.nonce,
          sessionId,
          domain,
        });
        if (!finalizeResp.ok) {
          throw new Error(`stake-finalize failed (${finalizeResp.status}): ${finalizeResp.raw}`);
        }

        summary.staking.ok = true;
        summary.staking.txSignature = txSignature;
      }
    } catch (err) {
      summary.staking.reason = err.message;
    }
  }

  console.log(JSON.stringify(summary, null, 2));

  const hardFailure = !summary.passport.ok || (!summary.staking.ok && !summary.staking.skipped);
  if (hardFailure) process.exit(1);
}

main().catch((err) => {
  console.error(`Fatal error: ${err.message}`);
  process.exit(1);
});
