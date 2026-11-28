import type { RuntimesHarnessKit } from '@ferretry/plugin-runtimes/contract';

/**
 * Codex's plain words: the command that starts it, the variable that points it at its home, the skill folders it keeps for
 * itself (its first start writes its bundled skills into `.system`, which a skills component may not use), the model catalog its
 * sign-in reads and where its hooks land. Runtimes reads them; it spells none of them for Codex.
 * Codex gives no fast-mode rule: whether a model has fast mode is the live account's to say. It gives no comfort settings: every
 * setting worth changing is already its default (`shell_environment_policy.inherit` is `all`, and its default excludes of KEY,
 * SECRET and TOKEN variables must stay), so adding one would only hide that.
 */
export const codexWordsKit: RuntimesHarnessKit = {
  command: 'codex',
  settingsFile: { format: 'toml', file: 'config.toml', directory: '.codex' },
  install: { npm: '@openai/codex', cask: 'codex', nixpkgs: 'codex', label: 'Codex' },
  homeEnv: 'CODEX_HOME',
  keepsSharedState: true,
  ownedSkillEntries: ['.system'],
  signInCatalog: 'openai',
  assets: [
    { field: 'hooks', dest: 'hooks.json', materialization: 'link' },
    { field: 'hooksDir', dest: 'hooks', materialization: 'link' },
  ],
};
