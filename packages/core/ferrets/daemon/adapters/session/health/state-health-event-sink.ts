import type { StatePort } from '@ferretry/kernel/contract';
import type { JsonValue } from '@ferretry/std';
import { HealthEventsFile } from '../../../../contract/index.ts';
import type { ClockPort } from '../../../lib/ports.ts';
import type { SessionHealthEventSink } from '../../../lib/session/health/service.ts';
import type { SessionHealthEvent } from '../../../lib/session/health/types.ts';

/**
 * How big `health.jsonl` may grow before it is compacted, and how much of it is kept when it is. A fault that persists
 * writes a line every self-check (one a minute), so an uncapped journal is a file that grows for as long as the fault
 * does. The newest half of the cap survives a compaction: the most recent events are the ones an operator reads.
 */
export const HEALTH_EVENTS_MAX_BYTES = 512 * 1024;
const HEALTH_EVENTS_KEEP_BYTES = HEALTH_EVENTS_MAX_BYTES / 2;

/** What the sink stands on: the append, the size check, the tail it keeps and the swap that compacts. */
type HealthEventsState = Pick<StatePort, 'append' | 'version' | 'tail' | 'write'>;

/**
 * Fleet-wide health events, appended to Ferrets' own `health.jsonl` through its state port.
 *
 * They are recorded rather than only logged because the failures they describe — a starved event loop, an index that
 * will not heal — are invisible by the time an operator looks, and a log line that has already rotated proves nothing
 * about last week's wedge. They go to a daemon journal rather than a session's: none of them belong to a session.
 *
 * The journal is bounded: once a write takes it past {@link HEALTH_EVENTS_MAX_BYTES}, the newest
 * {@link HEALTH_EVENTS_KEEP_BYTES} of it are swapped in whole (the port swaps a jsonl file in on the chain its appends
 * take, so a reader never sees half of it). A compaction that fails is dropped: the event itself was already written.
 */
export class StateSessionHealthEventSink implements SessionHealthEventSink {
  constructor(
    private readonly state: HealthEventsState,
    private readonly clock: ClockPort,
  ) {}

  async emit(event: SessionHealthEvent): Promise<void> {
    await this.state.append(HealthEventsFile, {
      at: this.clock.now(),
      type: event.type,
      // The events' `data` is built from strings, numbers and lists by the lib; the line's schema proves it on read.
      data: event.data as Record<string, JsonValue>,
    });
    await this.compact().catch(() => undefined);
  }

  private async compact(): Promise<void> {
    const version = await this.state.version(HealthEventsFile);
    if (version === undefined || version.size <= HEALTH_EVENTS_MAX_BYTES) return;
    const kept = await this.state.tail(HealthEventsFile, { maxBytes: HEALTH_EVENTS_KEEP_BYTES });
    // A jsonl file's `write` takes the ARRAY of its records (the port's own words), which its `Shape` parameter, one
    // line's, cannot say.
    await this.state.write(HealthEventsFile, [...kept.records] as unknown as (typeof kept.records)[number]);
  }
}
