/**
 * The facilities every plugin's `cli` half is handed (`CliContext`): the clock and a cancellable sleep, a text reader
 * (today's `readRecipe`), and the kernel's state port scoped to ONE plugin's own declared opaque files.
 */
import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { state, systemClock } from '@ferretry/kernel/host';
import type { Manifest } from '@ferretry/kernel/manifest';
import type { PluginHost } from '../lib/world.ts';

export interface PluginHostInputs {
  /** The state home, absolute (`<FY_HOME>`); a plugin's state is `<home>/state/<plugin-id>/`. */
  readonly home: string;
  /** Production leaves these out; tests pass fakes so no test touches the real disk or terminal. */
  readonly fs?: state.HostFs;
  readonly readFile?: (path: string) => Promise<string>;
  /** Whether an absolute path exists (default: `fs.access`, i.e. today's `existsSync`). */
  readonly pathExists?: (absolute: string) => Promise<boolean>;
  readonly readStdin?: () => Promise<string>;
  readonly cwd?: () => string;
}

export function createPluginHost(inputs: PluginHostInputs): PluginHost {
  const clock = systemClock();
  const fs = inputs.fs ?? state.createNodeHostFs();
  const readFile = inputs.readFile ?? (path => Bun.file(path).text());
  const readStdin = inputs.readStdin ?? (() => Bun.stdin.text());
  const cwd = inputs.cwd ?? (() => process.cwd());
  const pathExists = inputs.pathExists ?? (async absolute => await access(absolute).then(() => true, () => false));
  return {
    cwd,
    clock: { now: () => clock.now(), nowMs: () => clock.nowMs() },
    sleep: (delay, signal) => clock.sleep(delay, signal),
    // As today's `readRecipe`: no size cap; a relative path is relative to the working directory.
    readText: async path => (path === '-' ? await readStdin() : await readFile(path)),
    // As today's `existsSync(resolve(cwd, path))` (system-poller): no read, no stdin, a directory counts.
    exists: async path => await pathExists(resolve(cwd(), path)),
    ownState(manifest: Manifest) {
      // Only this plugin's own declared opaque files are ever visible to the port; anything else is refused.
      const files = (manifest.data?.state ?? []).filter(file => file.store === 'opaque');
      let port: state.HostStatePort | undefined;
      // Built on first use: a verb that never touches state never reaches the disk.
      const own = (): state.HostStatePort =>
        (port ??= state.createStatePort({ home: inputs.home, pluginId: manifest.id, files, fs, clock }));
      return Object.freeze({
        write: (file, value, name) => own().write(file, value, name),
        pathOf: (file, name) => own().pathOf(file, name),
        stat: (file, name) => own().stat(file, name),
        remove: (file, name) => own().remove(file, name),
        list: file => own().list(file),
        removeEmptyDirectory: (file, name) => own().removeEmptyDirectory(file, name),
        createPrivateDirectory: (file, name) => own().createPrivateDirectory(file, name),
      });
    },
  };
}
