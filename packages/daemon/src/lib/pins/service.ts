import type { Pin, PinSnapshot } from '@ferretry/protocol';
import {
  isPinBlockKind,
  isSafePinSessionId,
  normalizedPins,
  pinNoteText,
  pinPreview,
  pinProvenance,
} from './policy.ts';
import {
  PinError,
  type AddPin,
  type PinActor,
  type PinClock,
  type PinIdGenerator,
  type PinRepository,
  type PinSessionDirectory,
} from './types.ts';

export class PinService {
  constructor(
    private readonly sessions: PinSessionDirectory,
    private readonly pins: PinRepository,
    private readonly clock: PinClock,
    private readonly ids: PinIdGenerator,
  ) {}

  async list(sessionId: string): Promise<PinSnapshot> {
    await this.authorize(sessionId, {});
    return await this.pins.snapshot(sessionId);
  }

  async add(sessionId: string, input: AddPin, actor: PinActor): Promise<PinSnapshot> {
    const provenance = await this.authorize(sessionId, actor);
    const pin = this.newPin(input, provenance);
    return await this.pins.mutate(sessionId, current => {
      if (pin.kind === 'message' && current.some(item => item.kind === 'message' && item.blockId === pin.blockId))
        return current;
      if (pin.kind === 'note' && current.some(item => item.kind === 'note' && item.text.trim() === pin.text.trim()))
        return current;
      return normalizedPins([pin, ...current]);
    });
  }

  async edit(sessionId: string, id: string, text: unknown, actor: PinActor): Promise<PinSnapshot> {
    const provenance = await this.authorize(sessionId, actor);
    const nextText = pinNoteText(text);
    return await this.pins.mutate(sessionId, current => {
      const target = current.find(pin => pin.id === id);
      if (target === undefined) throw new PinError('not-found', `no pin ${id} in this session`);
      if (target.kind !== 'note') throw new PinError('invalid', 'only a note can be edited');
      this.assertMayMutate(target, provenance);
      if (target.text === nextText) return current;
      return current.map(pin =>
        pin.id === id && pin.kind === 'note' ? { ...pin, text: nextText, at: this.at() } : pin,
      );
    });
  }

  async remove(sessionId: string, id: string, actor: PinActor): Promise<PinSnapshot> {
    const provenance = await this.authorize(sessionId, actor);
    return await this.pins.mutate(sessionId, current => {
      const target = current.find(pin => pin.id === id);
      if (target === undefined) return current;
      this.assertMayMutate(target, provenance);
      return current.filter(pin => pin.id !== id);
    });
  }

  private newPin(input: AddPin, provenance: ReturnType<typeof pinProvenance>): Pin {
    const base = { id: this.ids.next(), at: this.at() } as const;
    if (input.kind === 'note') {
      const source = input.source?.blockId.trim();
      const note = {
        ...base,
        kind: 'note' as const,
        text: pinNoteText(input.text),
        ...(source ? { source: { blockId: source } } : {}),
      };
      return provenance.by === 'human'
        ? { ...note, by: 'human', createdBy: null, createdByName: null }
        : { ...note, by: 'agent', createdBy: provenance.createdBy, createdByName: provenance.createdByName };
    }
    if (typeof input.blockId !== 'string' || input.blockId.trim().length === 0) {
      throw new PinError('invalid', 'a message pin needs a blockId');
    }
    if (!isPinBlockKind(input.blockKind)) throw new PinError('invalid', 'message pin blockKind is invalid');
    const ts = typeof input.ts === 'string' && input.ts.length > 0 ? input.ts : undefined;
    const message = {
      ...base,
      kind: 'message' as const,
      blockId: input.blockId,
      blockKind: input.blockKind,
      preview: pinPreview(input.preview),
      ...(ts ? { ts } : {}),
    };
    return provenance.by === 'human'
      ? { ...message, by: 'human', createdBy: null, createdByName: null }
      : { ...message, by: 'agent', createdBy: provenance.createdBy, createdByName: provenance.createdByName };
  }

  private at(): number {
    const at = Date.parse(this.clock.now());
    if (!Number.isSafeInteger(at) || at < 1) throw new Error('pin clock returned an invalid instant');
    return at;
  }

  private async authorize(sessionId: string, actor: PinActor) {
    if (!isSafePinSessionId(sessionId)) throw new PinError('invalid', `not a valid session id: ${sessionId}`);
    const provenance = pinProvenance(actor);
    if (provenance.sessionId !== null && provenance.sessionId !== sessionId) {
      throw new PinError('forbidden', 'an agent may only pin to its own session');
    }
    if (!(await this.sessions.has(sessionId).catch(() => false)))
      throw new PinError('not-found', `no such session ${sessionId}`);
    return provenance;
  }

  private assertMayMutate(pin: Pin, provenance: ReturnType<typeof pinProvenance>): void {
    if (provenance.by === 'human') return;
    if (pin.by === 'agent' && pin.createdBy === provenance.createdBy) return;
    throw new PinError('forbidden', 'an agent may only change pins it created');
  }
}
