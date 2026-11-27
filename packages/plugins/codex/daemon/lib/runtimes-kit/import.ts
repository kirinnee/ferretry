import { isAbsolute, join } from 'node:path';
import type { KitHostScanInput, KitHostSetup, RuntimesHarnessKit } from '@ferretry/plugin-runtimes/contract';

async function scanHost(input: KitHostScanInput): Promise<KitHostSetup> {
  const named = input.configuredHome?.trim() ?? '';
  if (named !== '' && !isAbsolute(named)) {
    // A relative CODEX_HOME would be read against a directory the daemon cannot know, so nothing is read.
    const reason = 'CODEX_HOME is set to a relative path, so your Codex setup could not be found';
    const source = input.configuredHome ?? '';
    return {
      login: { state: 'not-shareable', reason },
      instructions: { kind: 'unreadable', source, reason },
      settings: { kind: 'unreadable', source, reason },
      hooks: { kind: 'absent', source },
      skills: [],
      problems: [],
    };
  }
  const home = named === '' ? join(input.userHome, '.codex') : join(named);
  const [instructions, settings, hooks, skills] = await Promise.all([
    input.read(home, join(home, 'AGENTS.md')),
    input.read(home, join(home, 'config.toml')),
    input.read(home, join(home, 'hooks.json')),
    input.skills(home, join(home, 'skills')),
  ]);
  const login = await input.login();
  return { login, instructions, settings, hooks, skills: skills.found, problems: skills.problems };
}

/** Codex's host scan; host reads and secret handling remain guarded by Runtimes. Harvest and login notes follow in PR 11b. */
export const codexImportKit: RuntimesHarnessKit = { scanHost };
