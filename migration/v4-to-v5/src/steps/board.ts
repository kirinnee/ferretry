/**
 * Board: cards, counters, lane sets with the board switch, the sweep's memory and each ferret's focus. Every v4 file is
 * read with this tool's own parser (`../v4/board.ts`), mapped, and parsed by the STRICT v5 Board contract schema before
 * anything is written. All files are mapped first and written only after every one succeeded, so a failure writes
 * nothing.
 *
 * Cards (`state/board/tasks/<id>.json` → `state/board/cards/<id>.json`, `CardSchema`):
 *  - The id is kept exactly (`&F1792` still names the same card), as are machineId, projectId, laneId, kind, title,
 *    summary, the ask (its text AND its source), premise, context, terms, brief, howToTest, owner, assignee, parent,
 *    dependencies (with the owner's override), blocked, dropped, workflow, links with the PR cache, files, order,
 *    snoozed, askedBy, visibility, visibilitySource and every instant. v5 kept v4's field names for all of them.
 *  - Renamed: `v` → `format`, `status` → `progress` (also as a `field-edited` event's `field`), `approval {sessionId,
 *    id}` → `{ferret, id}` (the same ask `A<n>` on the same ferret's ledger: Asks keeps per-ferret ask ids).
 *  - Actors (`createdBy`, every history `actor`/`reportedBy`, every clarification `by`) take v5's strict shape (lead
 *    decision 2026-11-07): owner `{via?}`, ferret `{name, ferret}`, daemon `{}`. The `…Via` beside an actor folds into
 *    the owner's `via`. A ferret's name is its v4 callsign (`v5FerretName`: `teammate`, else a valid `name`, else id).
 *  - History: every v4 event type maps to the v5 type of the same name, except `migrated` (v5 dropped it), which becomes
 *    a `note` naming the legacy ref, so the record of where the card came from is kept. A type v4 does not have fails
 *    the step naming the card and the type. A field v4.291.5 does not declare on an event is left out (v4 itself
 *    strips it on read) and named in notCarried.
 *  - Dropped cards and cards in a closed lane are ordinary cards and are all kept.
 *
 * Counters (`state/board/counters.json`): v4 stores the LAST number handed out per letter (partial), and allocates
 * `max(counter, highest id on disk) + 1`. v5 stores the NEXT number per kind; the converter writes exactly what v4
 * would have allocated next, so numbering continues after the highest id and never reuses one.
 *
 * Boards (`<home>/board/lanes/<project>.json` + `<home>/board/switch.json` → `state/board/boards/<project>.json`): one
 * file per project that has a lane set or a switch entry. The lane set keeps every field, with `doneLane`/`notGoodLane`
 * derived exactly as v4 derived them on read when the file predates them; a gate option's `reopen-with-agenda` outcome
 * is v5's `reopen-with-ask`. The switch: an owner's choice stays the owner's; v4's one-time `migration` choice is v5's
 * `default`; a board with no entry is off, as in v4.
 *
 * Sweep (`state/board/sweep.json`): carried whole (`sweptAt`, `nudged`, `seen`). A damaged v4 sweep memory is, as in
 * v4, a fresh start.
 *
 * Focus (`state/sessions/<sid>/config.json` `focusTask`/`focusAnchor`/`boardSkip` → `state/board/focus.json`): v5's
 * Board holds the facts v4 kept in each session's config.
 *
 * Errors name a file, a card id or a v4 event type, never a value from the file.
 */
import {
  BoardFileSchema,
  BoardProjectIdSchema,
  CardEventSchema,
  CardSchema,
  CountersFileSchema,
  FocusFileSchema,
  SweepFileSchema,
  type Card,
  type FocusFile,
} from '@ferretry/plugin-board/contract';
import { FerretIdSchema } from '@ferretry/core-ferrets/contract';
import { join } from 'node:path';
import { z } from 'zod';
import type { KeptItem, NotCarried, StepReport } from '../report.ts';
import { directories } from '../v4/ferrets.ts';
import {
  BoardInputError,
  boardFiles,
  defaultLaneTargets,
  KNOWN_CARD_FIELDS,
  readDocument,
  unknownCardFields,
  V4Actor,
  V4BoardSkip,
  V4Card,
  type V4ActorValue,
  type V4CardValue,
  V4Counters,
  type V4CountersValue,
  V4_EVENT_TYPES,
  V4FerretBoardConfig,
  V4FocusRef,
  V4LaneSet,
  type V4LaneSetValue,
  V4LegacyRef,
  V4Sweep,
  V4Switch,
  type V4SwitchValue,
  v4BoardPaths,
} from '../v4/board.ts';
import { v5FerretName } from './ferrets.ts';
import type { Step, StepContext } from './index.ts';

