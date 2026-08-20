export function readinessScore(
  powerReady: string,
  commsReady: string,
  siteStatus: string
): number {
  let score = 0;
  if (powerReady === "Yes") score += 40;
  if (commsReady === "Yes") score += 40;
  if (siteStatus === "Complete") score += 20;
  return score;
}
