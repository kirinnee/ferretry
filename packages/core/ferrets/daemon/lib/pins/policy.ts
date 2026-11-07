import { MAX_PIN_NOTE_LENGTH, MAX_PIN_PREVIEW_LENGTH, MAX_PINS_PER_SESSION, type Pin } from '@ferretry/protocol';
import { MAX_AGENT_PINS_PER_SESSION, PinError, type PinActor, type PinProvenance } from './types.ts';

const SESSION_ID = /^[a-z0-9][a-z0-9_-]{0,127}$/u;
const BLOCK_KINDS = new Set(['user', 'assistant', 'thinking', 'tools', 'system', 'notice']);

export function isSafePinSessionId(value: unknown): value is string {
  return typeof value === 'string' && SESSION_ID.test(value);
}

export function pinProvenance(actor: PinActor): PinProvenance {
  const sessionId = actor.sessionId?.trim() ?? '';
  if (sessionId.length === 0 || sessionId === 'user') {
    return { by: 'human', createdBy: null, createdByName: null, sessionId: null };
  }
  const name = actor.name?.trim();
  return { by: 'agent', createdBy: sessionId, createdByName: name || null, sessionId };
}

export function isPinBlockKind(value: unknown): value is Extract<Pin, { kind: 'message' }>['blockKind'] {
  return typeof value === 'string' && BLOCK_KINDS.has(value);
}

export function pinPreview(value: unknown): string {
  const flattened = (typeof value === 'string' ? value : '').replace(/\s+/gu, ' ').trim();
  if (flattened.length <= MAX_PIN_PREVIEW_LENGTH) return flattened;
  return `${flattened.slice(0, MAX_PIN_PREVIEW_LENGTH - 1)}…`;
}

export function pinNoteText(value: unknown): string {
  if (typeof value !== 'string') throw new PinError('invalid', 'note text is required and must be a string');
  if (value.trim().length === 0) throw new PinError('invalid', 'note text may not be blank');
  if (value.length > MAX_PIN_NOTE_LENGTH) {
    throw new PinError('too-long', `note is ${value.length} characters; the maximum is ${MAX_PIN_NOTE_LENGTH}`);
  }
  return value;
}

export function deduplicatePins(pins: readonly Pin[]): readonly Pin[] {
  const ids = new Set<string>();
  const messageBlocks = new Set<string>();
  const unique: Pin[] = [];
  for (const pin of pins) {
    if (ids.has(pin.id)) continue;
    if (pin.kind === 'message') {
      if (messageBlocks.has(pin.blockId)) continue;
      messageBlocks.add(pin.blockId);
    }
    ids.add(pin.id);
    unique.push(pin);
  }
  return unique;
}

export function capPins(pins: readonly Pin[]): readonly Pin[] {
  let agents = 0;
  return pins
    .filter(pin => {
      if (pin.by === 'human') return true;
      agents += 1;
      return agents <= MAX_AGENT_PINS_PER_SESSION;
    })
    .slice(0, MAX_PINS_PER_SESSION);
}

export function normalizedPins(pins: readonly Pin[]): readonly Pin[] {
  return capPins(deduplicatePins(pins));
}
