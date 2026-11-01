import type { ResumeOutcome } from './service.ts';

/**
 * What a migration says, and does to its record, when the relaunch onto the new login did not come up.
 *
 * `preserved` means the old harness is still the one serving the session. The record was already
 * restamped onto the target before the relaunch, so it is put back (`rollBack`): left alone, the next
 * Restart or revive would launch a login this move never reached. Any other outcome is a retry already
 * scheduled against the restamped record, which that retry needs, so the record stays.
 */
export async function settleUnrevivedRelaunch(input: {
  readonly disposition: Exclude<ResumeOutcome['disposition'], 'revived'>;
  readonly from: string;
  readonly rollBack: () => Promise<void>;
}): Promise<string> {
  if (input.disposition === 'preserved') {
    await input.rollBack();
    return (
      `the relaunch failed and the previous harness was still at a prompt, so ${input.from} is still serving ` +
      `this session and its record names ${input.from} again`
    );
  }
  return `the relaunch failed and an automatic retry was scheduled; the session is still on ${input.from}`;
}
