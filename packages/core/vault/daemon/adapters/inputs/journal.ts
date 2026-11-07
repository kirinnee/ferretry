import type { StatePort } from '@ferretry/kernel/contract';
import {
  type HoldEvidence,
  HoldsFile,
  type InputRaise,
  InputRequestFiles,
  type InputRequestRecord,
  InputRequestRecordSchema,
} from '../../../contract/index.ts';
import type { InputJournal } from '../../lib/inputs/ports.ts';
import {
  type AgendaId,
  INPUT_JOURNAL_EVENT_TYPES,
  INPUT_QUARANTINE_EVENT_TYPES,
  type InputEvent,
  type InputQuarantineEvent,
  type InputRequest,
} from '../../lib/inputs/wire.ts';

/**
 * THE INPUT JOURNAL ON THE VAULT'S OWN STATE (§9.2). Today the input service journals into each session's journal;
 * in 5.0 it keeps `state/vault/input-requests/<id>.json` (the request without any value) and `state/vault/holds.jsonl`
 * (hold evidence, never reset, §9.3). Nothing written here has a field for a value, its length or a digest of it.
 *
 * Holds: `holds.jsonl` carries one line per terminal name. Today's per-attempt hold id is `<request>/<n>` and the
 * evidence line keeps the request; the attempt number and `unresolved` have no field in the frozen `HoldEvidenceSchema`
 * (a line without `until` is read as unresolved). That is a declared contract need (`hold`, `unresolved`).
 */

/** Which card a request is drawn on: found again through Asks after a restart (`(input, <request id>)`). */
export type CardOf = (requestId: string) => Promise<AgendaId | undefined>;

const TYPE_OF_STATE: Readonly<Record<InputRequestRecord['state'], InputEvent['type']>> = {
  pending: INPUT_JOURNAL_EVENT_TYPES.requested,
  delivering: INPUT_JOURNAL_EVENT_TYPES.delivering,
  delivered: INPUT_JOURNAL_EVENT_TYPES.delivered,
  refused: INPUT_JOURNAL_EVENT_TYPES.refused,
  expired: INPUT_JOURNAL_EVENT_TYPES.expired,
  cancelled: INPUT_JOURNAL_EVENT_TYPES.cancelled,
};

/** The request as the record keeps it: what the ferret asked for, with the card's own words and no value. */
export function raiseOf(request: InputRequest): InputRaise {
  return {
    target: request.target,
    prompt: request.prompt,
    fields: request.fields.map(field => ({
      id: field.id,
      ...(field.label === undefined ? {} : { label: field.label }),
      sensitivity: field.sensitivity,
      ...(field.element === undefined ? {} : { element: field.element }),
    })),
    submit: request.submit,
    ...(request.chain === undefined ? {} : { chain: request.chain }),
    ...(request.source === undefined ? {} : { source: { kind: 'sealed' as const, name: request.source.name } }),
  };
}

export class InputStateJournal implements InputJournal {
  constructor(
    private readonly state: Pick<StatePort, 'read' | 'write' | 'list' | 'append' | 'lines'>,
    private readonly cardOf: CardOf,
    private readonly now: () => string,
  ) {}

  async publish(sessionId: string, event: InputEvent, request?: InputRequest): Promise<void> {
    const current = await this.record(event.requestId);
    const raise = request === undefined ? current?.raise : raiseOf(request);
    if (raise === undefined) return;
    const record: InputRequestRecord = {
      format: 1,
      id: event.requestId,
      ferret: sessionId,
      raise,
      state: event.state,
      ...(event.reason === undefined ? {} : { reason: event.reason }),
      raisedAt: (current?.raisedAt ?? request?.raisedAt ?? event.at) as InputRequestRecord['raisedAt'],
      expiresAt: (event.expiresAt ?? current?.expiresAt ?? event.at) as InputRequestRecord['expiresAt'],
    };
    await this.state.write(InputRequestFiles, InputRequestRecordSchema.parse(record), event.requestId);
  }

  async history(sessionId: string): Promise<readonly InputEvent[]> {
    const events: InputEvent[] = [];
    for (const name of await this.state.list(InputRequestFiles)) {
      const record = await this.record(name);
      if (record === undefined || record.ferret !== sessionId) continue;
      const card = await this.cardOf(record.id);
      if (card === undefined) continue;
      events.push({
        type: TYPE_OF_STATE[record.state],
        requestId: record.id,
        agendaItemId: card,
        sessionId,
        target: record.raise.target,
        sensitivity: strongest(record.raise),
        submit: record.raise.submit,
        ...(record.raise.source === undefined ? {} : { sealed: record.raise.source.name }),
        state: record.state,
        ...(record.reason === undefined ? {} : { reason: record.reason }),
        expiresAt: record.expiresAt,
        at: record.raisedAt,
      });
    }
    return events;
  }

  async quarantine(_sessionId: string, event: InputQuarantineEvent): Promise<void> {
    const request = event.hold.split('/')[0];
    for (const name of event.names) {
      const line: HoldEvidence = {
        format: 1,
        at: event.at as HoldEvidence['at'],
        target: { kind: 'terminal', key: name },
        event: event.type === INPUT_QUARANTINE_EVENT_TYPES.started ? 'began' : 'ended',
        ...(request !== undefined && /^[0-9a-f]{32}$/u.test(request) ? { request } : {}),
        ...(event.unresolved === true ? {} : { until: event.until as HoldEvidence['until'] }),
      };
      await this.state.append(HoldsFile, line);
    }
  }

  async quarantines(sessionId: string): Promise<readonly InputQuarantineEvent[]> {
    const mine = new Set<string>();
    for (const name of await this.state.list(InputRequestFiles)) {
      const record = await this.record(name);
      if (record?.ferret === sessionId) mine.add(record.id);
    }
    const events: InputQuarantineEvent[] = [];
    for await (const line of this.state.lines(HoldsFile)) {
      if (line.request === undefined || !mine.has(line.request) || line.event === 'revealed') continue;
      events.push({
        type: line.event === 'began' ? INPUT_QUARANTINE_EVENT_TYPES.started : INPUT_QUARANTINE_EVENT_TYPES.ended,
        sessionId,
        names: [line.target.key],
        hold: `${line.request}/${line.target.key}`,
        ...(line.until === undefined ? { unresolved: true as const } : {}),
        until: line.until ?? this.now(),
        at: line.at,
      });
    }
    return events;
  }

  /** The prompt a request was raised with, for its card after a restart. */
  async promptOf(requestId: string): Promise<string | undefined> {
    return (await this.record(requestId))?.raise.prompt;
  }

  private async record(id: string): Promise<InputRequestRecord | undefined> {
    const read = await this.state.read(InputRequestFiles, id);
    return read.ok ? read.value : undefined;
  }
}

const RANK = { plain: 0, code: 1, private: 2, secret: 3 } as const;
function strongest(raise: InputRaise): InputEvent['sensitivity'] {
  const all = raise.fields?.map(field => field.sensitivity) ?? [raise.sensitivity ?? 'secret'];
  return all.reduce((a, b) => (RANK[b] > RANK[a] ? b : a), 'plain');
}
