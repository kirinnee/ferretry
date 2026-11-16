import { seconds } from '@ferretry/std';
import type { FerretId } from '@ferretry/kernel/contract';
import type { HarnessPart } from './context.ts';

/** How long one `codex queue` hand-over may take: the spike measured under a second; this is the ceiling. */
const INJECT_TIMEOUT = seconds(10);

/** A message larger than this is typed as before: it travels as one argv entry, and a huge one is not a chat message. */
const MAX_INJECT_BYTES = 64 * 1024;

/** A conversation id is one plain token before it reaches an argv (never an option, never a space). */
const PLAIN_THREAD = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;

/** Handing a message to the running Codex through its own queue. */
export const injectPart: HarnessPart<'inject'> = ({ kernel, locate, rollouts, homeOf }) => {
  return {
    /**
     * Hands the message to the RUNNING Codex TUI through Codex's own queue (`codex queue --thread <id> --message <text>`),
     * typing nothing: it lands as the next user turn whether the thread is idle or busy. It runs with the ferret's own
     * `CODEX_HOME` (the TUI's shared app-server daemon is per home). `handed` only on exit 0 AND Codex's own
     * "Queued message <id> for thread <thread>" line; anything else answers `unavailable` and sent nothing, so Ferrets
     * types the message as before. Total. The message text is never logged: ids only.
     */
    async inject(ferret: FerretId, text: string): Promise<'handed' | 'unavailable' | 'uncertain'> {
      try {
        const spawn = kernel.spawn;
        if (spawn === undefined || new TextEncoder().encode(text).length > MAX_INJECT_BYTES) return 'unavailable';
        const thread = (await rollouts.provedConversation(ferret))?.id;
        if (thread === undefined || !PLAIN_THREAD.test(thread)) return 'unavailable';
        const location = await locate();
        if (location.outcome !== 'located') return 'unavailable';
        // The located codex itself, never `env` (which would let this plugin run any program): CODEX_HOME goes in the
        // child's environment. `--message=<text>` keeps a message that starts with `-` from reading as an option.
        const result = await spawn.run(location.path, ['queue', '--thread', thread, `--message=${text}`], {
          env: { CODEX_HOME: homeOf(ferret) },
          timeout: INJECT_TIMEOUT,
        });
        // Codex's own acknowledgement is the proof, whatever the exit: a message it said it queued is never typed again.
        const queued = new RegExp(`Queued message \\S+ for thread ${thread}`, 'u');
        if (queued.test(result.stdout)) return 'handed';
        // Cut off by a signal (the timeout included) after the request may have reached Codex: it may still land, so it is
        // `uncertain` — answered unconfirmed and never sent again. An exit of its own without the line refused it.
        if (result.exitCode === null) {
          kernel.log.warn('codex queue was cut off; the message may still land and is not sent again', {
            ferret,
            thread,
            signal: result.signal,
          });
          return 'uncertain';
        }
        kernel.log.warn('codex queue did not hand a message over; it will be typed', {
          ferret,
          thread,
          exitCode: result.exitCode,
          signal: result.signal,
        });
        return 'unavailable';
      } catch {
        kernel.log.warn('codex queue could not run; the message will be typed', { ferret });
        return 'unavailable';
      }
    },
  };
};
