import { SessionCommandError } from '../session/errors.ts';
import type { IEventStream, IStreamIo } from './ports.ts';
import {
  renderEvent,
  renderFleetStreamCaughtUp,
  renderFleetStreamIdle,
  renderStreamCaughtUp,
  renderStreamIdle,
} from './render.ts';

/** Flags accepted by `fy stream`. */
export interface StreamOptions {
  readonly after?: number;
  readonly json?: boolean;
}

/** The two process events that release a long-lived stream. */
export interface StreamSignalSource {
  once(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
  off(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
}

/** A caller-supplied cursor, which may legitimately be zero. */
function cursor(value: number | undefined, flag: string): number {
  if (value === undefined) return 0;
  if (!Number.isSafeInteger(value) || value < 0)
    throw new SessionCommandError(`${flag} must be a non-negative integer`);
  return value;
}

/**
 * `fy stream [id]`: follow one ferret, or this daemon's whole fleet, over the journal socket until interrupted.
 *
 * Sequences stay per-ferret even in the fleet form, so every ferret owns its own cursor. A fleet socket starts with
 * the daemon's bounded recent tail and so refuses a non-zero `--after`; only a scoped stream can honestly resume one
 * numeric cursor. Silence is REPORTED: the daemon's idle frames prove a quiet feed is still live. The renderer prints
 * what the daemon sent, which it has already masked; nothing here unmasks or adds a credential.
 */
export class StreamController {
  constructor(
    private readonly stream: IEventStream,
    private readonly out: IStreamIo,
    /** The shipped command name, which prefixes every stderr note so it names a command that exists. */
    private readonly binaryName: string,
  ) {}

  async follow(ferretId: string | undefined, options: StreamOptions, signal: AbortSignal): Promise<void> {
    const after = cursor(options.after, '--after');
    if (ferretId === undefined && after !== 0)
      throw new SessionCommandError('a fleet stream has no global cursor; omit --after or name one ferret');
    if (signal.aborted) return;
    const positions = new Map<string, number>();
    if (ferretId !== undefined) positions.set(ferretId, after);
    let caughtUp = false;
    const note = (message: string): void => this.out.error(`${this.binaryName} stream: ${message}`);
    await this.stream.follow(
      { ...(ferretId === undefined ? {} : { ferretId }), after },
      frame => {
        if (frame.kind === 'event') {
          const event = frame.event;
          if (ferretId !== undefined && event.sessionId !== ferretId)
            throw new Error(`the daemon returned an event for ${event.sessionId} while following ${ferretId}`);
          const previous = positions.get(event.sessionId) ?? after;
          if (event.sequence <= previous)
            throw new Error(
              `the daemon returned a non-advancing event sequence #${event.sequence} for ${event.sessionId} after #${previous}`,
            );
          positions.set(event.sessionId, event.sequence);
          this.out.success(options.json === true ? JSON.stringify(event) : renderEvent(event));
          return;
        }
        // A live readout or a transcript note is only sent to a stream that asked for one; this one never does.
        if (frame.kind !== 'idle') return;
        if (ferretId === undefined) {
          if (frame.scope.kind !== 'fleet')
            throw new Error('the daemon returned a ferret idle proof for a fleet stream');
          const followed = frame.scope.followedSessions;
          note(caughtUp ? renderFleetStreamIdle(followed, frame.idleSeconds) : renderFleetStreamCaughtUp(followed));
          caughtUp = true;
          return;
        }
        const position = positions.get(ferretId) ?? after;
        if (frame.scope.kind !== 'session' || frame.scope.sessionId !== ferretId || frame.scope.after !== position)
          throw new Error('the daemon returned an idle proof that contradicted the followed ferret cursor');
        note(
          caughtUp ? renderStreamIdle(ferretId, position, frame.idleSeconds) : renderStreamCaughtUp(ferretId, position),
        );
        caughtUp = true;
      },
      signal,
    );
  }
}

/** Own the signal listeners for exactly as long as one stream is alive. */
export async function runCancellableStream(
  controller: Pick<StreamController, 'follow'>,
  id: string | undefined,
  options: StreamOptions,
  signals: StreamSignalSource,
): Promise<void> {
  const abort = new AbortController();
  const stop = (): void => abort.abort();
  signals.once('SIGINT', stop);
  signals.once('SIGTERM', stop);
  try {
    await controller.follow(id, options, abort.signal);
  } finally {
    signals.off('SIGINT', stop);
    signals.off('SIGTERM', stop);
  }
}
