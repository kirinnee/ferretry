import type { RuntimesHarnessKit } from '@ferretry/plugin-runtimes/contract';
import { claudeFastSupport } from '../harness/fast-mode.ts';

/**
 * Claude's plain words: the command that starts it, the variable that points it at its home, the skill folders it keeps for itself
 * (none), and its fast-mode rule. Runtimes reads them; it spells none of them for Claude.
 */
export const claudeWordsKit: RuntimesHarnessKit = {
  command: 'claude',
  homeEnv: 'CLAUDE_CONFIG_DIR',
  hostOrganization: true,
  ownedSkillEntries: [],
  fastSupport: claudeFastSupport,
};
