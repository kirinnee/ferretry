/**
 * What a plugin may add to a ferret's pane environment through a `pane-env` launch part (r9 B4): plain `NAME=value`
 * pairs, judged here so a plugin that asks for the wrong one is refused BY NAME and the launch says which plugin.
 *
 * A contribution may not name a variable the launch or the login owns (`PATH`, `HOME`, the harness's home, any `FY_*`),
 * a token variable a `gh` or a `git` reads (`GH_TOKEN`, `GITHUB_TOKEN`, `GH_ENTERPRISE_TOKEN`), and may not carry a
 * `${secret…}` reference: a value is plain text, so no plugin can ask the Vault to open a secret into a pane through here.
 * The refusal text carries the plugin's id and the variable's NAME, never a value.
 */
import { err, ok, type Result } from '@ferretry/std';
import type { LaunchPart } from '../../../contract/index.ts';

const RESERVED: ReadonlySet<string> = new Set([
  'PATH',
  'HOME',
  'CLAUDE_CONFIG_DIR',
  'CODEX_HOME',
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GH_ENTERPRISE_TOKEN',
]);
const VARIABLE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u;

/** The merged pairs of every `pane-env` part, or the sentence that refuses the launch. */
export function paneEnvironment(parts: readonly LaunchPart[]): Result<Readonly<Record<string, string>>, string> {
  const merged: Record<string, string> = {};
  for (const part of parts) {
    if (part.kind !== 'pane-env') continue;
    for (const [name, value] of Object.entries(part.env)) {
      const refused =
        !VARIABLE.test(name) || RESERVED.has(name) || name.startsWith('FY_') || value.includes('${secret');
      if (refused)
        return err(
          `the ${part.plugin} plugin may not set ${VARIABLE.test(name) ? name : 'that variable'} in a ferret's environment, so the ferret was not started`,
        );
      merged[name] = value;
    }
  }
  return ok(merged);
}