const BOARD_NOT_CARRIED: readonly NotCarried[] = [
  { what: 'derived indexes (SQLite caches)', why: 'v5 rebuilds every cache from the kept files' },
  {
    what: 'card legacyRef',
    why: 'CardSchema has no legacyRef (dropped as compatibility); the card id is kept, and its `migrated` history event becomes a note naming the same legacy ref',
  },
  {
    what: 'the session an owner or the daemon acted from (createdBy, history and clarification actors)',
    why: 'CardActorSchema owner and daemon members have no ferret field',
  },
  {
    what: 'createdByVia, actorVia, reportedVia or byVia beside a ferret or daemon actor',
    why: 'CardActorSchema carries via only on the owner member (v4 wrote it only beside an owner)',
  },
  {
    what: 'board/switch.json migratedAt',
    why: 'BoardFileSchema has no migration marker; each board keeps its own on/off, setBy and setAt',
  },
  { what: 'state/board/github.json', why: 'no v4 source: v4 cached PR facts on each card’s links, which are kept' },
  { what: 'config/board.yaml', why: 'no v4 source: v4 had no board settings file; v5 uses its defaults' },
  {
    what: 'state/sessions/<sid>/tasks.json and board-import.json',
    why: 'retired v4 task lists and the one-time import marker; superseded by the cards',
  },
];

const V4_COUNTER_LETTERS = { bug: 'B', feature: 'F', infra: 'I', chore: 'C' } as const;
const MAX_COUNTER = 999_999_999;
const CARD_FILE = /^([BFIC][1-9][0-9]{0,8})\.json$/u;
/** A v4 event type safe to name in a report: v4's own types are all this shape. */
const TYPE_NAME = /^[a-z][a-z-]{0,31}$/u;

/** The fields each v5 history event type declares, read from v5's own (strict) union. */
const V5_EVENT_FIELDS: ReadonlyMap<string, ReadonlySet<string>> = new Map(
  CardEventSchema.options.map(option => [option.shape.type.value, new Set(Object.keys(option.shape))]),
);
const V5_CARD_FIELDS: ReadonlySet<string> = new Set(Object.keys(CardSchema.shape));
const CLARIFICATION_FIELDS = ['text', 'source', 'at', 'by'] as const;

interface Planned {
  readonly path: string;
  readonly write: (ctx: StepContext) => Promise<void>;
}

/** What the mapping learns while it runs, for the report. */
interface Facts {
  namedById: number;
  migratedNotes: number;
  readonly eventFields: Set<string>;
  readonly clarificationFields: Set<string>;
}

/** Each v4 ferret's name, read once from its session folder; `undefined` when it has no readable config. */
class FerretNames {
  private readonly cache = new Map<string, Promise<string | undefined>>();
  constructor(private readonly ctx: StepContext) {}

  async of(ferret: string): Promise<string | undefined> {
    let name = this.cache.get(ferret);
    if (name === undefined) {
      name = this.read(ferret);
      this.cache.set(ferret, name);
    }
    return await name;
  }

  private async read(ferret: string): Promise<string | undefined> {
    if (!FerretIdSchema.safeParse(ferret).success) return undefined;
    const label = `state/sessions/${ferret}/config.json`;
    const parsed = V4FerretBoardConfig.safeParse(
      await readDocument(join(this.ctx.v4.sessions, ferret, 'config.json'), label),
    );
    return parsed.success && parsed.data.id === ferret ? v5FerretName(parsed.data) : undefined;
  }
}

async function actorOf(
  names: FerretNames,
  actor: V4ActorValue,
  via: 'admin-token' | undefined,
  facts: Facts,
): Promise<unknown> {
  if (actor.kind === 'ferret') {
    const name = await names.of(actor.sessionId);
    if (name === undefined) facts.namedById++;
    return { kind: 'ferret', name: name ?? actor.sessionId, ferret: actor.sessionId };
  }
  if (actor.kind === 'owner') return via === undefined ? { kind: 'owner' } : { kind: 'owner', via };
  return { kind: 'daemon' };
}

/** v4's actor-and-via pairs inside a history event or a clarification: `<actor>` beside `<via>`. */
const ACTOR_FIELDS = [
  ['actor', 'actorVia'],
  ['reportedBy', 'reportedVia'],
  ['by', 'byVia'],
] as const;
const Via = z.literal('admin-token').optional();

