import { createHash } from 'node:crypto';
import {
  type AnswerEffect,
  type AnswerId,
  type AskAnswer,
  type AskDraft,
  AskDraftSchema,
  type AskFilter,
  type AskId,
  type AskKind,
  AskOwnerActionSchema,
  AskOwnerActionError,
  type AskRef,
  type AskSourceSpec,
  type AsksApi,
  type AskSummary,
  BUILT_IN_SOURCES,
  type CloseReason,
  type EntryId,
  type SourceKey,
} from '../../contract/index.ts';
import type { AgendaActor, AgendaService, RaiseAgendaRequest } from '../lib/agenda/index.ts';
import { SerialQueue } from '../lib/agenda/serial-queue.ts';
import { cardAskReference } from '../lib/protocol/agenda-card-asks.ts';
import { askForKind } from '../lib/protocol/agenda-card.ts';
import {
  MACHINE_AGENDA_ID,
  type AgendaItem,
  type AgendaResponse,
  type AgendaSnapshot,
  type ResolvedAgendaItem,
} from '../lib/protocol/agenda.ts';

/**
 * The Asks port (§7.4) over the engine (lead decision #13): every ask lives on ONE ferret's board, with today's `A<n>`
 * id there, so every call names an {@link AskRef}. The obligation `(source, entry)` rides the item's `sourceRef` as
 * `ask:<source>:<entry>`, which is what makes a raise idempotent and lets `answers` find a source's answers again.
 *
 * Answering is not here: the owner answers through Asks' own route, never through the port.
 */

const OBLIGATION_PREFIX = 'ask:';
const obligationOf = (source: string, entry: string): string => `${OBLIGATION_PREFIX}${source}:${entry}`;

/** The obligation an item carries, or `undefined` for an item raised outside the port (a ferret's own `fy agenda add`). */
export function parseObligation(sourceRef: string | null): { source: SourceKey; entry: EntryId } | undefined {
  if (sourceRef === null || !sourceRef.startsWith(OBLIGATION_PREFIX)) return undefined;
  const rest = sourceRef.slice(OBLIGATION_PREFIX.length);
  const at = rest.indexOf(':');
  if (at <= 0) return undefined;
  return { source: rest.slice(0, at) as SourceKey, entry: rest.slice(at + 1) as EntryId };
}

/**
 * A standing notice rides `standing:<source>:<entry>`. Unlike `ask:`, the engine does not remember it for life
 * (`raisedObligations` holds `ask:` refs only): an open one is refreshed in place, a closed one is raised afresh.
 */
const STANDING_PREFIX = 'standing:';
const standingOf = (source: string, entry: string): string => `${STANDING_PREFIX}${source}:${entry}`;

/** The source and entry a standing notice carries, or `undefined` for any other item. */
function parseStanding(sourceRef: string | null): { source: SourceKey; entry: EntryId } | undefined {
  if (sourceRef === null || !sourceRef.startsWith(STANDING_PREFIX)) return undefined;
  const rest = sourceRef.slice(STANDING_PREFIX.length);
  const at = rest.indexOf(':');
  if (at <= 0) return undefined;
  return { source: rest.slice(0, at) as SourceKey, entry: rest.slice(at + 1) as EntryId };
}

/** Thrown when a raise names a source no plugin registers under `ask.sources` (and Asks does not own). */
class UnknownAskSourceError extends Error {
  override readonly name = 'UnknownAskSourceError';
  constructor(source: string) {
    super(`no plugin registers the ask source "${source}" (it may be turned off), so nothing was raised`);
  }
}

/** Thrown when the engine refused a raise or a close: its own sentence. */
class AskRefusedError extends Error {
  override readonly name = 'AskRefusedError';
}

