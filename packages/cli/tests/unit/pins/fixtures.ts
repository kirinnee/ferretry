import type { MessagePin, NotePin, Pin, PinActionRequest, PinBlockKind, PinSnapshot } from '@ferretry/protocol';
import type { IPinGateway, IPinOutput } from '../../../src/lib/pins/ports';

export const SESSION = 'ms8kkfyd-95b7037e';
export const NOTE_ID = '11111111-1111-4111-8111-111111111111';
export const MESSAGE_ID = '22222222-2222-4222-8222-222222222222';

export function humanNote(id: string, text: string, at = 1): NotePin {
  return { id, at, kind: 'note', text, by: 'human', createdBy: null, createdByName: null };
}

export function agentNote(id: string, text: string, createdByName: string | null, at = 1): NotePin {
  return { id, at, kind: 'note', text, by: 'agent', createdBy: 'agent-session', createdByName };
}

export function humanMessage(id: string, preview: string, blockKind: PinBlockKind = 'assistant', at = 1): MessagePin {
  return {
    id,
    at,
    kind: 'message',
    blockId: `block-${at}`,
    blockKind,
    preview,
    by: 'human',
    createdBy: null,
    createdByName: null,
  };
}

export function snapshot(pins: readonly Pin[], sessionId = SESSION): PinSnapshot {
  return { v: 1, sessionId, pins: [...pins], updatedAt: '2026-07-31T09:00:00.000Z' };
}

/** Records every call so a test can assert the request the controller decided to send. */
export class RecordingPinGateway implements IPinGateway {
  readonly listed: string[] = [];
  readonly applied: Array<{ sessionId: string; request: PinActionRequest }> = [];

  constructor(
    private readonly board: PinSnapshot,
    private readonly result: PinSnapshot = board,
  ) {}

  list(sessionId: string): Promise<PinSnapshot> {
    this.listed.push(sessionId);
    return Promise.resolve(this.board);
  }

  apply(sessionId: string, request: PinActionRequest): Promise<PinSnapshot> {
    this.applied.push({ sessionId, request });
    return Promise.resolve(this.result);
  }
}

/** Captures what the controller printed. */
export class CapturingOutput implements IPinOutput {
  readonly messages: string[] = [];

  success(message: string): void {
    this.messages.push(message);
  }
}
