import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { IDaemonRestartMarkerPort } from '../../lib/daemon/ports.ts';

/** The marker's name inside the state home. */
const MARKER_NAME = 'restarting.json';

const MarkerSchema = z.strictObject({ until: z.number().int().nonnegative() });

/** Where the restart marker lives for one state home. */
export const restartMarkerPath = (stateHome: string): string => join(stateHome, MARKER_NAME);

/**
 * `<state home>/restarting.json`: "a restart is underway until <instant>".
 *
 * `fy daemon restart` (and so every `fy daemon update`) writes it before the daemon goes down and
 * removes it once the new one serves, and every `fy` on the host reads it when the daemon refuses a
 * call: a person's `fy list` during a restart then waits the restart out instead of failing, while the
 * same command against a daemon somebody STOPPED still fails at once (`daemon-restart.ts`).
 *
 * IT EXPIRES ON ITS OWN. The instant inside is the only thing a reader trusts, so a marker a killed
 * `fy` never removed stops mattering within minutes, and nothing has to clean it up. Every operation
 * is best effort: a marker that cannot be written or read costs a call its patience, never a restart.
 */
export class FileDaemonRestartMarker implements IDaemonRestartMarkerPort {
  constructor(private readonly path: string) {}

  async mark(untilMs: number): Promise<void> {
    await writeFile(this.path, `${JSON.stringify({ until: Math.max(0, Math.floor(untilMs)) })}\n`, {
      mode: 0o600,
    }).catch(() => undefined);
  }

  async clear(): Promise<void> {
    await rm(this.path, { force: true }).catch(() => undefined);
  }

  /** Whether a restart is vouched for at `nowMs`. A missing, damaged or expired marker is not one. */
  async active(nowMs: number): Promise<boolean> {
    try {
      const parsed = MarkerSchema.safeParse(JSON.parse(await readFile(this.path, 'utf8')));
      return parsed.success && parsed.data.until > nowMs;
    } catch {
      return false;
    }
  }
}
