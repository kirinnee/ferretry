import type { FencedPath, FerretId, RootHandle } from '@ferretry/kernel/contract';
import type { HomePlan, LaunchSpec } from '@ferretry/core-ferrets/contract';
import { materializeSkills } from '@ferretry/core-ferrets/contract';
import { seconds } from '@ferretry/std';
import { tomlDocument, tomlTables } from '../../lib/index.ts';
import { settingsDocument } from '../../lib/settings.ts';
import type { SettingsItem } from '../../../contract/index.ts';
import { CODEX_CONFIG_DEFAULTS } from '../../lib/fixed-layer.ts';
import { CODEX_FACTS } from '../../lib/facts.ts';
import type { HarnessPart } from './context.ts';

/** What Codex itself writes into `skills/` on its first start (its bundled skills): never swept, never replaced. */
const CODEX_OWNED_SKILLS: readonly string[] = ['.system'];

/** Codex's `AGENTS.md`: the instructions every launch writes into the ferret's home. */
function agentsDocument(spec: LaunchSpec): string {
  const sections = [
    ...spec.instructions.map(entry => entry.text.trim()),
    ...spec.parts.flatMap(part => (part.kind === 'instruction' ? [part.text.trim()] : [])),
  ].filter(text => text !== '');
  return sections.length === 0 ? '' : `${sections.join('\n\n')}\n`;
}

/**
 * Codex's `config.toml`: the settings items on this machine merged in name order (what Claude's home does with its own,
 * so `shell_environment_policy.set` and every other Codex setting reaches the harness), then one `[mcp_servers.<name>]`
 * table per MCP server the launch adds. A server the launch adds replaces a settings item's server of the same name.
 */
function configDocument(spec: LaunchSpec, items: ReadonlyMap<string, SettingsItem>): string {
  const { mcp_servers: declared, ...settings } = settingsDocument(items);
  const servers: Record<string, Record<string, unknown>> = {};
  if (typeof declared === 'object' && declared !== null && !Array.isArray(declared)) {
    for (const [name, config] of Object.entries(declared))
      if (typeof config === 'object' && config !== null && !Array.isArray(config))
        servers[name] = config as Record<string, unknown>;
  }
  for (const part of spec.parts) {
    if (part.kind !== 'mcp') continue;
    const config = part.config;
    servers[part.name] = typeof config === 'object' && config !== null && !Array.isArray(config) ? config : {};
  }
  const blocks = [
    // The defaults first, then the person's items over them: an explicit value is never overwritten.
    tomlDocument({ ...CODEX_CONFIG_DEFAULTS, ...settings }),
    Object.keys(servers).length === 0 ? '' : tomlTables('mcp_servers', servers),
  ].filter(block => block !== '');
  return blocks.length === 0 ? '' : `${blocks.join('\n\n')}\n`;
}

/** The ferret's home: where it is, and what is written into it before a launch. */
export const homePart: HarnessPart<'homeFor' | 'prepareHome'> = ({
  kernel,
  linked,
  settingsNow,
  homeOf,
  ensureHome,
  poolHistory,
}) => {
  /** Said once: a composition without a configuration port writes no settings item into any home. */
  let saidNoSettings = false;

  /**
   * The login's sign-in file in this ferret's home: ONE link `auth.json`, made by the kernel from the credential Logins
   * shared with this plugin, or nothing. The name is always cleared first (agent homes are Ferretry's only, so no file
   * there is the person's): a stale link goes, and so does a file Codex may have written in its place (a refresh that
   * did not write in place), said once so the loss is visible. A FOLDER at the name is never removed.
   */
  const placeCredential = async (root: RootHandle, spec: LaunchSpec): Promise<void> => {
    const at = root.resolve('auth.json');
    if (!at.ok) throw new Error(`Codex's auth.json could not be placed in the ferret's home: ${at.error}`);
    const found = await root.lstat(at.value);
    if (found?.kind === 'symlink') await root.unlink(at.value);
    else if (found?.kind === 'file') {
      kernel.log.warn(
        "a ferret's auth.json was a file, not the login’s link: Codex may have replaced it (see the credential-link contract)",
      );
      await root.remove(at.value);
    } else if (found !== undefined) throw new Error("a ferret's auth.json is a folder, not the login's link");
    linked.delete(spec.ferret);
    if (spec.credential === undefined) return;
    await root.linkCredential(spec.credential, at.value);
    linked.set(spec.ferret, spec.login);
  };

  return {
    /** `state/codex/agent-homes/<ferret>`, resolved through this plugin's own `agent-homes` root (S42). */
    async homeFor(ferret: FerretId): Promise<FencedPath> {
      return homeOf(ferret);
    },

    async prepareHome(spec: LaunchSpec): Promise<HomePlan> {
      const root = await ensureHome(spec);
      await poolHistory(spec.ferret);
      await placeCredential(root, spec);
      // The selected skills: Skills' shared folders linked into `skills/`, the rest swept; Codex's own `.system` stays.
      await materializeSkills(root, spec.parts, CODEX_OWNED_SKILLS);
      const files: FencedPath[] = [];
      // ONE read of this plugin's own settings items per home written (`config/codex/settings/`).
      const items = await settingsNow(spec.runtime);
      if (kernel.config === undefined && !saidNoSettings) {
        saidNoSettings = true;
        kernel.log.warn(
          "this composition gives Codex no configuration port, so no settings item reaches a ferret's home",
        );
      }
      for (const [name, text] of [
        [CODEX_FACTS.instructionFile, agentsDocument(spec)],
        [CODEX_FACTS.mcp.file, configDocument(spec, items)],
      ] as const) {
        const target = root.resolve(name);
        if (!target.ok) throw new Error(`Codex's ${name} could not be placed in the ferret's home: ${target.error}`);
        const found = await root.lstat(target.value);
        if (found?.kind === 'symlink') {
          // Repair only a dangling link to an absent name in this home. The scoped checks prove its parent exists
          // inside the home too; an existing target, an escape or an unprovable target stays refused. `readlink` is
          // already a declared host program and reads only the link text, never a target's contents.
          const link = await kernel.spawn
            ?.run('readlink', [target.value], { timeout: seconds(10) })
            .catch(() => undefined);
          const destination = link?.exitCode === 0 ? root.resolve(link.stdout.replace(/\n$/u, '')) : undefined;
          if (destination?.ok !== true || (await root.lstat(destination.value)) !== undefined)
            throw new Error('root refused: link_escape');
          const parent = destination.value.slice(0, destination.value.lastIndexOf('/')) as FencedPath;
          await root.realPath(parent).catch(() => {
            throw new Error('root refused: link_escape');
          });
          await root.unlink(target.value);
        }
        if (text === '') {
          // Nothing to say now: a config.toml an earlier launch of this reused home left must not stay applied (the
          // settings this profile no longer selects). A FILE there is ours to clear too.
          if (name === CODEX_FACTS.mcp.file && found?.kind === 'file') await root.remove(target.value);
          continue;
        }
        // Both modes keep the leaf literal and use the kernel's scoped no-follow write: a link swapped in after
        // the look above is refused, including one that points at another file in the same home.
        await root.writeText(
          target.value,
          text,
          found?.kind === 'file' ? { replaceExisting: true } : { exclusive: true },
        );
        files.push(target.value);
      }
      return { files, args: [] };
    },
  };
};
