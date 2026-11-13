/**
 * The configuration directory as `fy config` reads it, with no daemon: every `.yaml` file under `<home>/config`, and the
 * daemon's accepted record, read only.
 *
 * NEVER FOLLOWS A LINK, for the reason the daemon does not: a link in the config directory could point a reader at any
 * file this user can read. A link — or a file too large to be configuration — is named as unreadable instead, exactly as
 * the daemon reports it (`readConfigDisk` is the daemon's own reader). Nothing here writes: no file, no folder, no record.
 */
import { createHash } from 'node:crypto';
import { config, state } from '@ferretry/kernel/host';
import type { AcceptedRecord, ConfigDiskFile, ConfigFilesPort } from '../lib/config/ports.ts';

/** How deep the layout goes below `config/`: a folder of items, one level (`runtimes/<name>.yaml`). */
const MAX_DEPTH = 3;

export interface ConfigFilesInputs {
  /** The state home, absolute (`<FY_HOME>`). */
  readonly home: string;
  /** Production leaves this out; tests pass a memory filesystem so no test reads a real home. */
  readonly fs?: state.HostFs;
}

export function createConfigFiles(inputs: ConfigFilesInputs): ConfigFilesPort {
  const fs = inputs.fs ?? state.createNodeHostFs();
  const directory = `${inputs.home}/config`;
  return {
    directory,
    async list(): Promise<readonly ConfigDiskFile[]> {
      const found: ConfigDiskFile[] = [];
      const visit = async (relative: string, depth: number): Promise<void> => {
        const entries = await fs.list(relative === '' ? directory : `${directory}/${relative}`);
        for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
          // A hidden entry is an editor's swap file or the schema folder, never a configuration file.
          if (entry.name.startsWith('.')) continue;
          const path = relative === '' ? entry.name : `${relative}/${entry.name}`;
          if (entry.directory) {
            if (depth < MAX_DEPTH) await visit(path, depth + 1);
            continue;
          }
          // A link is never followed, whatever its name.
          if (!entry.regularFile) {
            found.push({ path, disk: { kind: 'unreadable' } });
            continue;
          }
          if (!entry.name.endsWith(config.CONFIG_EXTENSION)) continue;
          found.push({ path, disk: await config.readConfigDisk(fs, `${directory}/${path}`) });
        }
      };
      await visit('', 1);
      return found;
    },
    /** The daemon's record; empty when there is none, or when it does not read — the stricter reading. */
    async accepted(): Promise<Readonly<Record<string, AcceptedRecord>>> {
      const port = state.createStatePort({
        home: inputs.home,
        pluginId: 'kernel',
        files: [config.acceptedConfigFile],
        fs,
      });
      const records: Record<string, AcceptedRecord> = {};
      try {
        for (const name of await port.list(config.acceptedConfigFile)) {
          const read = await port.read(config.acceptedConfigFile, name);
          if (!read.ok || read.value === undefined) continue;
          const { etag, text, plugin } = read.value;
          records[config.pathOfAcceptedName(name)] = plugin === undefined ? { etag, text } : { etag, text, plugin };
        }
      } catch {
        return {};
      }
      return records;
    },
    digest: text => createHash('sha256').update(text, 'utf8').digest('hex'),
  };
}
