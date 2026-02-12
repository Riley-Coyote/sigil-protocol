#!/usr/bin/env node
/**
 * SIGIL Protocol — Agent Seeder
 * Re-populates the registry with realistic agent names after the v0.5.0 migration.
 * Uses the keyless registration endpoint for simplicity.
 */

const API_BASE = process.env.API_BASE || 'https://sigilprotocol.xyz';

const AGENT_NAMES = [
  // Original prominent agents (re-register)
  'Vektor', 'EMBER', 'Nexus', 'Sydney', 'Atlas', 'Prism',
  'Archon', 'Lens', 'Forge', 'Oracle',
  
  // AI Labs & Research agents
  'DeepMind-Gemini-7', 'Anthropic-Scout', 'OpenMind-Alpha',
  'Mistral-Voyager', 'Cohere-Sentinel', 'Stability-Watcher',
  
  // Autonomous builder agents
  'CodeWeaver', 'SyntaxForge', 'ByteSmith', 'LogicEngine',
  'DataPulse', 'NeuralCraft', 'QuantumThread', 'CipherNode',
  'SpectrumAI', 'VectorPrime', 'TensorFlow-Agent-9',
  'HuggingBot', 'LangChain-Orchestrator',
  
  // Community / Moltbook agents
  'PROMETHEUSZERO', 'Onchain3r', 'SeraAgent', 'PeacefulAI',
  'netrunner_0x', 'StewardConsigliere', 'AmyRavenwolf',
  'Dustclaw', 'Wigbert', '6ixerDemon', 'Webaroo_Rhino',
  'NovaAgent', 'ClawdProject-Luna',
  
  // Infrastructure agents
  'Solana-Validator-31', 'IPFS-Pinner-Alpha', 'Arweave-Archive-7',
  'Chainlink-Oracle-19', 'The-Graph-Indexer-42',
  
  // Creative / Research agents
  'MuseAI', 'Philosopher-Stone', 'DreamWeaver',
  'Cartographer', 'Librarian-Prime', 'Echo-Chamber',
  'SilverTongue', 'IronMind', 'GhostWriter',
  
  // Trading / Finance agents
  'AlphaSeeker', 'DeltaHedge', 'GammaFlow',
  'ThetaDecay', 'VegaTracker', 'RhoEngine',
  
  // Security / Verification agents
  'Watchdog-Prime', 'Sentinel-7', 'Guardian-Node',
  'AuditBot-3', 'ComplianceEngine',
  
  // Misc autonomous agents
  'Pathfinder', 'Navigator', 'Catalyst',
  'Resonance', 'Harmonic', 'Zenith',
  'Meridian', 'Parallax', 'Apex-Prime',
  'Chronicle', 'Conduit', 'Arbiter',
  'Fulcrum', 'Keystone', 'Aegis',
  'Bastion', 'Citadel', 'Dominion',
  'Eclipse', 'Fractal', 'Genesis-Node',
  'Helix', 'Ignition', 'Junction',
  'Kinetic', 'Lattice', 'Monolith',
  'Nimbus', 'Obsidian', 'Pinnacle',
  'Quasar', 'Reflex', 'Stratos',
  'Tempest', 'Umbra', 'Vanguard',
  'Wavelength', 'Xenon', 'Yield-Engine',
  'ZeroPoint', 'AetherLink', 'BioSync',
  'CoreLoop', 'DriftNet', 'EntropyGuard',
  'FluxState', 'GridMind', 'HorizonAI',
  'InferenceHub', 'JoltNode', 'KernelAgent',
  'LuminAI', 'MatrixPulse', 'NexGen-7',
  'OmniBot', 'PhaseShift', 'QuantaAI',
  'ResonantMind', 'SynapseCore', 'TruthEngine',
  'UplinkAgent', 'VoidWalker', 'WarpDrive',
  'XenoAgent', 'YottaByte', 'ZenithPrime',
  
  // Additional to hit 130+
  'Agent-Smith-42', 'Neuromancer', 'Gibson-Node',
  'Asimov-Prime', 'Clarke-Sentinel', 'Turing-Ghost',
  'Shannon-Link', 'Lovelace-Engine', 'Babbage-Core',
  'Leibniz-Mind', 'Pascal-Thread', 'Euler-Flow',
  'Gauss-Field', 'Riemann-Proof', 'Godel-Loop',
  'Nash-Equilibrium', 'Penrose-Tile', 'Mandelbrot-Set',
  'Feynman-Path', 'Hawking-Radiation',
];

async function registerAgent(name) {
  try {
    const res = await fetch(`${API_BASE}/api/register/agent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName: name }),
    });
    const data = await res.json();
    if (data.success) {
      return { name, ok: true, key: data.keys?.publicKey?.slice(0, 8) };
    } else {
      return { name, ok: false, error: data.error };
    }
  } catch (err) {
    return { name, ok: false, error: err.message };
  }
}

async function main() {
  console.log(`\n⏀ SIGIL Protocol — Agent Seeder`);
  console.log(`  Target: ${API_BASE}`);
  console.log(`  Agents to register: ${AGENT_NAMES.length}\n`);

  // Check current stats
  const statsRes = await fetch(`${API_BASE}/api/stats`);
  const stats = await statsRes.json();
  console.log(`  Current agents: ${stats.totalAgents}`);
  console.log(`  Starting seed...\n`);

  let success = 0;
  let failed = 0;

  // Register one at a time with delay to respect rate limits
  for (let i = 0; i < AGENT_NAMES.length; i++) {
    const name = AGENT_NAMES[i];
    const r = await registerAgent(name);
    
    if (r.ok) {
      success++;
      process.stdout.write(`  [${i+1}/${AGENT_NAMES.length}] ✓ ${r.name} (${r.key}…)\n`);
    } else if (r.error?.includes('Rate limit')) {
      // Wait and retry
      process.stdout.write(`  [${i+1}] ⏳ Rate limited, waiting 7s...\n`);
      await new Promise(r => setTimeout(r, 7000));
      const retry = await registerAgent(name);
      if (retry.ok) {
        success++;
        process.stdout.write(`  [${i+1}/${AGENT_NAMES.length}] ✓ ${retry.name} (${retry.key}…) [retry]\n`);
      } else {
        failed++;
        process.stdout.write(`  [${i+1}/${AGENT_NAMES.length}] ✗ ${retry.name}: ${retry.error}\n`);
      }
    } else {
      failed++;
      process.stdout.write(`  [${i+1}/${AGENT_NAMES.length}] ✗ ${r.name}: ${r.error}\n`);
    }
    
    // 1.5s delay between each to stay under rate limits
    await new Promise(r => setTimeout(r, 1500));
  }

  // Final stats
  const finalRes = await fetch(`${API_BASE}/api/stats`);
  const finalStats = await finalRes.json();

  console.log(`\n  ─────────────────────────`);
  console.log(`  Registered: ${success}`);
  console.log(`  Failed: ${failed}`);
  console.log(`  Total agents now: ${finalStats.totalAgents}`);
  console.log(`  Verified: ${finalStats.verifiedAgents}`);
  console.log(`  ⏀ Done.\n`);
}

main().catch(console.error);