/** The board a draft is raised on: the ferret it is about, else the ferret raising it. */
function boardOf(draft: Pick<AskDraft, 'ferret' | 'raisedBy'>): string {
  const ferret = draft.ferret ?? (draft.raisedBy.kind === 'ferret' ? draft.raisedBy.ferret : undefined);
  if (ferret === undefined) throw new AskRefusedError("an ask lives on a ferret's board, and this one names no ferret");
  return ferret;
}

/**
 * A port raise is a plugin's, on the daemon's side of the boundary: the engine takes a stable source reference only from
 * the daemon, so every port raise is the daemon's. Who it is for is the draft's `ferret`.
 */
const PORT_ACTOR: AgendaActor = { kind: 'daemon', cause: 'system' };

const kindOf = (item: Pick<AgendaItem, 'kind'>): AskKind =>
  item.kind === undefined ? 'task' : item.kind === 'info' ? 'notice' : item.kind;

const raiserOf = (item: AgendaItem | ResolvedAgendaItem): AskSummary['raisedBy'] =>
  item.raisedBy === 'agent' && item.raisedBySession !== null
    ? { kind: 'ferret', ferret: item.raisedBySession }
    : item.raisedBy === 'human'
      ? { kind: 'owner' }
      : { kind: 'daemon' };

/** What an answer did, read off the owner's response (today's answer kinds, in the contract's words). */
function effectOf(response: AgendaResponse | undefined, disposition: string): AnswerEffect {
  if (response === undefined) return disposition === 'dismissed' ? 'dismiss' : 'done';
  switch (response.kind) {
    case 'permission':
      return response.decision;
    case 'multiple-choice':
      return 'choose';
    case 'answer-review':
      return response.verdict === 'good' ? 'good' : 'clarify';
    case 'open-question':
    case 'other':
    case 'form':
      return 'clarify';
  }
}

/** An answer's own id, stable across reads: the digest of where it was recorded and when. */
const answerIdOf = (ferret: string, item: ResolvedAgendaItem): AnswerId =>
  `an_${(item.answerReceipt ?? createHash('sha256').update(`${ferret}~${item.id}~${item.resolvedAt}`).digest('hex')).slice(0, 24)}` as AnswerId;

export function answerOf(ferret: string, item: ResolvedAgendaItem): AskAnswer | undefined {
  const obligation = parseObligation(item.sourceRef);
  if (obligation === undefined || item.resolvedBy !== 'human') return undefined;
  const response = item.response;
  const text =
    response?.kind === 'open-question' || response?.kind === 'other'
      ? response.answer
      : response?.kind === 'answer-review' && response.verdict === 'clarify'
        ? response.clarification
        : (item.resolutionNote ?? undefined);
  return {
    id: answerIdOf(ferret, item),
    ferret,
    ask: item.id as AskId,
    source: obligation.source,
    entry: obligation.entry,
    effect: effectOf(response, item.disposition),
    ...(response?.kind === 'multiple-choice' ? { choice: response.choice } : {}),
    ...(text === undefined || text.trim() === '' ? {} : { text: text.slice(0, 2_048) }),
    ...(response?.kind === 'form'
      ? {
          values: Object.fromEntries(
            response.answers.map(field => [
              field.id,
              Array.isArray(field.picked) ? field.picked.join(', ') : field.picked,
            ]),
          ),
        }
      : {}),
    // The engine records the owner, not which of their devices; the route that answered knew.
    by: { kind: 'host' },
    at: item.resolvedAt as AskAnswer['at'],
  };
}

