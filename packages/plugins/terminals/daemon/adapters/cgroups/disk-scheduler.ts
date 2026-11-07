import { readFile, realpath, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { DiskSchedulerPort, DiskSchedulerReading } from '../../lib/cgroups/index.ts';

/** `[none] mq-deadline kyber` → `none`: the bracketed scheduler is the active one. */
export function activeScheduler(text: string): string | undefined {
  return /\[([^\]]+)\]/u.exec(text)?.[1];
}

/**
 * Which IO scheduler the disk under the state home uses, because disk priority only works if that
 * scheduler honours it. The block device comes from `/sys/dev/block/<major:minor>` for the device the
 * state home is on; a partition resolves to its parent disk. Anything unreadable is an absent field —
 * "we could not tell" is reported as such, never as "none".
 */
export class SysfsDiskScheduler implements DiskSchedulerPort {
  constructor(
    private readonly deviceOf: () => Promise<{ readonly major: number; readonly minor: number } | undefined>,
    private readonly sysRoot = '/sys',
  ) {}

  async read(): Promise<DiskSchedulerReading> {
    const device = await this.deviceOf().catch(() => undefined);
    if (device === undefined) return {};
    try {
      let node = await realpath(join(this.sysRoot, 'dev', 'block', `${device.major}:${device.minor}`));
      // A partition has no queue of its own; its parent disk does.
      const own = await readFile(join(node, 'queue', 'scheduler'), 'utf8').catch(() => undefined);
      if (own === undefined) node = dirname(node);
      const scheduler = activeScheduler(
        (await readFile(join(node, 'queue', 'scheduler'), 'utf8').catch(() => '')) ?? '',
      );
      return { device: basename(node), ...(scheduler === undefined ? {} : { scheduler }) };
    } catch {
      return {};
    }
  }
}

/** The block device a path lives on, from `stat`'s `st_dev` (Linux `major:minor` encoding). */
export async function deviceOfPath(
  path: string,
): Promise<{ readonly major: number; readonly minor: number } | undefined> {
  const dev = BigInt((await stat(path, { bigint: true })).dev);
  return {
    major: Number(((dev >> 8n) & 0xfffn) | ((dev >> 32n) & ~0xfffn)),
    minor: Number((dev & 0xffn) | ((dev >> 12n) & ~0xffn)),
  };
}
