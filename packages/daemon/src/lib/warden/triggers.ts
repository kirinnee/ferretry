/**
 * The session events that bring a sweep forward.
 *
 * The timer alone means a ferret that asked a question waits up to a whole interval before anyone
 * looks. Three events are worth reacting to at once: a turn ended (the ferret handed control back), a
 * question is waiting, and a pane died. Each is read from the daemon's own journal, so a trigger is a
 * fact this daemon recorded, never a claim from outside.
 *
 * A trigger only brings the SWEEP forward. The sweep is free; whether a flag then costs anything is the
 * triage's decision, under the same caps as a timed sweep.
 *
 * Pure: the event arrives as its journal type and data.
 */

import type { WardenEventTrigger, WardenEventTriggers } from '@ferretry/protocol';

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The trigger a journal event is, or `undefined` for every event that is not one. */
export function wardenEventTrigger(type: string, data: unknown): WardenEventTrigger | undefined {
  if (type === 'session.exited' || type === 'session.failed') return 'paneDied';
  if (type !== 'turn.state' || !isRecord(data)) return undefined;
  if (data.to === 'your-turn') return 'turnEnd';
  if (data.to === 'needs-input') return 'question';
  return undefined;
}

/** Whether the owner's settings react to this trigger. */
export function wardenTriggerEnabled(trigger: WardenEventTrigger, events: WardenEventTriggers): boolean {
  return events[trigger];
}
