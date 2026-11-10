import { createHash } from 'node:crypto';
import type { ConfigFileDef } from '../contract/define.ts';
import { acceptedConfigFile, acceptedName } from './config/accepted.ts';
import { readConfigDisk } from './config/disk.ts';
import { type AcceptedConfig, defaultsOf, evaluateConfig } from './config/evaluate.ts';
import type { HostFs } from './state/host-fs.ts';
import { createStatePort } from './state/state-port.ts';

/**
 * What `fyd --check` reads of a plugin's OWN configuration for `SelftestProbe.enabledBy` (kernel batch #14): the value
 * boot would put into effect, read-only. Nothing is written — no accepted record, no schema file, no folder — so the
 * check still creates no home state.
 */
export interface SelftestConfigReader {
  /** The parsed value in effect for this plugin's file, its defaults when there is no file, or `undefined` for none. */
  inEffect(plugin: string, def: ConfigFileDef<unknown>): Promise<unknown>;
}

const digest = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/**
 * Boot's rule for one file (`evaluateConfig`): the disk text as the config service reads it (`readConfigDisk`) against
 * the record last accepted FOR THIS PLUGIN. A broken file keeps its last good version; an edit that loosens or adds a
 * secret reference is held, so the tighter version is the answer; a file that was never good and is broken now is
 * `undefined`. GAP(kernel): a write set interrupted mid-way (`config-write-set.json`) is rolled back by the daemon's next
 * load, not here, so `--check` judges the files as they stand until then.
 */
export function inEffectConfigReader(options: {
  readonly home: string;
  readonly fs: HostFs;
  readonly binary: string;
}): SelftestConfigReader {
  const state = createStatePort({
    home: options.home,
    pluginId: 'kernel',
    files: [acceptedConfigFile],
    fs: options.fs,
  });
  return {
    inEffect: async (plugin, def) => {
      const path = def.file;
      const disk = await readConfigDisk(options.fs, `${options.home}/config/${path}`);
      let accepted: AcceptedConfig | undefined;
      try {
        const read = await state.read(acceptedConfigFile, acceptedName(path));
        accepted =
          read.ok && read.value?.plugin === plugin ? { etag: read.value.etag, text: read.value.text } : undefined;
      } catch {
        accepted = undefined;
      }
      const evaluated = evaluateConfig({ def, path, disk, accepted, digest, binary: options.binary });
      if (evaluated.value !== undefined) return evaluated.value;
      return evaluated.state === 'absent' ? defaultsOf(def) : undefined;
    },
  };
}
