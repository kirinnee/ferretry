import type { AutoResumeAvailabilityPort } from '../../../lib/session/auto-resume/types.ts';

/**
 * Whether the runtime a session ran on can serve right now.
 *
 * The question is the launch's own: `resolveStartAccount` is what a relaunch asks, so a session this
 * says yes to will not be refused by the revive for the same reason. Both halves are injected —
 * which runtime the session named, and how to resolve one — so this adapter holds no copy of the
 * fleet's rules.
 */
export class AccountAutoResumeAvailability implements AutoResumeAvailabilityPort {
  constructor(
    private readonly runtimeOf: (id: string) => Promise<string | undefined>,
    private readonly resolve: (runtime: string) => Promise<unknown>,
  ) {}

  async unavailable(id: string): Promise<string | undefined> {
    const runtime = await this.runtimeOf(id);
    if (runtime === undefined) return 'its session record names no runtime';
    try {
      await this.resolve(runtime);
      return undefined;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }
}
