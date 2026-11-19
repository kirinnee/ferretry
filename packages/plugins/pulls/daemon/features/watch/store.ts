import type { Log, StatePort } from '@ferretry/kernel/contract';
import { WATCH_STATE, WatchProjectIdSchema, type WatchSnapshot } from '../../../contract/index.ts';

/**
 * `state/pulls/watch/<project>.json`: what the watch last saw, so a change is told once and a restart does not tell it
 * again. It holds PR titles of private repositories, so it goes with the project and with the account that read it.
 * A file that is damaged reads as "never looked": the next look is a silent baseline, never a burst of old news.
 */
export class WatchStore {
  constructor(
    private readonly state: StatePort,
    private readonly log: Log,
  ) {}

  async read(project: string): Promise<WatchSnapshot | undefined> {
    if (!WatchProjectIdSchema.safeParse(project).success) return undefined;
    const read = await this.state.read(WATCH_STATE, project);
    if (!read.ok) {
      this.log.warn('a watch snapshot could not be read; the next look is a baseline', { reason: read.error.reason });
      return undefined;
    }
    return read.value;
  }

  async write(project: string, snapshot: WatchSnapshot): Promise<void> {
    if (!WatchProjectIdSchema.safeParse(project).success) return;
    await this.state.write(WATCH_STATE, snapshot, project);
  }

  async remove(project: string): Promise<void> {
    if (!WatchProjectIdSchema.safeParse(project).success) return;
    await this.state.remove(WATCH_STATE, project);
  }

  /** Every project that has a snapshot. */
  async projects(): Promise<readonly string[]> {
    return (await this.state.list(WATCH_STATE)).map(name => name.replace(/\.json$/u, ''));
  }
}
