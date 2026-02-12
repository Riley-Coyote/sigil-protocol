#!/usr/bin/env node
import { Connection, PublicKey } from '@solana/web3.js';

const DEFAULT_BASE_URL = 'http://localhost:3141';

function parseArgs(argv) {
  const args = {
    baseUrl: DEFAULT_BASE_URL,
    expectProductionReady: false,
    requireOnChainStaking: true,
    requireStakingProgramId: false,
    requirePassportCollection: false,
    requireReadinessRoute: true,
  };

  for (const token of argv) {
    if (token.startsWith('--base-url=')) {
      args.baseUrl = token.split('=').slice(1).join('=').trim() || DEFAULT_BASE_URL;
      continue;
    }
    if (token === '--expect-production-ready') {
      args.expectProductionReady = true;
      continue;
    }
    if (token === '--allow-readiness-404') {
      args.requireReadinessRoute = false;
      continue;
    }
    if (token === '--allow-offchain-staking') {
      args.requireOnChainStaking = false;
      continue;
    }
    if (token === '--require-staking-program-id') {
      args.requireStakingProgramId = true;
      continue;
    }
    if (token === '--require-passport-collection') {
      args.requirePassportCollection = true;
      continue;
    }
    if (token === '--allow-missing-passport-collection') {
      args.requirePassportCollection = false;
      continue;
    }
    if (token === '--help' || token === '-h') {
      printHelp();
      process.exit(0);
    }
  }

  args.baseUrl = args.baseUrl.replace(/\/$/, '');
  return args;
}

function printHelp() {
  console.log(`SIGIL production verification\n\nUsage:\n  node scripts/verify-production.mjs [options]\n\nOptions:\n  --base-url=<url>                       API/site base URL (default: ${DEFAULT_BASE_URL})\n  --expect-production-ready              Fail if API does not report productionReady=true\n  --allow-readiness-404                  Allow older deployments without /api/readiness\n  --allow-offchain-staking               Do not require staking.onChain=true\n  --require-staking-program-id           Require addresses.stakingProgramId to be set\n  --require-passport-collection          Require passport.collectionAddress to be set\n  --allow-missing-passport-collection    Legacy alias to disable collection requirement\n  -h, --help                             Show this help\n`);
}

