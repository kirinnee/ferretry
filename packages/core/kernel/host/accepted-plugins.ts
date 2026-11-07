/**
 * `state/kernel/plugins-accepted.json` (§2.4, §7.6 step 1): the last enabled set the daemon accepted. A hand-edited
 * `config/plugins.yaml` that leaves a plugin without a required provider is refused at boot: the daemon starts with
 * this set and names the line to fix.
 */
import type { HostFs } from './adapters/node-fs.ts';

export const PLUGINS_ACCEPTED_FILE = 'state/kernel/plugins-accepted.json';
const PLUGINS_YAML = 'config/plugins.yaml';

/** The set as it was last accepted, or `undefined` when there is none or it cannot be read. */
export async function readAcceptedPlugins(fs: HostFs, home: string): Promise<ReadonlySet<string> | undefined> {
  try {
    const parsed = JSON.parse(await fs.readText(`${home}/${PLUGINS_ACCEPTED_FILE}`)) as {
      readonly format?: unknown;
      readonly enabled?: unknown;
    };
    if (parsed.format !== 1 || !Array.isArray(parsed.enabled)) return undefined;
    return new Set(parsed.enabled.filter((id): id is string => typeof id === 'string'));
  } catch {
    return undefined;
  }
}

/** Format 1, `0600`, atomic; only when the set changed. */
export async function writeAcceptedPlugins(
  fs: HostFs,
  home: string,
  enabled: readonly string[],
  previous: ReadonlySet<string> | undefined,
): Promise<void> {
  const sorted = [...new Set(enabled)].sort();
  if (previous !== undefined && previous.size === sorted.length && sorted.every(id => previous.has(id))) return;
  await fs.writeAtomic(
    `${home}/${PLUGINS_ACCEPTED_FILE}`,
    `${JSON.stringify({ format: 1, enabled: sorted }, null, 2)}\n`,
    0o600,
  );
}

/** The 1-based line of `config/plugins.yaml` that names `id`, when the file can be read and names it. */
export async function pluginsYamlLine(fs: HostFs, home: string, id: string): Promise<number | undefined> {
  try {
    const lines = (await fs.readText(`${home}/${PLUGINS_YAML}`)).split('\n');
    const pattern = new RegExp(`^\\s*["']?${id.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}["']?\\s*:`, 'u');
    const index = lines.findIndex(line => pattern.test(line));
    return index === -1 ? undefined : index + 1;
  } catch {
    return undefined;
  }
}
