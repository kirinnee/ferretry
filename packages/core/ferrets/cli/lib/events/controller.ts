import { SessionCommandError } from '../session/errors.ts';
import type { IEventStream, IStreamIo } from '../stream/ports.ts';
import { renderEvent } from '../stream/render.ts';

/** Flags accepted by `fy events` and its `fy view` alias. */
export interface EventsOptions {
  readonly after?: number;
  readonly limit?: number;
  readonly json?: boolean;
}

/** A caller-supplied number that must be a whole one, at least `minimum`. */
function whole(value: number | undefined, flag: string, minimum: 0 | 1): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < minimum)
    throw new SessionCommandError(`${flag} must be a ${minimum === 0 ? 'non-negative' : 'positive'} integer`);
  return value;
}

/**
 * `fy events <id>` (and `fy view`): the journal events recorded for one ferret, after `--after`, at most `--limit`, one
 * line each (`--json`: one protocol event per line).
 *
 * v4 paged a durable history route. 5.0 has one journal read, the `GET /v1/events` socket behind `fy stream`, and its
 * replay is exactly that history: the daemon sends every recorded event after the cursor, then the FIRST idle frame
 * ("everything before it was replay"). This reads up to that frame (or the limit) and leaves, so it ends by itself where
 * `fy stream` follows on. No route is added and the capability is the socket's own.
 */
export class EventsController {
  constructor(
    private readonly stream: IEventStream,
    private readonly out: Pick<IStreamIo, 'success'>,
  ) {}

  async read(ferretId: string, options: EventsOptions): Promise<void> {
    const after = whole(options.after, '--after', 0) ?? 0;
    const limit = whole(options.limit, '--limit', 1);
    const leave = new AbortController();
    let previous = after;
    let printed = 0;
    await this.stream.follow(
      { ferretId, after },
      frame => {
        if (leave.signal.aborted) return;
        if (frame.kind === 'idle') {
          leave.abort();
          return;
        }
        if (frame.kind !== 'event') return;
        const event = frame.event;
        if (event.sessionId !== ferretId)
          throw new Error(`the daemon returned an event for ${event.sessionId} while reading ${ferretId}`);
        if (event.sequence <= previous)
          throw new Error(
            `the daemon returned a non-advancing event sequence #${event.sequence} for ${event.sessionId} after #${previous}`,
          );
        previous = event.sequence;
        printed += 1;
        this.out.success(options.json === true ? JSON.stringify(event) : renderEvent(event));
        if (printed === limit) leave.abort();
      },
      leave.signal,
    );
  }
}
