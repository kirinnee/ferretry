/**
 * Every v5 config file or folder the converter writes, each with the id of the plugin that declares it (`data.config`
 * of its manifest). This is the ONE map from a written path to its owner: the accepted record names that plugin,
 * because the kernel reads a record only for the plugin it names. A test checks each entry against the manifests.
 */
import { ArchiveConfigFile, LimitsConfigFile } from '@ferretry/core-ferrets/contract';
import { AsksConfigFile } from '@ferretry/core-asks/contract';
import { GateConfigFile } from '@ferretry/core-gate/contract';
import { VaultConfigFile } from '@ferretry/core-vault/contract';
import { AccountsConfigSchema } from '@ferretry/plugin-accounts/contract';
import { AGENDA_CONFIG } from '@ferretry/plugin-agenda/contract';
import { BrowsersConfigSchema } from '@ferretry/plugin-browsers/contract';
import { CatalogsConfigFile } from '@ferretry/plugin-catalogs/contract';
import { CLAUDE_CODE_CONFIG, CLAUDE_CODE_SETTINGS } from '@ferretry/plugin-claude-code/contract';
import { CODEX_CONFIG, CODEX_SETTINGS } from '@ferretry/plugin-codex/contract';
import { ConnectionsConfigSchema } from '@ferretry/plugin-connections/contract';
import { CONVERSATION_CONFIG } from '@ferretry/plugin-conversation/contract';
import { LESSONS_CONFIG } from '@ferretry/plugin-lessons/contract';
import { ENDPOINTS_CONFIG, LOGINS_CONFIG, MODELS_CONFIG } from '@ferretry/plugin-logins/contract';
import { MCP_CONFIG } from '@ferretry/plugin-mcp/contract';
import { PACKS_CONFIG } from '@ferretry/plugin-packs/contract';
import { MODEL_SET_ITEMS, PROFILE_ITEMS, RUNTIME_ITEMS, RUNTIMES_CONFIG } from '@ferretry/plugin-runtimes/contract';
import { SKILLS_CONFIG } from '@ferretry/plugin-skills/contract';
import { TerminalsConfigSchema } from '@ferretry/plugin-terminals/contract';
import { USAGE_CONFIG } from '@ferretry/plugin-usage/contract';
import { WardenFileSchema } from '@ferretry/plugin-warden/contract';
import { join } from 'node:path';
import { configPath, type V5ConfigDef, type V5ConfigTarget } from './write.ts';

const owned = (plugin: string, def: unknown): V5ConfigTarget => ({ ...(def as V5ConfigDef), plugin });

/** Declared in a plugin MANIFEST (not its contract): restated with the file name and the contract's schema. */
const file = (plugin: string, name: string, schema: V5ConfigDef['schema']): V5ConfigTarget => ({
  shape: 'file',
  file: name,
  schema,
  plugin,
});

export const CONFIG_TARGETS = {
  ARCHIVE: owned('ferrets', ArchiveConfigFile),
  LIMITS: owned('ferrets', LimitsConfigFile),
  ASKS: owned('asks', AsksConfigFile),
  GATE: owned('gate', GateConfigFile),
  VAULT: owned('vault', VaultConfigFile),
  ACCOUNTS: file('accounts', 'accounts.yaml', AccountsConfigSchema),
  AGENDA: owned('agenda', AGENDA_CONFIG),
  BROWSERS: file('browsers', 'browsers.yaml', BrowsersConfigSchema),
  CATALOGS: owned('catalogs', CatalogsConfigFile),
  CLAUDE_CODE: owned('claude-code', CLAUDE_CODE_CONFIG),
  CLAUDE_CODE_SETTINGS: owned('claude-code', CLAUDE_CODE_SETTINGS),
  CODEX: owned('codex', CODEX_CONFIG),
  CODEX_SETTINGS: owned('codex', CODEX_SETTINGS),
  CONNECTIONS: file('connections', 'connections.yaml', ConnectionsConfigSchema),
  CONVERSATION: owned('conversation', CONVERSATION_CONFIG),
  LESSONS: owned('lessons', LESSONS_CONFIG),
  LOGINS: owned('logins', LOGINS_CONFIG),
  ENDPOINTS: owned('logins', ENDPOINTS_CONFIG),
  MODELS: owned('logins', MODELS_CONFIG),
  MCP: owned('mcp', MCP_CONFIG),
  PACKS: owned('packs', PACKS_CONFIG),
  RUNTIMES: owned('runtimes', RUNTIMES_CONFIG),
  RUNTIME_ITEMS: owned('runtimes', RUNTIME_ITEMS),
  PROFILE_ITEMS: owned('runtimes', PROFILE_ITEMS),
  MODEL_SET_ITEMS: owned('runtimes', MODEL_SET_ITEMS),
  SKILLS: owned('skills', SKILLS_CONFIG),
  TERMINALS: file('terminals', 'terminals.yaml', TerminalsConfigSchema),
  USAGE: owned('usage', USAGE_CONFIG),
  WARDEN: file('warden', 'warden.yaml', WardenFileSchema),
} as const satisfies Record<string, V5ConfigTarget>;

/** The plugin that owns a `config/…` path, or `undefined` when no target owns it. Built from the targets above. */
export function configOwner(path: string): string | undefined {
  for (const target of Object.values(CONFIG_TARGETS)) {
    if (target.shape === 'file') {
      if (configPath(target) === path) return target.plugin;
      continue;
    }
    const prefix = `${join('config', target.collection)}/`;
    if (!path.startsWith(prefix) || !path.endsWith('.yaml')) continue;
    const name = path.slice(prefix.length, -'.yaml'.length);
    if (!name.includes('/') && target.name.test(name)) return target.plugin;
  }
  return undefined;
}
