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
  type AskRef,
  type AskSourceSpec,
  type AskSummary,
  type AsksApi,
  AskItemSchema,
  type AskBoardSnapshot,
  type AskOwnerAction,
  AskOwnerActionError,
  type CloseReason,
  type EntryId,
  type SourceKey,
} from '../index.ts';

const AT = '2026-11-07T12:00:00.000Z';
export const sourceKey = (key: string): SourceKey => key as SourceKey;
export const entryId = (id: string): EntryId => id as EntryId;

/** Where an ask lives: its ferret's board, then its id there. */
const keyOf = (ask: AskRef): string => `${ask.ferret}~${ask.id}`;

/** The board a draft is raised on: the ferret it is about, else the ferret raising it. */
export function boardOf(draft: Pick<AskDraft, 'ferret' | 'raisedBy'>): string {
  const ferret = draft.ferret ?? (draft.raisedBy.kind === 'ferret' ? draft.raisedBy.ferret : undefined);
  if (ferret === undefined) throw new Error("an ask lives on a ferret's board: the draft names no ferret");
  return ferret;
}

/** An in-memory Asks port. `answer` is TEST ONLY: the real port has no answer method (owner-only, by route). */
export class FakeAsks implements AsksApi {
  readonly #asks = new Map<string, AskSummary & { readonly ferret: string }>();
  readonly #answers: AskAnswer[] = [];
  readonly #next = new Map<string, number>();
  #nextAnswer = 0;
  readonly #drafts = new Map<string, AskDraft>();
  readonly #standing = new Set<string>();
  #writes = 0;
  readonly #parked = new Map<string, string>();
  readonly #notes = new Map<string, string | undefined>();

