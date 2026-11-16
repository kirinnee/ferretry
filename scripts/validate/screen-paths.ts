/**
 * `screen-paths` (§5.2): a screen path with a leading `/` is daemon-less (the router serves it from the root, with no
 * paired daemon), and everything else is per daemon (`/d/<daemon>/<path>`). A screen that belongs to a daemon and
 * says `/board` would be reachable only with no daemon to read from, so an absolute path is refused unless the
 * screen says `daemonless: true` on purpose.
 */
import { type Check, type Finding, runMain } from '../gen/lib/check.ts';

export function screenPathFindings(
  where: string,
  screens: readonly { readonly id: string; readonly path: string; readonly daemonless?: true }[],
): Finding[] {
  const findings: Finding[] = [];
  for (const screen of screens) {
    const absolute = screen.path.startsWith('/');
    if (absolute && screen.daemonless !== true)
      findings.push({
        check: 'screen-paths',
        where,
        message: `screen "${screen.id}" has the absolute path "${screen.path}", which is daemon-less; drop the leading "/" to make it per daemon, or declare \`daemonless: true\` if it is meant to belong to no daemon`,
      });
    if (!absolute && screen.daemonless === true)
      findings.push({
        check: 'screen-paths',
        where,
        message: `screen "${screen.id}" says \`daemonless: true\` but its path "${screen.path}" is relative (per daemon); make the path absolute or drop the marker`,
      });
  }
  return findings;
}

export const check: Check = {
  name: 'screen-paths',
  summary: 'a screen path is per daemon unless it is absolute and declared daemonless',
  async run(ctx) {
    const findings: Finding[] = [];
    for (const subsystem of (await ctx.model()).loaded) {
      if (ctx.packageId !== undefined && subsystem.id !== ctx.packageId) continue;
      findings.push(...screenPathFindings(subsystem.id, subsystem.manifest.ui?.screens ?? []));
    }
    return findings;
  },
};

if (import.meta.main) await runMain(check, process.argv.slice(2));
