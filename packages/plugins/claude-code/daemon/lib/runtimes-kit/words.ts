import type { RuntimesHarnessKit } from '@ferretry/plugin-runtimes/contract';
import { claudeFastSupport } from '../harness/fast-mode.ts';

/**
 * Claude's plain words: the command that starts it, the variable that points it at its home, the skill folders it keeps for itself
 * (none), its fast-mode rule, the model catalog its sign-in reads, the settings its built-in profile holds and where its own `.mcp.json` lands. Runtimes reads them; it spells none of them for Claude.
 */
export const claudeWordsKit: RuntimesHarnessKit = {
  command: 'claude',
  settingsFile: { format: 'json', file: 'settings.json', directory: '.claude' },
  install: { npm: '@anthropic-ai/claude-code', cask: 'claude-code', nixpkgs: 'claude-code', label: 'Claude Code' },
  homeEnv: 'CLAUDE_CONFIG_DIR',
  hostOrganization: true,
  ownedSkillEntries: [],
  fastSupport: claudeFastSupport,
  signInCatalog: 'anthropic',
  /**
   * NONE is a permission: they keep a long unattended run from being cut short (history kept long enough to resume, long shell and
   * MCP waits), and go in the launch environment.
   */
  comfortSettings: {
    harness: 'claude',
    document: { cleanupPeriodDays: 90 },
    env: { BASH_DEFAULT_TIMEOUT_MS: '600000', MCP_TIMEOUT: '60000' },
  },
  assets: [{ field: 'mcp', dest: '.mcp.json', materialization: 'link' }],
};