/** Durable answers on a thread, including the owner's answer while it rests and answered card questions. */
export function answersOn(ferret: string, item: AgendaItem | ResolvedAgendaItem): AskAnswer[] {
  const out: AskAnswer[] = [];
  if ('resolvedAt' in item) {
    const answer = answerOf(ferret, item);
    if (answer !== undefined) out.push(answer);
  } else if (item.ownerAnswer !== undefined) {
    const answer = item.ownerAnswer;
    const receipt = createHash('sha256')
      .update(JSON.stringify([ferret, item.id, answer.at, answer.request]))
      .digest('hex');
    const found = answerOf(ferret, {
      ...item,
      sourceRef: item.sourceRef ?? `ask:ferret:${item.id}`,
      resolvedAt: answer.at,
      resolvedBy: 'human',
      resolvedBySession: null,
      resolvedByName: null,
      disposition: 'done',
      response: answer.response,
      resolutionNote: answer.note ?? null,
      answerReceipt: receipt,
    });
    if (found !== undefined) out.push(found);
  }
  for (const ask of item.cardAsks ?? []) {
    if (ask.answer === undefined) continue;
    const found = answerOf(ferret, {
      ...item,
      sourceRef: `ask:card:${cardAskReference(ask)}`,
      resolvedAt: ask.answer.at,
      resolvedBy: 'human',
      resolvedBySession: null,
      resolvedByName: null,
      disposition: 'done',
      response: ask.answer.response,
      resolutionNote: ask.answer.note ?? null,
      answerReceipt: ask.answer.receipt,
    });
    if (found !== undefined) out.push(found);
  }
  return out;
}

function summaryOf(
  ferret: string,
  item: AgendaItem | ResolvedAgendaItem,
  state: AskSummary['state'],
  sources: (key: SourceKey) => AskSourceSpec | 'unavailable',
): AskSummary {
  const obligation = parseObligation(item.sourceRef) ?? parseStanding(item.sourceRef);
  const source = obligation?.source ?? ('ferret' as SourceKey);
  const unavailable = !(BUILT_IN_SOURCES as readonly string[]).includes(source) && sources(source) === 'unavailable';
  return {
    id: item.id as AskId,
    source,
    entry: obligation?.entry ?? (item.id as unknown as EntryId),
    kind: kindOf(item),
    subject: item.subject,
    raisedBy: raiserOf(item),
    ferret,
    state,
    raisedAt: item.waitingSince as AskSummary['raisedAt'],
    ...(item.ping === true || item.blockingNow === true ? { blocking: true } : {}),
    ...(unavailable ? { sourceUnavailable: true as const } : {}),
  };
}

/** Which ferrets have a board; the engine's own list (`ferrets/*`). */
export interface AskBoards {
  ferrets(): Promise<readonly string[]>;
}

/**
 * The port. A raise names a source that exists — one of Asks' own (`ferret`, `daemon`) or one a plugin registers under
 * `ask.sources` — and its `ref` parses with that source's own schema before anything is written.
 */
