import { afterAll } from 'bun:test';
import { sweepUndisposedRoots } from '../fixture';

/**
 * The tier's preload (`bunfig.e2e.toml`): after the last file, sweep every journey root that never
 * reached its own cleanup — a journey Bun abandoned at its timeout leaves its tmux servers running, and
 * `bun test` gives a process no `exit` event to do it in.
 */
afterAll(() => {
  sweepUndisposedRoots();
});
