import { isAbsolute, join } from 'node:path';
import type { KitHostScanInput, KitHostSetup, RuntimesHarnessKit } from '@ferretry/plugin-runtimes/contract';

async function scanHost(input: KitHostScanInput): Promise<KitHostSetup> {
  const named = input.configuredHome?.trim() ?? '';
  const configured = named !== '' && isAbsolute(named) ? named : undefined;
  const home = configured ?? join(input.userHome, '.claude');
  const [instructions, settings, mcp, skills] = await Promise.all([
    input.read(home, join(home, 'CLAUDE.md')),
    input.read(home, join(home, 'settings.json')),
    configured === undefined ? input.readUserMcp() : input.read(home, join(home, '.claude.json')),
    input.skills(home, join(home, 'skills')),
  ]);
  const login = await input.login();
  const projectInstructions = await input.projectInstructions(mcp);
  return {
    login,
    instructions,
    settings,
    mcp,
    projectInstructions,
    skills: skills.found,
    problems: [
      ...(named !== '' && configured === undefined
        ? [`CLAUDE_CONFIG_DIR is the relative path "${named}", so ${home} was read instead.`]
        : []),
      ...skills.problems,
    ],
  };
}

/** Claude's own host setup paths; all reads still pass through Runtimes' guarded host operations. */
export const claudeImportKit: RuntimesHarnessKit = { scanHost };
