/**
 * `private-files` (§7.7, §9.3): the fail-closed rule for a plugin's state files. A file under `state/<id>/` whose name says
 * key, secret, token, passkey, credential or oauth (case-insensitive substrings) must be declared in the manifest's
 * `privacy` — `private` (the kernel's fence pins it by identity, through every root) or `public` with a written reason —
 * and a declaration must be sound: plain relative paths, a reason that says something, never both, and every `private`
 * entry names a file or folder the plugin declares (a typo pins nothing, which is worse than no entry). The rule is the
 * kernel SDK's own (`privacyProblems`), so `definePlugin` refuses the same manifest at load; this check also reports a
 * manifest that failed to load for that reason, and re-judges every loaded one.
 */
import { type Check, type Finding, runMain } from '../gen/lib/check.ts';
import {
  covers,
  privacyProblems,
  stateFilePaths,
  UNDECLARED_FILES,
} from '../../packages/core/kernel/manifest/privacy.ts';

const NAME = 'private-files';

export const check: Check = {
  name: NAME,
  summary: 'a secret-named state file is declared private (pinned by identity) or public with a reason',
  async run(ctx) {
    const model = await ctx.model();
    const findings: Finding[] = [];
    for (const failure of model.failures)
      if (failure.includes('(privacy)'))
        findings.push({ check: NAME, where: failure.split(':')[0] ?? failure, message: failure });
    for (const { pkg, manifest } of model.loaded) {
      if (ctx.packageId !== undefined && pkg.id !== ctx.packageId) continue;
      const extra = UNDECLARED_FILES.get(manifest.id) ?? [];
      for (const message of privacyProblems(manifest, extra)) findings.push({ check: NAME, where: pkg.rel, message });
      const known = [...stateFilePaths(manifest), ...extra];
      for (const entry of manifest.privacy?.private ?? [])
        if (!known.some(path => covers(entry, path) || covers(path, entry)))
          findings.push({
            check: NAME,
            where: pkg.rel,
            message: `${manifest.id}: private entry "${entry}" names no state file the plugin declares, so it pins nothing`,
          });
    }
    return findings;
  },
};

if (import.meta.main) await runMain(check, process.argv.slice(2));
