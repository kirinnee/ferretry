import { milliseconds } from '@ferretry/std';
import type { Clock, Log } from '../contract/ports.ts';

/** Today's best-effort boot sweep: bounded, awaited before the local listener and every carrier. */
export async function beforeListen(run: () => Promise<void>, plugin: string, clock: Clock, log: Log): Promise<void> {
  let cancel = (): void => {};
  const timeout = new Promise<'timeout'>(resolve => {
    cancel = clock.after(milliseconds(5_000), () => resolve('timeout'));
  });
  try {
    const result = await Promise.race([
      Promise.resolve()
        .then(run)
        .then(() => 'done' as const),
      timeout,
    ]);
    if (result === 'timeout') log.warn('beforeListen timed out; boot continues', { plugin });
  } catch {
    log.warn('beforeListen failed; boot continues', { plugin });
  } finally {
    cancel();
  }
}
