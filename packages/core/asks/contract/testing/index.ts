/**
 * `@ferretry/core-asks/contract/testing` (§7.8): an in-memory Asks port, the Asks port conformance suite, and the
 * `ask.sources` conformance a source plugin runs its registered spec through. The fake passes the same suites.
 */
import { describe, expect, test } from 'bun:test';
import type { FerretId } from '@ferretry/kernel/contract';
import {
  type AnswerEffect,
  type AnswerId,
  type Answerer,
  type AskAnswer,
  type AskDraft,
  AskDraftSchema,
  type AskFilter,
  type AskId,
  type AskSourceSpec,
  type AskSummary,
  type AsksApi,
  type CloseReason,
  type EntryId,
  type SourceKey,
} from '../index.ts';

const AT = '2026-11-07T12:00:00.000Z';
export const sourceKey = (key: string): SourceKey => key as SourceKey;
export const entryId = (id: string): EntryId => id as EntryId;

/** An in-memory Asks port. `answer` is TEST ONLY: the real port has no answer method (owner-only, by route). */
export class FakeAsks implements AsksApi {
  readonly #asks = new Map<AskId, AskSummary>();
  readonly #answers: AskAnswer[] = [];
  #next = 0;
  #nextAnswer = 0;

  async raise(ask: AskDraft): Promise<AskId> {
    const draft = AskDraftSchema.parse(ask);
    for (const existing of this.#asks.values())
      if (existing.source === draft.source && existing.entry === draft.entry) return existing.id;
    this.#next += 1;
    const id = `A${this.#next}` as AskId;
    this.#asks.set(id, {
      id,
      source: draft.source,
      entry: draft.entry,
      kind: draft.kind,
      subject: draft.subject,
      raisedBy: draft.raisedBy,
      ...(draft.ferret === undefined ? {} : { ferret: draft.ferret }),
      state: 'open',
      raisedAt: AT as AskSummary['raisedAt'],
    });
    return id;
  }
  async notify(notice: Omit<AskDraft, 'kind' | 'options'>): Promise<AskId> {
    return await this.raise({ ...notice, kind: 'notice' });
  }
  /** TEST ONLY: the owner answers. */
  answerAs(id: AskId, effect: AnswerEffect, by: Answerer = { kind: 'host' }, extra: Partial<AskAnswer> = {}): AnswerId {
    const ask = this.#asks.get(id);
    if (ask === undefined) throw new Error(`no ask ${id}`);
    this.#nextAnswer += 1;
    const answerId = `an_${this.#nextAnswer.toString(16).padStart(24, '0')}` as AnswerId;
    this.#answers.push({ id: answerId, ask: id, source: ask.source, entry: ask.entry, effect, by, at: AT as AskAnswer['at'], ...extra });
    this.#asks.set(id, { ...ask, state: 'answered' });
    return answerId;
  }
  async answers(filter: { readonly source: SourceKey; readonly entry?: EntryId }, since?: string) {
    return this.#answers.filter(
      a => a.source === filter.source && (filter.entry === undefined || a.entry === filter.entry) && (since === undefined || a.at > since),
    );
  }
  async close(id: AskId, _reason: CloseReason): Promise<void> {
    const ask = this.#asks.get(id);
    if (ask !== undefined) this.#asks.set(id, { ...ask, state: 'closed' });
  }
  async open(filter: AskFilter): Promise<readonly AskSummary[]> {
    return [...this.#asks.values()].filter(
      a =>
        (filter.state ?? 'open') === a.state &&
        (filter.source === undefined || a.source === filter.source) &&
        (filter.entry === undefined || a.entry === filter.entry) &&
        (filter.ferret === undefined || a.ferret === filter.ferret),
    );
  }
  async get(id: AskId) {
    return this.#asks.get(id);
  }
}

export interface AsksSubject {
  readonly asks: AsksApi;
  /** The owner answers (through the route in the real port). */
  answer(id: AskId, effect: AnswerEffect): Promise<AnswerId> | AnswerId;
}

const draft = (entry: string, ferret?: string): AskDraft => ({
  source: sourceKey('ferret'),
  ref: {},
  entry: entryId(entry),
  kind: 'yesno',
  subject: 'Ship it?',
  why: 'The release is ready.',
  raisedBy: { kind: 'ferret', ferret: ferret ?? 'f1' },
  ...(ferret === undefined ? {} : { ferret }),
});

/** The Asks port suite (§7.4): idempotent raise, answers by source and entry with their own ids, close, filters. */
export function asksConformance(name: string, make: () => AsksSubject | Promise<AsksSubject>): void {
  describe(`asks conformance: ${name}`, () => {
    test('the port has no way to answer', async () => {
      const { asks } = await make();
      expect('answer' in asks).toBe(false);
    });
    test('raise is idempotent by (source, entry)', async () => {
      const { asks } = await make();
      const first = await asks.raise(draft('e1'));
      expect(await asks.raise(draft('e1'))).toBe(first);
      expect(await asks.raise(draft('e2'))).not.toBe(first);
    });
    test('answers come back by source and entry, each with its own id', async () => {
      const subject = await make();
      const one = await subject.asks.raise(draft('e1'));
      const two = await subject.asks.raise(draft('e2'));
      const a1 = await subject.answer(one, 'approve');
      await subject.answer(two, 'reject');
      const answers = await subject.asks.answers({ source: sourceKey('ferret'), entry: entryId('e1') });
      expect(answers.map(a => a.id)).toEqual([a1]);
      expect(answers[0]?.ask).toBe(one);
    });
    test('open lists by ferret; a closed ask leaves the open list', async () => {
      const { asks } = await make();
      const mine = await asks.raise(draft('e1', 'f1'));
      await asks.raise(draft('e2', 'f2'));
      expect((await asks.open({ ferret: 'f1' as FerretId })).map(a => a.id)).toEqual([mine]);
      await asks.close(mine, 'withdrawn');
      expect((await asks.open({ ferret: 'f1' as FerretId })).length).toBe(0);
    });
    test('a draft that breaks the envelope is refused', async () => {
      const { asks } = await make();
      await expect(asks.raise({ ...draft('e9'), kind: 'choice' })).rejects.toThrow();
    });
  });
}

/** What a source plugin registers under `ask.sources`: its ref schema is strict and accepts its own refs. */
export function askSourceConformance(
  name: string,
  spec: AskSourceSpec,
  samples: { readonly valid: readonly unknown[]; readonly invalid: readonly unknown[] },
): void {
  describe(`ask source conformance: ${name}`, () => {
    test('its own refs parse', () => {
      for (const ref of samples.valid) expect(spec.schema.safeParse(ref).success).toBe(true);
    });
    test('a ref with an unknown field or the wrong shape is refused (strict)', () => {
      for (const ref of samples.valid)
        if (typeof ref === 'object' && ref !== null) expect(spec.schema.safeParse({ ...ref, extra: 1 }).success).toBe(false);
      for (const ref of samples.invalid) expect(spec.schema.safeParse(ref).success).toBe(false);
    });
    test('its title template names only fields of the ref', () => {
      const fields = [...spec.title.matchAll(/\{([A-Za-z]+)\}/gu)].map(match => match[1]);
      const first = samples.valid[0];
      if (typeof first === 'object' && first !== null) for (const field of fields) expect(field !== undefined && field in first).toBe(true);
    });
  });
}
