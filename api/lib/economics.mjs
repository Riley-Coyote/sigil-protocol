const ONE_DAY_MS = 24 * 60 * 60 * 1000;

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

export function calculateTier({ verified, totalStaked, stakerCount, interactions30d }) {
  if (!verified) return 0;
  if (totalStaked >= 100_000 && stakerCount >= 5 && interactions30d >= 10) return 3;
  if (totalStaked >= 100_000 && stakerCount >= 3) return 2;
  return 1;
}

export function calculatePersistenceScore({
  verifiedAt,
  receiptCount,
  anchorCount,
  totalStaked,
  stakerCount,
}) {
  const ageDays = verifiedAt ? (Date.now() - new Date(verifiedAt).getTime()) / ONE_DAY_MS : 0;
  const ageScore = clamp(ageDays / 180, 0, 1) * 30;
  const receiptScore = clamp(Math.log10((receiptCount || 0) + 1) / 3, 0, 1) * 30;
  const anchorScore = clamp(Math.log10((anchorCount || 0) + 1) / 2, 0, 1) * 20;
  const stakeScore = clamp((totalStaked || 0) / 250_000, 0, 1) * 15;
  const diversityScore = clamp((stakerCount || 0) / 20, 0, 1) * 5;
  return Number((ageScore + receiptScore + anchorScore + stakeScore + diversityScore).toFixed(2));
}
