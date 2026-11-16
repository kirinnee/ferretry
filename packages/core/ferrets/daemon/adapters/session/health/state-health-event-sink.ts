import type { StatePort } from '@ferretry/kernel/contract';
import type { JsonValue } from '@ferretry/std';
import { HealthEventsFile } from '../../../../contract/index.ts';
import type { ClockPort } from '../../../lib/ports.ts';
import type { SessionHealthEventSink } from '../../../lib/session/health/service.ts';
import type { SessionHealthEvent } from '../../../lib/session/health/types.ts';

/**
 * Fleet-wide health events, appended to Ferrets' own `health.jsonl` through its state port.
 *
 * They are recorded rather than only logged because the failures they describe — a starved event loop, an index that
 * will not heal — are invisible by the time an operator looks, and a log line that has already rotated proves nothing
 * about last week's wedge. They go to a daemon journal rather than a session's: none of them belong to a session.
 */
export class StateSessionHealthEventSink implements SessionHealthEventSink {
  constructor(
    private readonly state: Pick<StatePort, 'append'>,
    private readonly clock: ClockPort,
  ) {}

  async emit(event: SessionHealthEvent): Promise<void> {
    await this.state.append(HealthEventsFile, {
      at: this.clock.now(),
      type: event.type,
      // The events' `data` is built from strings, numbers and lists by the lib; the line's schema proves it on read.
      data: event.data as Record<string, JsonValue>,
    });
  }
}
