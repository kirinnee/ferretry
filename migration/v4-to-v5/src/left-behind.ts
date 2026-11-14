/**
 * What the owner chose NOT to carry over (ruling !A516, "Leave them"). One list, one file: `migrate.sh` prints the
 * same `left-behind.txt` before the owner confirms, and the converter prints and writes it in its report. Both read
 * the file, so the two cannot drift. Nothing here changes what the converter carries; it only says, plainly, what stays
 * in the v4 home.
 */
import text from '../left-behind.txt' with { type: 'text' };

export const LEFT_BEHIND: readonly string[] = text
  .split('\n')
  .map(line => line.trim())
  .filter(line => line !== '');

/** The plain-language block: the six items, then where v4's home stays and how to look back at it. */
export function leftBehindLines(v4Home: string): readonly string[] {
  return [
    'Left behind (not carried to v5, by the owner’s choice):',
    ...LEFT_BEHIND.map(item => `  - ${item}`),
    `v4's home is kept untouched at ${v4Home}, so you can look back at any of it.`,
    `To look: open that folder, or copy it and run v4's fy against the copy (FY_HOME=<copy>). Do not start v4 on the original.`,
  ];
}
