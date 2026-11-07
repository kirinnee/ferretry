import type { StatePort } from '@ferretry/kernel/contract';
import { WARDEN_JEV_CHECKS } from '../../contract/index.ts';
import { type WardenJevCheck, WardenJevCheckSchema } from '../lib/protocol.ts';
import {
  expiredJevCheckFiles,
  jevCheckDay,
  jevCheckFileDay,
  jevCheckFileName,
  jevCheckFilesNewestFirst,
  type WardenJevCheckLog,
} from '../lib/index.ts';

interface DayDocument {
  readonly format: 1;
  readonly checks?: readonly unknown[];
}

/** Jev's checks, one `jev-checks/<day>.json` per UTC day, the oldest days dropped as new ones are written. */
export class StateWardenJevCheckLog implements WardenJevCheckLog {
  constructor(
    private readonly state: StatePort,
    private readonly nowMs: () => number,
  ) {}

  async append(check: WardenJevCheck): Promise<void> {
    const day = jevCheckDay(check) ?? new Date(this.nowMs()).toISOString().slice(0, 10);
    const written = await this.state.update(
      WARDEN_JEV_CHECKS,
      current => ({
        format: 1 as const,
        checks: [...((current as DayDocument | undefined)?.checks ?? []), check],
      }),
      day,
    );
    if (!written.ok) throw new Error(written.error.sentence);
    const expired = expiredJevCheckFiles((await this.days()).map(jevCheckFileName), this.nowMs());
    for (const name of expired) {
      const expiredDay = jevCheckFileDay(name);
      if (expiredDay !== undefined) await this.state.remove(WARDEN_JEV_CHECKS, expiredDay);
    }
  }

  async recent(limit: number): Promise<readonly WardenJevCheck[]> {
    const checks: WardenJevCheck[] = [];
    for (const name of jevCheckFilesNewestFirst((await this.days()).map(jevCheckFileName))) {
      if (checks.length >= limit) break;
      const day = jevCheckFileDay(name);
      if (day === undefined) continue;
      const read = await this.state.read(WARDEN_JEV_CHECKS, day);
      if (!read.ok) throw new Error(read.error.sentence);
      const parsed = ((read.value as DayDocument | undefined)?.checks ?? []).flatMap(entry => {
        const check = WardenJevCheckSchema.safeParse(entry);
        return check.success ? [check.data] : [];
      });
      // A day file holds its checks oldest first; the newest are wanted first.
      checks.push(...parsed.toReversed());
    }
    return checks.slice(0, limit);
  }

  private async days(): Promise<readonly string[]> {
    return await this.state.list(WARDEN_JEV_CHECKS);
  }
}
