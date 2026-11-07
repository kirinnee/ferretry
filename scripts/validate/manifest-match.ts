/**
 * `manifest-match` (§7.9): a half implements something its manifest does not declare, or misses something it does.
 * A skeleton half passes only while its plugin is listed in `ports-pending.json`. Every core and plugin package
 * (all but the kernel, whose own declaration has no halves) ships a daemon, app and CLI half (spine D11).
 */
import { halfFindings } from '../gen/lib/halves.ts';
import { type Check, type Finding, runMain } from '../gen/lib/check.ts';
import { HALVES, halfPath, loadHalf } from '../gen/lib/workspace.ts';
import { readPending } from './ports-pending.ts';

export const check: Check = {
  name: 'manifest-match',
  summary: 'every half implements exactly what its manifest declares',
  async run(ctx) {
    const model = await ctx.model();
    const pending = new Set(readPending(ctx.root).pending);
    const findings: Finding[] = model.failures
      .filter(failure => failure.includes('manifest'))
      .map(message => ({ check: 'manifest-match', where: 'workspace', message }));
    for (const subsystem of model.loaded) {
      if (subsystem.id === 'kernel') continue;
      if (ctx.packageId !== undefined && subsystem.id !== ctx.packageId) continue;
      for (const half of HALVES) {
        const where = `${subsystem.pkg.rel}/${half}`;
        if (halfPath(subsystem.pkg, half) === undefined) {
          findings.push({ check: 'manifest-match', where, message: `no ./${half} export (every subsystem ships three halves)` });
          continue;
        }
        let impl;
        try {
          impl = await loadHalf(subsystem.pkg, half);
        } catch (error) {
          findings.push({ check: 'manifest-match', where, message: `failed to load: ${error instanceof Error ? error.message : String(error)}` });
          continue;
        }
        findings.push(...halfFindings(where, subsystem.manifest, half, impl, pending.has(subsystem.id)));
      }
    }
    return findings;
  },
};

if (import.meta.main) await runMain(check, process.argv.slice(2));
