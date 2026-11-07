/**
 * A real configuration directory for the integration tier: the daemon's own `ConfigFilesService` over
 * `FileConfigDirectory` and the state filesystem, in a temporary state home — exactly the wiring the
 * composition root builds, minus the watcher.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { type AccountModel, accountModelFiles, renderConfigFile } from '@ferretry/fleet';
import { CONFIG_ACCEPTED_FILE, type ConfigIssue, type ConfigPending } from '@ferretry/protocol';
import { FileAcceptedConfigStore, FileConfigDirectory } from '../../../src/adapters/config-files/files.ts';
import { StateFileSystem } from '../../../src/adapters/filesystem/state-file-system.ts';
import { ConfigFilesService } from '../../../src/lib/config-files/index.ts';
import { createFoundationPaths, type FoundationPaths, resolveStateHome } from '../../../src/lib/index.ts';

export interface ConfigHome {
  readonly paths: FoundationPaths;
  readonly service: ConfigFilesService;
  /** What the service told its log. */
  readonly logged: { readonly issues: ConfigIssue[]; readonly pending: ConfigPending[] };
}

export const sha256 = (text: string): string => new Bun.CryptoHasher('sha256').update(text).digest('hex');

/** A configuration service over `<home>/config`, the accepted record in `<home>/state`. */
export async function configHome(home: string): Promise<ConfigHome> {
  const paths = createFoundationPaths(resolveStateHome({ fyHome: home, homeDirectory: home }));
  await mkdir(paths.config, { recursive: true });
  await mkdir(paths.state, { recursive: true });
  await mkdir(paths.fleet, { recursive: true });
  const files = new StateFileSystem(paths);
  const logged = { issues: [] as ConfigIssue[], pending: [] as ConfigPending[] };
  const service = new ConfigFilesService({
    directory: new FileConfigDirectory(paths.config, files),
    accepted: new FileAcceptedConfigStore(join(paths.state, CONFIG_ACCEPTED_FILE), files),
    log: { issue: issue => logged.issues.push(issue), pending: pending => logged.pending.push(pending) },
    digest: sha256,
    now: () => new Date('2026-10-16T00:00:00Z'),
  });
  return { paths, service, logged };
}

/** Write `model` as its per-file layout under `configDirectory`, by hand, the way an owner would. */
export async function writeModelFiles(configDirectory: string, model: AccountModel): Promise<void> {
  for (const [path, { address, value }] of accountModelFiles(model)) {
    const text = renderConfigFile(path, address, value, undefined);
    if (text === undefined) continue;
    const target = join(configDirectory, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, text, { mode: 0o600 });
  }
}
