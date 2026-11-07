/** `words` (§7.9, §1.2): a word is owned twice, by two manifests or twice in one. Case-insensitive. */
import { type Check, type Finding, runMain } from '../gen/lib/check.ts';

export const check: Check = {
  name: 'words',
  summary: 'every word has one owner',
  async run(ctx) {
    const owners = new Map<string, string[]>();
    for (const subsystem of (await ctx.model()).loaded)
      for (const word of subsystem.manifest.words ?? []) {
        const key = word.word.trim().toLowerCase();
        owners.set(key, [...(owners.get(key) ?? []), subsystem.id]);
      }
    const findings: Finding[] = [];
    for (const [word, ids] of owners)
      if (ids.length > 1) findings.push({ check: 'words', where: ids.join(', '), message: `"${word}" is owned ${ids.length} times` });
    return findings;
  },
};

if (import.meta.main) await runMain(check, process.argv.slice(2));
