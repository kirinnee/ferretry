/**
 * Board: cards, counters, lane sets with the board switch, and the sweep's last run. Every v4 file is read with this
 * tool's own parser (`../v4/board.ts`), mapped, and parsed by the v5 Board contract schema before anything is written.
 * All files are mapped first and written only after every one succeeded, so a failure writes nothing.
 *
 * Cards (`state/board/tasks/<id>.json` → `state/board/cards/<id>.json`, `CardSchema`):
 *  - The id is kept exactly (`&F1792` still names the same card), as are kind, lane, project, owner, assignee,
 *    workflow, order, files, visibility, approval and every instant.
 *  - Renamed: `v` → `format`, `machineId` → `machine`, `projectId` → `project`, `laneId` → `lane`, `status` →
 *    `progress`, `snoozed.laneId` → `snoozed.lane`, and `machineId` → `machine` inside `parent` and `dependsOn[].task`.
 *  - `ask` is v4's `{text, source}` and v5's plain text: the text is kept, the source is declared not carried.
 *  - `createdBy`: a ferret actor gains the `name` v5 requires (the ferret's name from its v4 `config.json`, or its id
 *    when no config is left); an owner actor keeps `createdByVia` as `via`; the session an owner or the daemon acted
 *    from has no v5 field.
 *  - `approval {sessionId, id}` → `{ferret, ask}`: the same agenda item `A<n>` on the same ferret's board. Asks keeps
 *    per-ferret ask ids, so the link resolves unchanged.
 *  - `history`, `clarifications`, `terms`, `links` (with the PR cache), `blocked` and the extra fields of each
 *    dependency (the owner's `override`) are carried whole, in their v4 shape: v5 declares them as loose records
 *    (the port replaces each with today's strict schema when it ports the code that reads it).
 *  - Dropped cards and cards in a closed lane are ordinary cards and are all kept.
 *
 * Counters (`state/board/counters.json`): v4 stores the LAST number handed out per letter (partial), and allocates
 * `max(counter, highest id on disk) + 1`. v5 stores the NEXT number per kind; the converter writes exactly what v4
 * would have allocated next, so numbering continues after the highest id and never reuses one.
 *
 * Boards (`<home>/board/lanes/<project>.json` + `<home>/board/switch.json` → `state/board/boards/<project>.json`): one
 * file per project that has a lane set or a switch entry. The lane set is carried whole (v5's is a loose record), with
 * `doneLane`/`notGoodLane` derived exactly as v4 derived them on read when the file predates them. The switch: an
 * owner's choice stays the owner's; v4's one-time `migration` choice is v5's `default`; a board with no entry is off,
 * as in v4.
 *
 * Sweep (`state/board/sweep.json`): only when it last ran. A damaged v4 sweep memory is, as in v4, a fresh start.
 *
 * Errors name a file or a card id, never a value from it.
 */
import { FerretIdSchema } from '@ferretry/core-ferrets/contract';
import {
  BoardFileSchema,
  BoardProjectIdSchema,
  CardSchema,
  CountersFileSchema,
  SweepFileSchema,
  type Card,
} from '@ferretry/plugin-board/contract';
import { join } from 'node:path';
import { z } from 'zod';
import type { KeptItem, NotCarried, StepReport } from '../report.ts';
import {
  BoardInputError,
  boardFiles,
  defaultLaneTargets,
  KNOWN_CARD_FIELDS,
  readDocument,
  unknownCardFields,
  V4Card,
  type V4ActorValue,
  type V4CardValue,
  V4Counters,
  type V4CountersValue,
  V4LaneSet,
  type V4LaneSetValue,
  V4Sweep,
  V4Switch,
  type V4SwitchValue,
  type V4TaskRefValue,
  v4BoardPaths,
} from '../v4/board.ts';
import type { Step, StepContext } from './index.ts';