/** One record with every v4 actor in v5's `CardActorSchema` shape and each `…Via` folded into the owner's `via`. */
async function withV5Actors(
  names: FerretNames,
  record: Record<string, unknown>,
  facts: Facts,
): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = { ...record };
  for (const [field, viaField] of ACTOR_FIELDS) {
    if (!(field in record)) {
      if (viaField in record) throw new BoardInputError(`a ${viaField} with no ${field}`);
      continue;
    }
    const actor = V4Actor.safeParse(record[field]);
    const via = Via.safeParse(record[viaField]);
    if (!actor.success || !via.success) throw new BoardInputError(`an unreadable ${field}`);
    out[field] = await actorOf(names, actor.data, via.data, facts);
    delete out[viaField];
  }
  return out;
}

/** Keeps only `fields`; any other name is recorded (names only) for notCarried. */
function only(record: Record<string, unknown>, fields: ReadonlySet<string>, dropped: Set<string>) {
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (fields.has(key)) kept[key] = value;
    else dropped.add(key);
  }
  return kept;
}

/** One v4 history event as the v5 event of the same type (`migrated` as a `note`). */
async function eventOf(
  names: FerretNames,
  id: string,
  event: Record<string, unknown>,
  facts: Facts,
): Promise<Record<string, unknown>> {
  const type = event['type'];
  if (typeof type !== 'string' || !V4_EVENT_TYPES.has(type)) {
    const named = typeof type === 'string' && TYPE_NAME.test(type) ? `'${type}'` : 'an unreadable type';
    throw new BoardInputError(`card ${id} has a history event of a type v4 does not have: ${named}`);
  }
  let mapped = await withV5Actors(names, event, facts);
  if (type === 'migrated') {
    const legacy = V4LegacyRef.safeParse(event['legacyRef']);
    if (!legacy.success) throw new BoardInputError(`card ${id} has a migrated event with no readable legacy ref`);
    const { legacyRef: _legacyRef, ...rest } = mapped;
    mapped = { ...rest, type: 'note', text: `migrated from the v4 task list as ${legacy.data}` };
    facts.migratedNotes++;
  }
  if (mapped['type'] === 'field-edited' && mapped['field'] === 'status') mapped = { ...mapped, field: 'progress' };
  const fields = V5_EVENT_FIELDS.get(mapped['type'] as string);
  if (fields === undefined) {
    throw new BoardInputError(`card ${id} has a history event v5 cannot hold: '${type}'`);
  }
  return only(mapped, fields, facts.eventFields);
}

async function mapCard(names: FerretNames, card: V4CardValue, facts: Facts): Promise<Card> {
  const {
    v: _v,
    status,
    dependsOn,
    createdBy,
    createdByVia,
    legacyRef: _legacyRef,
    approval,
    history,
    clarifications,
    ...rest
  } = card;
  // Unknown top-level fields are reported by name in notCarried; they never reach the strict v5 schema.
  const same = Object.fromEntries(
    Object.entries(rest).filter(([key]) => KNOWN_CARD_FIELDS.has(key) && V5_CARD_FIELDS.has(key)),
  );
  const events: Record<string, unknown>[] = [];
  for (const event of history) events.push(await eventOf(names, card.id, event, facts));
  const clarified: Record<string, unknown>[] = [];
  for (const item of clarifications) {
    const mapped = await withV5Actors(names, item, facts);
    clarified.push(only(mapped, new Set(CLARIFICATION_FIELDS), facts.clarificationFields));
  }
  return CardSchema.parse({
    ...same,
    format: 1,
    ...(status === undefined ? {} : { progress: status }),
    dependsOn: dependsOn.map(({ task, until, override }) => ({
      task,
      until,
      ...(override === undefined ? {} : { override }),
    })),
    createdBy: await actorOf(names, createdBy, createdByVia, facts),
    history: events,
    clarifications: clarified,
    ...(approval === undefined ? {} : { approval: { ferret: approval.sessionId, id: approval.id } }),
  });
}