export function asksPort(
  agenda: Pick<
    AgendaService,
    'list' | 'raise' | 'resolve' | 'dismiss' | 'snooze' | 'unsnooze' | 'raisedObligation' | 'raisedObligations'
  >,
  boards: AskBoards,
  sources: (key: SourceKey) => AskSourceSpec | 'unavailable',
  tell?: NonNullable<AsksApi['tell']>,
): AsksApi {
  const raises = new SerialQueue();
  const checkSource = (draft: { readonly source: string; readonly ref: unknown }): void => {
    if ((BUILT_IN_SOURCES as readonly string[]).includes(draft.source)) return;
    const spec = sources(draft.source as SourceKey);
    if (spec === 'unavailable') throw new UnknownAskSourceError(draft.source);
    spec.schema.parse(draft.ref);
  };
  const snapshot = async (ferret: string): Promise<AgendaSnapshot | undefined> => {
    const listed = await agenda.list(ferret);
    return listed.ok ? listed.value : undefined;
  };
  // The obligations this port holds, (source, entry) -> board. Built from one pass over the boards the first time a
  // raise needs it, then kept current by this port's own raises (every raise goes through it), so a raise costs one
  // lookup and one read of the target board, never a read of every board.
  const held = new Map<string, AskRef>();
  let indexed: Promise<void> | undefined;
  const heldOn = async (ferret: string, sourceRef: string): Promise<AskRef | undefined> => {
    const known = held.get(sourceRef);
    if (known !== undefined) return known;
    const direct = await agenda.raisedObligation(ferret, sourceRef);
    if (direct !== undefined) return { ferret, id: direct as AskId };
    indexed ??= (async () => {
      for (const board of await boards.ferrets()) {
        const ledger = await agenda.raisedObligations(board);
        for (const [ref, id] of Object.entries(ledger))
          if (!held.has(ref)) held.set(ref, { ferret: board, id: id as AskId });
      }
    })().catch(error => {
      indexed = undefined;
      throw error;
    });
    await indexed;
    return held.get(sourceRef);
  };
  const raise = async (draft: AskDraft, notice: boolean): Promise<AskRef> => {
    const parsed = AskDraftSchema.parse(draft);
    const ferret = boardOf(parsed);
    const sourceRef = obligationOf(parsed.source, parsed.entry);
    // (source, entry) identifies an obligation for life, even when retried on another board or with its source off.
    const known = await heldOn(ferret, sourceRef);
    if (known !== undefined) return known;
    checkSource(parsed);
    const kind = parsed.kind === 'notice' ? 'info' : parsed.kind;
    const ask = askForKind(kind, parsed.options ?? []);
    const request: RaiseAgendaRequest = {
      source: 'question',
      sourceRef,
      subject: parsed.subject,
      why: parsed.why,
      howToResolve: parsed.howToResolve ?? parsed.why,
      kind,
      ...(parsed.context === undefined ? {} : { context: parsed.context }),
      ...(ask === undefined ? {} : { ask }),
      ...(notice ? { notice: true as const } : {}),
      ...(notice && parsed.blocking === true ? { ping: true as const } : {}),
      ...(!notice && parsed.blocking === true ? { blockingNow: true as const } : {}),
    };
    const mutation = await agenda.raise(ferret, request, PORT_ACTOR);
    if (!mutation.ok) throw new AskRefusedError(mutation.error.message);
    // The mutation says where the ask landed: a daemon raise about a sub-ferret goes to its lineage's home, not to `ferret`.
    const landed = mutation.snapshot.sessionId;
    const id = mutation.item?.id ?? (await agenda.raisedObligation(landed, sourceRef));
    if (id === undefined) throw new AskRefusedError('the board took the ask but named no item for it');
    const ref = { ferret: landed, id: id as AskId };
    held.set(sourceRef, ref);
    return ref;
  };
  const everyBoard = async <T>(
    read: (ferret: string, board: AgendaSnapshot) => readonly T[],
    only?: string,
  ): Promise<T[]> => {
    const out: T[] = [];
    const listed = await boards.ferrets();
    // One name is read only when the engine lists it: a file system that folds case would open `alice` for `Alice`.
    for (const ferret of only === undefined ? listed : listed.filter(name => name === only)) {
      const board = await snapshot(ferret).catch(() => undefined);
      if (board !== undefined) out.push(...read(ferret, board));
    }
    return out;
  };
  return {
    snapshots: async (filter = {}) => {
      if (filter.ferret !== undefined) {
        const listed = await agenda.list(filter.ferret);
        if (!listed.ok) throw new AskOwnerActionError(listed.error.code, listed.error.message);
        return [listed.value];
      }
      return await everyBoard((_ferret, board) => [board]);
    },
    ownerAction: async input => {
      const action = AskOwnerActionSchema.parse(input);
      const { ferret, id } = action.ref;
      // Today's owner action mount acts only on the machine ledger; ferret answers stay on Asks' own route.
      if (ferret !== MACHINE_AGENDA_ID)
        throw new AskOwnerActionError('forbidden', 'these owner actions belong to the machine agenda');
      const actor: AgendaActor = { kind: 'human' };
      const mutation = await (action.action === 'dismiss'
        ? agenda.dismiss(ferret, id, actor, action.note)
        : action.action === 'snooze'
          ? agenda.snooze(ferret, id, action.until, actor)
          : action.action === 'unsnooze'
            ? agenda.unsnooze(ferret, id, actor)
            : agenda.resolve(ferret, id, actor, action.note));
      if (!mutation.ok) throw new AskOwnerActionError(mutation.error.code, mutation.error.message);
      return mutation.snapshot;
    },
    ...(tell === undefined ? {} : { tell }),
    raise: async draft => await raises.run(() => raise(draft, false)),
    notify: async notice => await raises.run(() => raise({ ...notice, kind: 'notice' }, true)),
    standing: async notice =>
      await raises.run(async () => {
        const parsed = AskDraftSchema.parse({ ...notice, kind: 'notice' });
        const ferret = boardOf(parsed);
        checkSource(parsed);
        const sourceRef = standingOf(parsed.source, parsed.entry);
        // The engine refreshes the open item with this ref in place, writes nothing when the wording is the same,
        // and (the ref is not an `ask:` obligation) raises afresh when none is open.
        const mutation = await agenda.raise(
          ferret,
          {
            source: 'question',
            sourceRef,
            subject: parsed.subject,
            why: parsed.why,
            howToResolve: parsed.howToResolve ?? parsed.why,
            kind: 'info',
            ...(parsed.context === undefined ? {} : { context: parsed.context }),
            notice: true as const,
            ...(parsed.blocking === true ? { ping: true as const } : {}),
          },
          PORT_ACTOR,
        );
        if (!mutation.ok) throw new AskRefusedError(mutation.error.message);
        const id = mutation.item?.id ?? (await snapshot(ferret))?.items.find(item => item.sourceRef === sourceRef)?.id;
        if (id === undefined) throw new AskRefusedError('the board took the notice but named no item for it');
        return { ferret, id: id as AskId };
      }),
    answers: async (filter, since) =>
      (
        await everyBoard((ferret, board) =>
          [...board.items, ...board.resolved].flatMap(item => answersOn(ferret, item)),
        )
      ).filter(
        answer =>
          answer.source === filter.source &&
          (filter.entry === undefined || answer.entry === filter.entry) &&
          (since === undefined || answer.at > since),
      ),
    close: async (ref: AskRef, reason: CloseReason) => {
      const daemon: AgendaActor = { kind: 'daemon', cause: 'system' };
      const note = `closed: ${reason}`;
      const mutation =
        reason === 'answered'
          ? await agenda.resolve(ref.ferret, ref.id, daemon, note)
          : await agenda.dismiss(ref.ferret, ref.id, daemon, note);
      if (!mutation.ok && mutation.error.code !== 'not-found') throw new AskRefusedError(mutation.error.message);
    },
    open: async (filter: AskFilter) => {
      const state = filter.state ?? 'open';
      const listed = await everyBoard(
        (ferret, board) =>
          state === 'open'
            ? board.items.map(item => summaryOf(ferret, item, 'open', sources))
            : board.resolved.map(item =>
                summaryOf(
                  ferret,
                  item,
                  item.resolvedBy === 'human' && item.response !== undefined ? 'answered' : 'closed',
                  sources,
                ),
              ),
        filter.ferret,
      );
      return listed.filter(
        ask =>
          ask.state === state &&
          (filter.source === undefined || ask.source === filter.source) &&
          (filter.entry === undefined || ask.entry === filter.entry),
      );
    },
    get: async (ref: AskRef) => {
      const board = await snapshot(ref.ferret);
      if (board === undefined) return undefined;
      const open = board.items.find(item => item.id === ref.id);
      if (open !== undefined) return summaryOf(ref.ferret, open, 'open', sources);
      const resolved = board.resolved.find(item => item.id === ref.id);
      if (resolved === undefined) return undefined;
      return summaryOf(
        ref.ferret,
        resolved,
        resolved.resolvedBy === 'human' && resolved.response !== undefined ? 'answered' : 'closed',
        sources,
      );
    },
  };
}