const BOARD_NOT_CARRIED: readonly NotCarried[] = [
  { what: 'derived indexes (SQLite caches)', why: 'v5 rebuilds every cache from the kept files' },
  {
    what: 'card ask.source (where the owner said the words)',
    why: 'CardSchema.ask is plain text; the ask text itself is kept verbatim',
  },
  {
    what: 'card legacyRef',
    why: 'CardSchema has no legacyRef (dropped as compatibility); the card id and its `migrated` history event are kept',
  },
  {
    what: 'the session an owner or the daemon created a card from (createdBy.sessionId)',
    why: 'CardActorSchema owner and daemon members have no ferret field',
  },
  {
    what: 'createdByVia on a card a ferret or the daemon created',
    why: 'CardActorSchema carries via only on the owner member',
  },
  {
    what: 'sweep nudged and seen',
    why: 'SweepFileSchema keeps lastRunAt only; costs at most one early stale nudge per card',
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
const ConfigName = z.looseObject({ id: z.string(), name: z.string().min(1) });

interface Planned {
  readonly path: string;
  readonly write: (ctx: StepContext) => Promise<void>;
}

/** A ferret's name as v4 recorded it, or `undefined` when its session folder has no readable config. */
async function ferretName(ctx: StepContext, ferret: string): Promise<string | undefined> {
  if (!FerretIdSchema.safeParse(ferret).success) return undefined;
  const raw = await readDocument(join(ctx.v4.sessions, ferret, 'config.json'), `state/sessions/${ferret}/config.json`);
  const parsed = ConfigName.safeParse(raw);
  return parsed.success && parsed.data.id === ferret ? parsed.data.name : undefined;
}

const cardRef = (ref: V4TaskRefValue) =>
  ref.machineId === undefined ? { id: ref.id } : { machine: ref.machineId, id: ref.id };

interface CardFacts {
  namedById: number;
}

async function actorOf(
  ctx: StepContext,
  actor: V4ActorValue,
  via: 'admin-token' | undefined,
  facts: CardFacts,
): Promise<unknown> {
  if (actor.kind === 'ferret') {
    const name = await ferretName(ctx, actor.sessionId);
    if (name === undefined) facts.namedById++;
    return { kind: 'ferret', name: name ?? actor.sessionId, ferret: actor.sessionId };
  }
  if (actor.kind === 'owner') return via === undefined ? { kind: 'owner' } : { kind: 'owner', via };
  return { kind: 'daemon' };
}

async function mapCard(ctx: StepContext, card: V4CardValue, facts: CardFacts): Promise<Card> {
  const {
    v: _v,
    machineId,
    projectId,
    laneId,
    ask,
    status,
    parent,
    dependsOn,
    snoozed,
    createdBy,
    createdByVia,
    legacyRef: _legacyRef,
    approval,
    ...rest
  } = card;
  // Unknown top-level fields are reported by name in notCarried; they never reach the strict v5 schema.
  const same = Object.fromEntries(Object.entries(rest).filter(([key]) => KNOWN_CARD_FIELDS.has(key)));
  return CardSchema.parse({
    ...same,
    format: 1,
    machine: machineId,
    project: projectId,
    lane: laneId,
    ask: ask.text,
    ...(status === undefined ? {} : { progress: status }),
    parent: parent === null ? null : cardRef(parent),
    dependsOn: dependsOn.map(dependency => ({ ...dependency, task: cardRef(dependency.task) })),
    ...(snoozed === undefined
      ? {}
      : { snoozed: snoozed === null ? null : { until: snoozed.until, lane: snoozed.laneId } }),
    createdBy: await actorOf(ctx, createdBy, createdByVia, facts),
    ...(approval === undefined ? {} : { approval: { ferret: approval.sessionId, ask: approval.id } }),
  });
}

function laneSetOf(set: V4LaneSetValue, label: string): V4LaneSetValue {
  if (set.doneLane !== undefined && set.notGoodLane !== undefined) return set;
  const derived = defaultLaneTargets(set.lanes);
  if (derived === undefined) throw new BoardInputError(`${label} has no lane Done or Not good can go to`);
  return { ...set, doneLane: set.doneLane ?? derived.doneLane, notGoodLane: set.notGoodLane ?? derived.notGoodLane };
}

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

async function convert(ctx: StepContext): Promise<{ kept: KeptItem[]; notCarried: NotCarried[] }> {
  const paths = v4BoardPaths(ctx.v4.home);
  const plan: Planned[] = [];
  const kept: KeptItem[] = [];
  const notCarried: NotCarried[] = [];
  const facts: CardFacts = { namedById: 0 };

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
      card = await mapCard(ctx, parsed.data, facts);
    } catch (error) {
      if (error instanceof BoardInputError) throw error;
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
    { what: 'card history events (v4 shape, whole)', count: events },
  );
  if (facts.namedById > 0)
    kept.push({ what: 'ferret creators named by id (no v4 config left)', count: facts.namedById });
  if (ignored > 0) kept.push({ what: 'non-card files in state/board/tasks ignored (as v4 does)', count: ignored });
  if (unknownFields.size > 0)
    notCarried.push({
      what: `card fields v4.291.5 does not declare: ${[...unknownFields].join(', ')}`,
      why: 'v4 itself strips them on read; CardSchema is strict',
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
  const laneSets = new Map<string, V4LaneSetValue>();
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
    const file = SweepFileSchema.parse({ format: 1, lastRunAt: sweep.data.sweptAt });
    plan.push({
      path: 'state/board/sweep.json',
      write: async target =>
        await target.v5.json({ path: 'state/board/sweep.json', format: 1, schema: SweepFileSchema }, file),
    });
  }
  kept.push({ what: 'sweep last-run instants', count: sweep?.success === true ? 1 : 0 });
  if (sweep !== undefined && !sweep.success)
    kept.push({ what: 'damaged v4 sweep memories started fresh (as v4 does)', count: 1 });

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
    'state/sessions/<sid>/config.json (a creating ferret’s name only)',
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