/** v4's gate outcome `reopen-with-agenda` is v5's `reopen-with-ask`, in a lane's stage. */
function laneOf(lane: Record<string, unknown>): Record<string, unknown> {
  const stage = lane['stage'];
  if (typeof stage !== 'object' || stage === null || !('options' in stage) || !Array.isArray(stage.options))
    return lane;
  const options = (stage.options as unknown[]).map(option => {
    if (typeof option !== 'object' || option === null || !('outcome' in option)) return option;
    const outcome = option.outcome as { kind?: unknown } | null;
    return outcome?.kind === 'reopen-with-agenda' ? { ...option, outcome: { kind: 'reopen-with-ask' } } : option;
  });
  return { ...lane, stage: { ...stage, options } };
}

function laneSetOf(set: V4LaneSetValue, label: string): Record<string, unknown> {
  const derived = defaultLaneTargets(set.lanes);
  if ((set.doneLane === undefined || set.notGoodLane === undefined) && derived === undefined)
    throw new BoardInputError(`${label} has no lane Done or Not good can go to`);
  const pending = set.pending as (Record<string, unknown> & { lanes?: unknown }) | undefined;
  return {
    ...set,
    lanes: set.lanes.map(laneOf),
    doneLane: set.doneLane ?? derived?.doneLane,
    notGoodLane: set.notGoodLane ?? derived?.notGoodLane,
    ...(pending === undefined
      ? {}
      : {
          pending: Array.isArray(pending.lanes)
            ? { ...pending, lanes: (pending.lanes as unknown[]).map(lane => (isRecord(lane) ? laneOf(lane) : lane)) }
            : pending,
        }),
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function switchOf(project: string, document: V4SwitchValue | undefined) {
  const entry = document?.boards[project];
  if (entry === undefined) return { projectId: project, on: false, setBy: 'default' as const, setAt: null };
  return {
    projectId: project,
    on: entry.on,
    setBy: entry.setBy === 'owner' ? ('owner' as const) : ('default' as const),
    setAt: entry.setAt,
  };
}

/** Each v4 session's `focusTask`, `focusAnchor` and `boardSkip`, as v5's focus file holds them. */
async function focusOf(ctx: StepContext): Promise<{ file: FocusFile | undefined; unreadable: number }> {
  const ferrets: FocusFile['ferrets'] = {};
  let unreadable = 0;
  for (const ferret of await directories(ctx.v4.sessions).catch(() => {
    throw new BoardInputError('state/sessions is not a folder of session folders');
  })) {
    if (!FerretIdSchema.safeParse(ferret).success) continue;
    const label = `state/sessions/${ferret}/config.json`;
    const raw = await readDocument(join(ctx.v4.sessions, ferret, 'config.json'), label);
    if (!isRecord(raw) || raw['id'] !== ferret) continue;
    const part = <T>(key: string, schema: z.ZodType<T>): T | null => {
      if (raw[key] === undefined) return null;
      const parsed = schema.safeParse(raw[key]);
      if (!parsed.success) unreadable++;
      return parsed.success ? parsed.data : null;
    };
    const entry = {
      card: part('focusTask', V4FocusRef),
      anchor: part('focusAnchor', V4FocusRef),
      skip: part('boardSkip', V4BoardSkip),
    };
    if (entry.card !== null || entry.anchor !== null || entry.skip !== null) ferrets[ferret] = entry;
  }
  if (Object.keys(ferrets).length === 0) return { file: undefined, unreadable };
  try {
    return { file: FocusFileSchema.parse({ format: 1, ferrets }), unreadable };
  } catch {
    throw new BoardInputError('the ferrets’ board focus does not fit the v5 focus schema');
  }
}

async function convert(ctx: StepContext): Promise<{ kept: KeptItem[]; notCarried: NotCarried[] }> {
  const paths = v4BoardPaths(ctx.v4.home);
  const plan: Planned[] = [];
  const kept: KeptItem[] = [];
  const notCarried: NotCarried[] = [];
  const names = new FerretNames(ctx);
  const facts: Facts = { namedById: 0, migratedNotes: 0, eventFields: new Set(), clarificationFields: new Set() };

  // ── cards ───────────────────────────────────────────────────────────────────────────────────────────────────────
  const highest: Record<string, number> = { B: 0, F: 0, I: 0, C: 0 };
  const unknownFields = new Set<string>();
  let cards = 0;
  let dropped = 0;
  let approvals = 0;
  let events = 0;
  let ignored = 0;
  for (const file of await boardFiles(paths.tasks, 'state/board/tasks')) {
    const id = CARD_FILE.exec(file)?.[1];
    if (id === undefined) {
      ignored++;
      continue;
    }
    const label = `state/board/tasks/${id}.json`;
    const letter = id.slice(0, 1);
    highest[letter] = Math.max(highest[letter] ?? 0, Number(id.slice(1)));
    const raw = await readDocument(join(paths.tasks, file), label);
    const parsed = V4Card.safeParse(raw);
    if (!parsed.success) throw new BoardInputError(`card ${id} (${label}) is not a v4 card`);
    if (parsed.data.id !== id) throw new BoardInputError(`card ${id} (${label}) holds another card's id`);
    const extra = unknownCardFields(raw as Record<string, unknown>);
    if (extra === undefined) throw new BoardInputError(`card ${id} (${label}) has an unreadable field name`);
    for (const field of extra) unknownFields.add(field);
    let card: Card;
    try {
      card = await mapCard(names, parsed.data, facts);
    } catch (error) {
      if (error instanceof BoardInputError) {
        throw error.message.startsWith(`card ${id} `) ? error : new BoardInputError(`card ${id} has ${error.message}`);
      }
      throw new BoardInputError(`card ${id} does not fit the v5 card schema`);
    }
    cards++;
    if (card.dropped !== null) dropped++;
    if (card.approval !== undefined) approvals++;
    events += card.history.length;
    plan.push({
      path: `state/board/cards/${id}.json`,
      write: async target =>
        await target.v5.json({ path: `state/board/cards/${id}.json`, format: 1, schema: CardSchema }, card),
    });
  }
  kept.push(
    { what: 'cards (ids unchanged; dropped and closed cards included)', count: cards },
    { what: 'dropped cards', count: dropped },
    { what: 'card approvals linked to their ferret’s ask', count: approvals },
    { what: 'card history events (actors in v5 shape)', count: events },
  );
  if (facts.migratedNotes > 0)
    kept.push({ what: 'v4 `migrated` history events kept as notes naming the legacy ref', count: facts.migratedNotes });
  if (facts.namedById > 0) kept.push({ what: 'ferret actors named by id (no v4 config left)', count: facts.namedById });
  if (ignored > 0) kept.push({ what: 'non-card files in state/board/tasks ignored (as v4 does)', count: ignored });
  if (unknownFields.size > 0)
    notCarried.push({
      what: `card fields v4.291.5 does not declare: ${[...unknownFields].join(', ')}`,
      why: 'v4 itself strips them on read; CardSchema is strict',
    });
  if (facts.eventFields.size > 0)
    notCarried.push({
      what: `history event fields v4.291.5 does not declare: ${[...facts.eventFields].sort().join(', ')}`,
      why: 'v4 itself strips them on read; CardEventSchema is strict',
    });
  if (facts.clarificationFields.size > 0)
    notCarried.push({
      what: `clarification fields v4.291.5 does not declare: ${[...facts.clarificationFields].sort().join(', ')}`,
      why: 'v4 itself strips them on read; BoardClarificationSchema is strict',
    });

  // ── counters ────────────────────────────────────────────────────────────────────────────────────────────────────
  const rawCounters = await readDocument(paths.counters, 'state/board/counters.json');
  const counters = rawCounters === undefined ? undefined : V4Counters.safeParse(rawCounters);
  if (counters !== undefined && !counters.success)
    throw new BoardInputError('state/board/counters.json is not a v4 counter file');
  const last: V4CountersValue = counters?.data ?? {};
  const next = Object.fromEntries(
    Object.entries(V4_COUNTER_LETTERS).map(([kind, letter]) => {
      const value = Math.max(last[letter] ?? 0, highest[letter] ?? 0) + 1;
      if (value > MAX_COUNTER) throw new BoardInputError(`the ${letter} card counter is exhausted`);
      return [kind, value];
    }),
  );
  const countersFile = CountersFileSchema.parse({ format: 1, next });
  plan.push({
    path: 'state/board/counters.json',
    write: async target =>
      await target.v5.json({ path: 'state/board/counters.json', format: 1, schema: CountersFileSchema }, countersFile),
  });
  kept.push({ what: 'card id counters (continue after the highest id)', count: 1 });

  // ── boards: lane sets + switch ──────────────────────────────────────────────────────────────────────────────────
  const rawSwitch = await readDocument(paths.switch, 'board/switch.json');
  let switches: V4SwitchValue | undefined;
  if (rawSwitch !== undefined) {
    const parsed = V4Switch.safeParse(rawSwitch);
    if (!parsed.success) throw new BoardInputError('board/switch.json is not a v4 board switch document');
    switches = parsed.data;
  }
  const laneSets = new Map<string, Record<string, unknown>>();
  for (const file of await boardFiles(paths.lanes, 'board/lanes')) {
    const label = `board/lanes/${file}`;
    if (!file.endsWith('.json')) throw new BoardInputError(`${label} is not a lane set file`);
    const project = file.slice(0, -'.json'.length);
    const parsed = V4LaneSet.safeParse(await readDocument(join(paths.lanes, file), label));
    if (!parsed.success) throw new BoardInputError(`${label} is not a v4 lane set`);
    if (parsed.data.projectId !== project) throw new BoardInputError(`${label} names another project`);
    laneSets.set(project, laneSetOf(parsed.data, label));
  }
  const projects = [...new Set([...laneSets.keys(), ...Object.keys(switches?.boards ?? {})])].sort();
  for (const project of projects) {
    if (!BoardProjectIdSchema.safeParse(project).success)
      throw new BoardInputError('board/switch.json names a board that is not a project id');
    let board;
    try {
      board = BoardFileSchema.parse({
        format: 1,
        project,
        switch: switchOf(project, switches),
        laneSet: laneSets.get(project) ?? null,
      });
    } catch {
      throw new BoardInputError(`the board of project ${project} does not fit the v5 board schema`);
    }
    const path = `state/board/boards/${project}.json`;
    plan.push({
      path,
      write: async target => await target.v5.json({ path, format: 1, schema: BoardFileSchema }, board),
    });
  }
  kept.push(
    { what: 'boards (one per project)', count: projects.length },
    { what: 'lane sets', count: laneSets.size },
    { what: 'board switch entries', count: Object.keys(switches?.boards ?? {}).length },
  );

  // ── sweep ───────────────────────────────────────────────────────────────────────────────────────────────────────
  const rawSweep = await readDocument(paths.sweep, 'state/board/sweep.json');
  const sweep = rawSweep === undefined ? undefined : V4Sweep.safeParse(rawSweep);
  if (sweep?.success === true) {
    const { v: _v, ...memory } = sweep.data;
    const file = SweepFileSchema.parse({ format: 1, ...memory });
    plan.push({
      path: 'state/board/sweep.json',
      write: async target =>
        await target.v5.json({ path: 'state/board/sweep.json', format: 1, schema: SweepFileSchema }, file),
    });
  }
  kept.push({ what: 'sweep memories (last run, nudges, what it saw)', count: sweep?.success === true ? 1 : 0 });
  if (sweep !== undefined && !sweep.success)
    kept.push({ what: 'damaged v4 sweep memories started fresh (as v4 does)', count: 1 });

  // ── focus ───────────────────────────────────────────────────────────────────────────────────────────────────────
  const focus = await focusOf(ctx);
  if (focus.file !== undefined) {
    const file = focus.file;
    plan.push({
      path: 'state/board/focus.json',
      write: async target =>
        await target.v5.json({ path: 'state/board/focus.json', format: 1, schema: FocusFileSchema }, file),
    });
  }
  kept.push({
    what: 'ferrets with a board focus, anchor or skip',
    count: Object.keys(focus.file?.ferrets ?? {}).length,
  });
  if (focus.unreadable > 0)
    notCarried.push({
      what: `${focus.unreadable} unreadable focusTask, focusAnchor or boardSkip value(s) in session configs`,
      why: 'v4 would refuse that session config; the focus is left empty (a ferret picks its card again)',
    });

  for (const item of plan) await item.write(ctx);
  return { kept, notCarried };
}

export const boardStep: Step = {
  id: 'board',
  title: 'Board (cards, lanes, links, dependencies, history)',
  owner: ['plugin-board'],
  reads: [
    'state/board/tasks/<id>.json',
    'state/board/counters.json',
    'state/board/sweep.json',
    'board/switch.json and board/lanes/<project>.json (at the home root)',
    'state/sessions/<sid>/config.json (a ferret’s callsign, focusTask, focusAnchor and boardSkip only)',
  ],
  sealed: [],
  notCarried: BOARD_NOT_CARRIED,
  async run(ctx): Promise<StepReport> {
    const base = { id: this.id, title: this.title, sealed: [] };
    try {
      const { kept, notCarried } = await convert(ctx);
      return { ...base, status: 'converted', kept, notCarried: [...this.notCarried, ...notCarried] };
    } catch (error) {
      return {
        ...base,
        status: 'failed',
        note:
          error instanceof BoardInputError
            ? error.message
            : 'cannot convert board input: invalid data or an unavailable file',
        kept: [],
        notCarried: this.notCarried,
      };
    }
  },
};
