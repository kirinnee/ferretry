import type { RuntimesHarnessKit } from '@ferretry/plugin-runtimes/contract';

/**
 * Codex's plain words: the command that starts it, the variable that points it at its home, and the skill folders it keeps for
 * itself (its first start writes its bundled skills into `.system`, which a skills component may not use). Runtimes reads them; it
 * spells none of them for Codex. Codex gives no fast-mode rule: whether a model has fast mode is the live account's to say.
 */
export const codexWordsKit: RuntimesHarnessKit = {
  command: 'codex',
  install: { npm: '@openai/codex', cask: 'codex', nixpkgs: 'codex', label: 'Codex' },
  homeEnv: 'CODEX_HOME',
  keepsSharedState: true,
  ownedSkillEntries: ['.system'],
};
