/**
 * `kernel.selfCounters` on the real machine: this process's own `/proc/self/io` and `/proc/self/stat`, each method reading
 * ITS one fixed path (`proc` is the root a suite points at a fixture tree). There is no pid, file name or path parameter, so
 * the port cannot be asked for another process or another file.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SelfCountersPort } from '../../contract/ports.ts';

export function nodeSelfCounters(roots: { readonly proc?: string } = {}): SelfCountersPort {
  const proc = roots.proc ?? '/proc';
  return Object.freeze({
    platform: process.platform,
    io: async () => await readFile(join(proc, 'self', 'io'), 'utf8'),
    stat: async () => await readFile(join(proc, 'self', 'stat'), 'utf8'),
  });
}

/** What a plugin without `permissions.selfCounters` holds: every read refuses, naming the plugin. */
export function undeclaredSelfCounters(plugin: string, platform: string): SelfCountersPort {
  const refuse = async (): Promise<never> => {
    throw new Error(`${plugin} did not declare permissions.selfCounters, so it reads no process counters.`);
  };
  return Object.freeze({ platform, io: refuse, stat: refuse });
}

/** A host with no counters adapter (a suite): the port exists and every read refuses. */
export const NO_SELF_COUNTERS: SelfCountersPort = undeclaredSelfCounters('this host', process.platform);