  async snapshots(filter: { readonly ferret?: string } = {}): Promise<readonly AskBoardSnapshot[]> {
    const boards = filter.ferret === undefined ? [...this.#next.keys()] : [filter.ferret];
    return boards.map(ferret => {
      const rows = [...this.#asks.values()].filter(ask => ask.ferret === ferret);
      const item = (ask: AskSummary) => {
        const key = keyOf({ ferret, id: ask.id });
        const draft = this.#drafts.get(key);
        return AskItemSchema.parse({
          id: ask.id,
          subject: ask.subject,
          kind: ask.kind === 'notice' ? 'info' : ask.kind,
          source: 'question',
          sourceRef: `ask:${ask.source}:${ask.entry}`,
          why: draft?.why ?? 'because',
          howToResolve: draft?.howToResolve ?? draft?.why ?? 'Read it.',
          waitingSince: ask.raisedAt,
          raisedBy: ask.raisedBy.kind === 'owner' ? 'human' : ask.raisedBy.kind === 'ferret' ? 'agent' : 'daemon',
          raisedBySession: ask.raisedBy.kind === 'ferret' ? ferret : null,
          raisedByName: null,
          ...(this.#parked.has(key) ? { parked: { reason: 'snoozed', at: AT, until: this.#parked.get(key) } } : {}),
        });
      };
      const items = rows.filter(row => row.state === 'open').map(item);
      return {
        v: 1 as const,
        sessionId: ferret,
        items,
        count: items.length,
        parseErrors: 0,
        updatedAt: AT,
        resolved: rows
          .filter(row => row.state !== 'open')
          .map(row => ({
            ...item(row),
            resolvedAt: AT,
            resolvedBy: 'human' as const,
            resolvedBySession: null,
            resolvedByName: null,
            resolutionNote: this.#notes.get(keyOf({ ferret, id: row.id })) ?? null,
            disposition: row.state === 'answered' ? ('done' as const) : ('dismissed' as const),
          })),
      };
    });
  }

  async ownerAction(action: AskOwnerAction): Promise<AskBoardSnapshot> {
    if (action.ref.ferret !== 'machine-agenda')
      throw new AskOwnerActionError('forbidden', 'these owner actions belong to the machine agenda');
    const key = keyOf(action.ref);
    const ask = this.#asks.get(key);
    if (ask === undefined || ask.state !== 'open') throw new AskOwnerActionError('not-found', 'agenda item not found');
    if (action.action === 'snooze') {
      if (ask.kind === 'notice') throw new AskOwnerActionError('invalid', 'a notice is read, not snoozed');
      if (action.until <= AT) throw new AskOwnerActionError('invalid', 'snooze until must be in the future');
      this.#parked.set(key, action.until);
    } else if (action.action === 'unsnooze') this.#parked.delete(key);
    else {
      this.#parked.delete(key);
      this.#notes.set(key, action.note);
      this.#asks.set(key, { ...ask, state: action.action === 'dismiss' ? 'closed' : 'answered' });
    }
    return (await this.snapshots({ ferret: action.ref.ferret }))[0]!;
  }

  async ownerDismiss(ref: AskRef, note?: string): Promise<void> {
    const key = keyOf(ref);
    const ask = this.#asks.get(key);
    if (ask === undefined || ask.state !== 'open') return;
    this.#notes.set(key, note);
    this.#asks.set(key, { ...ask, state: 'closed' });
  }

  async raise(ask: AskDraft): Promise<AskRef> {
    const draft = AskDraftSchema.parse(ask);
    for (const existing of this.#asks.values())
      if (
        existing.source === draft.source &&
        existing.entry === draft.entry &&
        !this.#standing.has(keyOf({ ferret: existing.ferret, id: existing.id }))
      )
        return { ferret: existing.ferret, id: existing.id };
    return await this.#raiseNew(draft);
  }
  async #raiseNew(draft: ReturnType<typeof AskDraftSchema.parse>): Promise<AskRef> {
    const ferret = boardOf(draft);
    const next = (this.#next.get(ferret) ?? 0) + 1;
    this.#next.set(ferret, next);
    this.#writes += 1;
    const id = `A${next}` as AskId;
    this.#drafts.set(keyOf({ ferret, id }), draft);
    this.#asks.set(keyOf({ ferret, id }), {
      id,
      source: draft.source,
      entry: draft.entry,
      kind: draft.kind,
      subject: draft.subject,
      raisedBy: draft.raisedBy,
      ferret,
      state: 'open',
      raisedAt: AT as AskSummary['raisedAt'],
    });
    return { ferret, id };
  }
  /** Every distinct tell, as the real port types it once per send id. */
  readonly told: { readonly ferret: string; readonly text: string; readonly sendId: string }[] = [];
  async tell(ferret: string, text: string, sendId: string): Promise<'queued' | 'known'> {
    if (this.told.some(each => each.ferret === ferret && each.sendId === sendId)) return 'known';
    this.told.push({ ferret, text, sendId });
    return 'queued';
  }
  async notify(notice: Omit<AskDraft, 'kind' | 'options'>): Promise<AskRef> {
    return await this.raise({ ...notice, kind: 'notice' });
  }
  /** A standing notice: an open one with the key is restated in place, none open raises a new ask. */
  async standing(notice: Omit<AskDraft, 'kind' | 'options'>): Promise<AskRef> {
    const draft = AskDraftSchema.parse({ ...notice, kind: 'notice' });
    const open = [...this.#asks.values()].find(
      ask =>
        ask.state === 'open' &&
        ask.kind === 'notice' &&
        ask.source === draft.source &&
        ask.entry === draft.entry &&
        this.#standing.has(keyOf({ ferret: ask.ferret, id: ask.id })),
    );
    if (open === undefined) {
      const ref = await this.#raiseNew(draft);
      this.#standing.add(keyOf(ref));
      return ref;
    }
    const ref = { ferret: open.ferret, id: open.id };
    if (JSON.stringify(this.#drafts.get(keyOf(ref))) === JSON.stringify(draft)) return ref;
    this.#writes += 1;
    this.#drafts.set(keyOf(ref), draft);
    this.#asks.set(keyOf(ref), { ...open, subject: draft.subject });
    return ref;
  }
  /** How many times the board changed (an ask raised, restated or closed): what "no write when unchanged" counts. */
  get boardWrites(): number {
    return this.#writes;
  }
  /** TEST ONLY: the owner answers. */
  answerAs(
    ref: AskRef,
    effect: AnswerEffect,
    by: Answerer = { kind: 'host' },
    extra: Partial<AskAnswer> = {},
  ): AnswerId {
    const ask = this.#asks.get(keyOf(ref));
    if (ask === undefined) throw new Error(`no ask ${ref.ferret} ${ref.id}`);
    this.#nextAnswer += 1;
    const answerId = `an_${this.#nextAnswer.toString(16).padStart(24, '0')}` as AnswerId;
    this.#answers.push({
      id: answerId,
      ferret: ask.ferret,
      ask: ask.id,
      source: ask.source,
      entry: ask.entry,
      effect,
      by,
      at: AT as AskAnswer['at'],
      ...extra,
    });
    this.#asks.set(keyOf(ref), { ...ask, state: 'answered' });
    return answerId;
  }
  async answers(filter: { readonly source: SourceKey; readonly entry?: EntryId }, since?: string) {
    return this.#answers.filter(
      a =>
        a.source === filter.source &&
        (filter.entry === undefined || a.entry === filter.entry) &&
        (since === undefined || a.at > since),
    );
  }
  async close(ref: AskRef, _reason: CloseReason): Promise<void> {
    const ask = this.#asks.get(keyOf(ref));
    if (ask === undefined || ask.state === 'closed') return;
    this.#writes += 1;
    this.#asks.set(keyOf(ref), { ...ask, state: 'closed' });
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
  async get(ref: AskRef) {
    return this.#asks.get(keyOf(ref));
  }
}

export interface AsksSubject {
  readonly asks: AsksApi;
  /** The owner answers (through the route in the real port). */
  answer(ask: AskRef, effect: AnswerEffect): Promise<AnswerId> | AnswerId;
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
      expect(await asks.raise(draft('e1'))).toEqual(first);
      expect(await asks.raise(draft('e2'))).not.toEqual(first);
    });
    test('ids are numbered per ferret: the same A1 on two boards are two asks', async () => {
      const subject = await make();
      const mine = await subject.asks.raise(draft('e1', 'f1'));
      const theirs = await subject.asks.raise(draft('e2', 'f2'));
      expect(mine.id).toBe(theirs.id);
      await subject.asks.close(mine, 'withdrawn');
      expect((await subject.asks.get(theirs))?.state).toBe('open');
    });
    test('answers come back by source and entry, each with its own id', async () => {
      const subject = await make();
      const one = await subject.asks.raise(draft('e1'));
      const two = await subject.asks.raise(draft('e2'));
      const a1 = await subject.answer(one, 'approve');
      await subject.answer(two, 'reject');
      const answers = await subject.asks.answers({ source: sourceKey('ferret'), entry: entryId('e1') });
      expect(answers.map(a => a.id)).toEqual([a1]);
      expect(answers[0]?.ask).toBe(one.id);
      expect(answers[0]?.ferret).toBe(one.ferret);
    });
    test('open lists by ferret; a closed ask leaves the open list', async () => {
      const { asks } = await make();
      const mine = await asks.raise(draft('e1', 'f1'));
      await asks.raise(draft('e2', 'f2'));
      expect((await asks.open({ ferret: 'f1' as FerretId })).map(a => a.id)).toEqual([mine.id]);
      await asks.close(mine, 'withdrawn');
      expect((await asks.open({ ferret: 'f1' as FerretId })).length).toBe(0);
    });
    test('a draft that breaks the envelope is refused', async () => {
      const { asks } = await make();
      await expect(asks.raise({ ...draft('e9'), kind: 'choice' })).rejects.toThrow();
    });
  });
}