async function fetchJson(baseUrl, path) {
  const url = `${baseUrl}${path}`;
  const res = await fetch(url, {
    headers: { origin: baseUrl },
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { url, ok: res.ok, status: res.status, json, raw: text };
}

function safePublicKey(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    return new PublicKey(value.trim());
  } catch {
    return null;
  }
}

function summarizeCheck(pass, label, detail = null, optional = false) {
  const icon = pass ? 'PASS' : (optional ? 'WARN' : 'FAIL');
  console.log(`[${icon}] ${label}${detail ? ` — ${detail}` : ''}`);
}

async function verifyChain(config, issues) {
  const rpc = config?.addresses?.rpcEndpoint;
  const mintAddress = config?.staking?.mintAddress || config?.addresses?.sigilMint;
  const tokenProgramId = config?.staking?.tokenProgramId;
  const vaultOwnerPublicKey = config?.staking?.vaultOwnerPublicKey;

  if (!rpc || !mintAddress || !tokenProgramId) {
    issues.push('Missing rpcEndpoint/mintAddress/tokenProgramId for on-chain verification');
    return;
  }

  const mintPk = safePublicKey(mintAddress);
  const programPk = safePublicKey(tokenProgramId);
  const vaultPk = safePublicKey(vaultOwnerPublicKey);

  if (!mintPk) issues.push('staking mint address is not a valid public key');
  if (!programPk) issues.push('staking token program id is not a valid public key');
  if (!vaultPk) issues.push('staking vault owner public key is not a valid public key');
  if (!mintPk || !programPk) return;

  const connection = new Connection(rpc, 'confirmed');
  const mintInfo = await connection.getAccountInfo(mintPk, 'confirmed');
  if (!mintInfo) {
    issues.push('Configured staking mint account not found on-chain');
    return;
  }

  if (!mintInfo.owner.equals(programPk)) {
    issues.push('Configured staking mint owner does not match staking token program');
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const issues = [];
  const warnings = [];
  const advisories = [];

  console.log(`SIGIL verification target: ${args.baseUrl}`);

  const [health, config, stats, wellKnown] = await Promise.all([
    fetchJson(args.baseUrl, '/api/health'),
    fetchJson(args.baseUrl, '/api/config'),
    fetchJson(args.baseUrl, '/api/stats'),
    fetchJson(args.baseUrl, '/.well-known/sigil.json'),
  ]);

  if (!health.ok) {
    issues.push(`/api/health failed (${health.status})`);
  }
  if (!config.ok) {
    issues.push(`/api/config failed (${config.status})`);
  }
  if (!stats.ok) {
    issues.push(`/api/stats failed (${stats.status})`);
  }
  if (!wellKnown.ok) {
    issues.push(`/.well-known/sigil.json failed (${wellKnown.status})`);
  }

  const readiness = await fetchJson(args.baseUrl, '/api/readiness');
  const readinessPayload = readiness.ok
    ? readiness.json
    : (config.json?.readiness ? {
      productionReady: config.json.readiness.productionReady,
      checks: config.json.readiness.checks,
      blocking: config.json.readiness.blocking,
    } : null);

  if (!readiness.ok && args.requireReadinessRoute) {
    issues.push(`/api/readiness failed (${readiness.status})`);
  } else if (!readiness.ok) {
    warnings.push(`/api/readiness unavailable (${readiness.status}), using /api/config readiness fallback`);
  }

  const protocolVersion = health.json?.version || config.json?.protocolVersion || 'unknown';
  const network = health.json?.network || config.json?.network || 'unknown';
  console.log(`Version: ${protocolVersion} | Network: ${network}`);

  const onChain = Boolean(config.json?.staking?.onChain);
  const stakingMint = config.json?.staking?.mintAddress || null;
  const stakingProgramId = config.json?.addresses?.stakingProgramId || null;
  const passportCollection = config.json?.passport?.collectionAddress || config.json?.addresses?.passportCollection || null;
  const legacyIssueEnabled = Boolean(config.json?.passport?.legacyIssueEnabled);

  summarizeCheck(Boolean(health.ok), 'Health endpoint reachable');
  summarizeCheck(Boolean(config.ok), 'Config endpoint reachable');
  summarizeCheck(Boolean(stats.ok), 'Stats endpoint reachable');
  summarizeCheck(Boolean(wellKnown.ok), 'Well-known discovery endpoint reachable');
  const onChainIsOptional = !args.requireOnChainStaking;
  summarizeCheck(Boolean(onChain), 'On-chain staking mode enabled', null, onChainIsOptional);

  const requireStakingConfig = args.requireOnChainStaking || onChain;
  const stakingConfigOptional = !requireStakingConfig;
  summarizeCheck(Boolean(stakingMint), 'SIGIL staking mint configured', stakingMint || 'unset', stakingConfigOptional);
  const requireStakingProgramId = requireStakingConfig && args.requireStakingProgramId;
  summarizeCheck(Boolean(stakingProgramId), 'Staking program id configured', stakingProgramId || 'unset', !requireStakingProgramId);

  summarizeCheck(Boolean(passportCollection), 'Passport collection configured', passportCollection || 'unset', !args.requirePassportCollection);
  summarizeCheck(!legacyIssueEnabled, 'Legacy passport issuance disabled');

  if (args.requireOnChainStaking && !onChain) {
    issues.push('staking.onChain is false');
  } else if (!onChain) {
    advisories.push('staking.onChain is false');
  }
  if (requireStakingConfig && !stakingMint) {
    issues.push('staking mint is not configured');
  } else if (!stakingMint) {
    advisories.push('staking mint is not configured');
  }
  if (requireStakingProgramId && !stakingProgramId) {
    issues.push('staking program id is not configured');
  } else if (!stakingProgramId) {
    advisories.push('staking program id is not configured');
  }
  if (args.requirePassportCollection && !passportCollection) {
    issues.push('passport collection is not configured');
  } else if (!passportCollection) {
    advisories.push('passport collection is not configured');
  }
  if (legacyIssueEnabled) {
    issues.push('legacy passport issuance is enabled');
  }

  if (readinessPayload?.blocking?.length) {
    for (const check of readinessPayload.blocking) {
      const detail = `readiness blocking: ${check.key}${check.detail ? ` (${check.detail})` : ''}`;
      if (args.expectProductionReady) {
        issues.push(detail);
      } else {
        warnings.push(detail);
      }
    }
  }
  if (args.expectProductionReady && readinessPayload && !readinessPayload.productionReady) {
    issues.push('readiness reports productionReady=false');
  }

  if (stats.ok) {
    const minted = Number(stats.json?.totalPassports || 0);
    const legacy = Number(stats.json?.totalLegacyPassports || 0);
    console.log(`Passports: minted=${minted}, legacy_simulated=${legacy}`);
    if (minted <= 0) {
      warnings.push('No real on-chain passports have been minted yet');
    }
  }

  if (config.ok && onChain) {
    try {
      await verifyChain(config.json, issues);
      summarizeCheck(true, 'On-chain mint configuration check executed');
    } catch (err) {
      issues.push(`On-chain check failed: ${err.message}`);
    }
  }

  const agentsResp = await fetchJson(args.baseUrl, '/api/agents?limit=1');
  if (agentsResp.ok && Array.isArray(agentsResp.json?.agents) && agentsResp.json.agents[0]?.publicKey) {
    const publicKey = agentsResp.json.agents[0].publicKey;
    const verifyResp = await fetchJson(
      args.baseUrl,
      `/api/verification/agent/${encodeURIComponent(publicKey)}?requirePassport=0`,
    );
    if (!verifyResp.ok) {
      issues.push(`verification API failed for sample agent (${verifyResp.status})`);
    } else {
      summarizeCheck(Boolean(verifyResp.json?.attestation), 'Verification API responds for sample agent');
    }
  } else {
    warnings.push('Could not fetch a sample verified agent for verification endpoint smoke test');
  }

  if (warnings.length) {
    console.log('\nWarnings:');
    for (const warning of warnings) {
      console.log(`- ${warning}`);
    }
  }

  if (issues.length) {
    console.log('\nBlocking issues:');
    for (const issue of issues) {
      console.log(`- ${issue}`);
    }
    process.exitCode = 1;
    return;
  }

  if (advisories.length) {
    console.log('\nAdvisories (non-blocking for this run profile):');
    for (const advisory of advisories) {
      console.log(`- ${advisory}`);
    }
    console.log('\nVerification passed with advisories.');
    return;
  }

  console.log('\nAll production checks passed.');
}

main().catch((err) => {
  console.error(`Fatal error: ${err.message}`);
  process.exit(1);
});
