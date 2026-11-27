/**
 * Two styles that read alike, as the owner reported them (end-list-later: "Geist vs Minimal Swiss, Studio/Lucid/Briefing,
 * Neumorphism dark"). Neumorphism's dark partners are the other soft, shadow-led looks: Studio and Glass.
 */
export const REPORTED_PAIRS: readonly (readonly [string, string])[] = [
  ['geist', 'swiss'],
  ['studio', 'lucid'],
  ['studio', 'briefing'],
  ['lucid', 'briefing'],
  ['neumorphism', 'glass'],
  ['neumorphism', 'studio'],
];

/**
 * Over the cells of the shrunk specimen where either style draws anything, two styles' grey levels must differ by at least
 * this mean (0-255: black against white is 255). Measured on the base, the median of all 120 pairs is 16.7 and the reported
 * triad sits at 12-18; a watched pair has to be at least as far apart as the typical pair.
 */
export const LOOK_FLOOR = 15;
/** The Accessible style is flat and plain on purpose, so it need only not read as any other style: above the closest pair on the base. */
export const ACCESSIBLE_FLOOR = 10;
/** A cell counts as drawn when it is this far from the specimen's own ground (the commonest grey). */
const INK = 6;

const ground = (grid: readonly number[]): number => {
  const counts = new Map<number, number>();
  for (const level of grid) counts.set(level, (counts.get(level) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0;
};

/** How far apart two shrunk pictures are, over the cells either one draws on (0 identical). Pure, total. */
export function lookDistance(greyA: readonly number[], greyB: readonly number[]): number {
  const groundA = ground(greyA);
  const groundB = ground(greyB);
  let total = 0;
  let drawn = 0;
  for (let i = 0; i < Math.min(greyA.length, greyB.length); i += 1) {
    const x = greyA[i] ?? 0;
    const y = greyB[i] ?? 0;
    if (Math.abs(x - groundA) < INK && Math.abs(y - groundB) < INK) continue;
    drawn += 1;
    total += Math.abs(x - y);
  }
  return drawn === 0 ? 0 : total / drawn;
}