const standingDraft = (
  subject: string,
  context?: string,
  ferret = 'machine-agenda',
): Omit<AskDraft, 'kind' | 'options'> => ({
  source: sourceKey('daemon'),
  ref: {},
  entry: entryId('warden.orphans'),
  subject,
  why: 'Nobody is on these cards.',
  ...(context === undefined ? {} : { context }),
  raisedBy: { kind: 'daemon' },
  ferret,
});

/** What the standing suite runs on: the port, and how many times its board was written (an ask raised, restated, closed). */
export interface StandingSubject {
  readonly asks: AsksApi;
  boardWrites(): number;
}

/**
 * The standing-notice suite: the SAME cases run on the in-memory fake and on the real port over the engine, so the
 * two cannot disagree on what "keep one notice current" means.
 */
export function standingConformance(name: string, make: () => StandingSubject | Promise<StandingSubject>): void {
  const openSubjects = async (asks: AsksApi): Promise<string[]> =>
    (await asks.snapshots({ ferret: 'machine-agenda' }))[0]?.items.map(item => item.subject) ?? [];
  describe(`standing notice conformance: ${name}`, () => {
    test('the first call raises one open notice', async () => {
      const { asks } = await make();
      const ref = await asks.standing(standingDraft('2 cards have no ferret'));
      expect(ref.ferret).toBe('machine-agenda');
      expect(await openSubjects(asks)).toEqual(['2 cards have no ferret']);
    });
    test('a changed wording rewrites the open notice in place: same ref, still one', async () => {
      const { asks } = await make();
      const first = await asks.standing(standingDraft('2 cards have no ferret'));
      const second = await asks.standing(standingDraft('3 cards have no ferret'));
      expect(second).toEqual(first);
      expect(await openSubjects(asks)).toEqual(['3 cards have no ferret']);
    });
    test('a rewrite in place keeps the id, whatever part of the wording changed and however often', async () => {
      const { asks } = await make();
      const first = await asks.standing(standingDraft('2 cards have no ferret', 'F1\nF2'));
      const refs = [
        await asks.standing(standingDraft('2 cards have no ferret', 'F1\nF3')),
        await asks.standing(standingDraft('3 cards have no ferret', 'F1\nF3\nF4')),
        await asks.standing(standingDraft('1 card has no ferret', 'F1')),
      ];
      expect(refs).toEqual([first, first, first]);
      expect((await asks.open({ source: sourceKey('daemon'), entry: entryId('warden.orphans') })).length).toBe(1);
      expect(await openSubjects(asks)).toEqual(['1 card has no ferret']);
    });
    test('the same wording is the same notice: same ref, still one', async () => {
      const { asks } = await make();
      const first = await asks.standing(standingDraft('2 cards have no ferret'));
      expect(await asks.standing(standingDraft('2 cards have no ferret'))).toEqual(first);
      expect(await openSubjects(asks)).toEqual(['2 cards have no ferret']);
    });
    test('the same wording writes nothing to the board, however many times it is said', async () => {
      const { asks, boardWrites } = await make();
      await asks.standing(standingDraft('2 cards have no ferret', 'F1\nF2'));
      const written = boardWrites();
      expect(written).toBeGreaterThan(0);
      for (let again = 0; again < 20; again += 1)
        await asks.standing(standingDraft('2 cards have no ferret', 'F1\nF2'));
      expect(boardWrites()).toBe(written);
      await asks.standing(standingDraft('2 cards have no ferret', 'F1\nF3'));
      expect(boardWrites()).toBe(written + 1);
    });
    test('a burst of 50 notices with changing bodies stays ONE item, holding the last body', async () => {
      const { asks } = await make();
      const first = await asks.standing(standingDraft('1 card has no ferret', 'body 1'));
      for (let notice = 2; notice <= 50; notice += 1)
        expect(
          await asks.standing(standingDraft(`${String(notice)} cards have no ferret`, `body ${String(notice)}`)),
        ).toEqual(first);
      expect(await openSubjects(asks)).toEqual(['50 cards have no ferret']);
      expect((await asks.open({ source: sourceKey('daemon'), entry: entryId('warden.orphans') })).length).toBe(1);
    });
    test('open finds it by source and entry, and close clears it', async () => {
      const { asks } = await make();
      const ref = await asks.standing(standingDraft('2 cards have no ferret'));
      const found = await asks.open({ source: sourceKey('daemon'), entry: entryId('warden.orphans') });
      expect(found.map(ask => ask.id)).toEqual([ref.id]);
      await asks.close(ref, 'source-gone');
      expect(await openSubjects(asks)).toEqual([]);
    });
    test('after it was closed, the cause coming back raises a NEW ask under the same key', async () => {
      const { asks } = await make();
      const first = await asks.standing(standingDraft('2 cards have no ferret'));
      await asks.close(first, 'source-gone');
      const again = await asks.standing(standingDraft('1 card has no ferret'));
      expect(again.id).not.toBe(first.id);
      expect(await openSubjects(asks)).toEqual(['1 card has no ferret']);
    });
    test('orphans, then none (closed), then orphans again: every return is a NEW open item, never swallowed', async () => {
      const { asks } = await make();
      const seen: string[] = [];
      for (let round = 1; round <= 3; round += 1) {
        const ref = await asks.standing(standingDraft(`${String(round)} cards have no ferret`));
        expect(seen).not.toContain(ref.id);
        seen.push(ref.id);
        expect(await openSubjects(asks)).toEqual([`${String(round)} cards have no ferret`]);
        const standing = await asks.open({ source: sourceKey('daemon'), entry: entryId('warden.orphans') });
        expect(standing.map(ask => ask.id)).toEqual([ref.id]);
        await asks.close(ref, 'source-gone');
        expect(await openSubjects(asks)).toEqual([]);
        expect(await asks.open({ source: sourceKey('daemon'), entry: entryId('warden.orphans') })).toEqual([]);
      }
    });
    test('a draft that breaks the envelope is refused', async () => {
      const { asks } = await make();
      await expect(asks.standing({ ...standingDraft(''), subject: '' })).rejects.toThrow();
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
        if (typeof ref === 'object' && ref !== null)
          expect(spec.schema.safeParse({ ...ref, extra: 1 }).success).toBe(false);
      for (const ref of samples.invalid) expect(spec.schema.safeParse(ref).success).toBe(false);
    });
    test('its title template names only fields of the ref', () => {
      const fields = [...spec.title.matchAll(/\{([A-Za-z]+)\}/gu)].map(match => match[1]);
      const first = samples.valid[0];
      if (typeof first === 'object' && first !== null)
        for (const field of fields) expect(field !== undefined && field in first).toBe(true);
    });
  });
}
