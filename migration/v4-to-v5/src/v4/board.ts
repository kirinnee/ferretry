/**
 * Narrow readers for the v4 (4.291.x) board files. A LOCAL copy on purpose (see `./layout.ts`). Source of truth is
 * `origin/main` at v4.291.5: `packages/protocol/src/lib/{board,board-refs,board-lanes,tasks}.ts`,
 * `packages/daemon/src/adapters/board/file-board-store.ts` (cards, counters),
 * `packages/daemon/src/lib/board/sweep.ts` (sweep), `packages/daemon/src/lib/board-projects/board-switch.ts` (switch).
 * Inventory: `docs/migration/v4-formats.md` §C.iii "1.".
 *
 * Each reader declares the fields the conversion maps. Deep members (history events, clarifications, terms, links,
 * lane options, a pending lane proposal) are read loose here: the step maps them and v5's STRICT Board schemas check
 * every one of them before anything is written. A top-level card field, or a history event field, this reader does not
 * know is reported by NAME (never its value) so nothing is dropped silently.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { info } from './ferrets.ts';

const Instant = z.iso.datetime({ offset: true });
const SessionId = z.string().min(1);
export const CARD_ID = /^[BFIC][1-9][0-9]{0,8}$/u;
const CardId = z.string().regex(CARD_ID);
const MachineId = z.string().trim().min(1).max(128);
const ProjectId = z.union([z.uuid(), z.literal('unfiled')]);
const LaneId = z
  .string()
  .regex(/^[a-z][a-z0-9-]*$/u)
  .max(32);
const Via = z.literal('admin-token');

/** v4 `BoardActorSchema`: closed, each member strict. */
export const V4Actor = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('ferret'), sessionId: SessionId }),
  z.strictObject({ kind: z.literal('owner'), sessionId: SessionId.optional() }),
  z.strictObject({ kind: z.literal('daemon'), sessionId: SessionId.optional() }),
]);
export type V4ActorValue = z.infer<typeof V4Actor>;

/** v4 `TaskRefSchema`. */
export const V4TaskRef = z.strictObject({ machineId: MachineId.optional(), id: CardId });
export type V4TaskRefValue = z.infer<typeof V4TaskRef>;

const V4CardShape = {
  v: z.literal(1),
  id: CardId,
  machineId: MachineId,
  projectId: ProjectId,
  laneId: LaneId,
  kind: z.enum(['bug', 'feature', 'infra', 'chore']),
  title: z.string().trim().min(1).max(200),
  summary: z.string().max(140),
  /** v4 `TaskMessageSchema`: the owner's words and where they were said. */
  ask: z.object({
    text: z
      .string()
      .min(1)
      .max(64 * 1024),
    source: z
      .string()
      .min(1)
      .max(2 * 1024),
  }),
  clarifications: z.array(z.looseObject({})),
  premise: z.string(),
  context: z.string(),
  terms: z.array(z.looseObject({})),
  brief: z.string().max(64 * 1024),
  howToTest: z.string().default(''),
  status: z.strictObject({ now: z.string(), doneSoFar: z.string(), next: z.string() }).optional(),
  owner: SessionId,
  assignee: SessionId.nullable(),
  parent: V4TaskRef.nullable(),
  dependsOn: z.array(z.looseObject({ task: V4TaskRef, until: z.enum(['shipped', 'released']) })),
  blocked: z.looseObject({ on: z.literal('external'), reason: z.string(), since: Instant }).nullable(),
  dropped: z.strictObject({ reason: z.string(), at: Instant }).nullable(),
  workflow: z.enum(['quick', 'design-first', 'research-first', 'investigate']),
  links: z.looseObject({}),
  files: z.array(z.string().min(1)),
  order: z.number().int().nonnegative().nullable(),
  snoozed: z.strictObject({ until: Instant, laneId: LaneId }).nullable().optional(),
  createdAt: Instant,
  createdBy: V4Actor,
  createdByVia: Via.optional(),
  history: z.array(z.looseObject({ seq: z.number().int().positive(), type: z.string().min(1), at: Instant })).min(1),
  legacyRef: z.string().min(1).optional(),
  askedBy: z.enum(['person', 'agent']).optional(),
  visibility: z.enum(['public', 'private']).optional(),
  visibilitySource: z.enum(['default', 'chosen']).optional(),
  /** v4 `AgendaRefSchema`: the creating ferret's agenda item that approved the card. */
  approval: z.strictObject({ sessionId: SessionId, id: z.string().regex(/^A[1-9][0-9]*$/u) }).optional(),
};
export const KNOWN_CARD_FIELDS: ReadonlySet<string> = new Set(Object.keys(V4CardShape));
const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/u;

export const V4Card = z.looseObject(V4CardShape).superRefine((card, context) => {
  const prefix = { bug: 'B', feature: 'F', infra: 'I', chore: 'C' }[card.kind];
  if (!card.id.startsWith(prefix)) context.addIssue({ code: 'custom', message: 'id prefix', path: ['id'] });
  if (card.history.some((event, index) => event.seq !== index + 1))
    context.addIssue({ code: 'custom', message: 'history seq', path: ['history'] });
  if (card.history[0]?.type !== 'created')
    context.addIssue({ code: 'custom', message: 'history opens with created', path: ['history'] });
});
export type V4CardValue = z.infer<typeof V4Card>;

/** The top-level fields of a card this reader does not declare: names only, refused if a name is not field-like. */
export function unknownCardFields(card: Record<string, unknown>): string[] | undefined {
  const unknown = Object.keys(card).filter(key => !KNOWN_CARD_FIELDS.has(key));
  return unknown.every(key => FIELD_NAME.test(key)) ? unknown.sort() : undefined;
}

/** `file-board-store.ts` `CountersSchema`: the LAST id handed out per kind letter, each optional. */
export const V4Counters = z
  .object({
    B: z.number().int().min(0).max(999_999_999),
    F: z.number().int().min(0).max(999_999_999),
    I: z.number().int().min(0).max(999_999_999),
    C: z.number().int().min(0).max(999_999_999),
  })
  .partial();
export type V4CountersValue = z.infer<typeof V4Counters>;

/** `sweep.ts` `SweepMemorySchema`. */
export const V4Sweep = z.strictObject({
  v: z.literal(1),
  sweptAt: Instant.nullable(),
  nudged: z.record(z.string(), Instant),
  seen: z.record(z.string(), z.object({ blockedBy: z.array(z.string()) })),
});

/** `board-switch.ts` `BoardSwitchDocumentSchema`, at `<home>/board/switch.json`. */
export const V4Switch = z.strictObject({
  v: z.literal(1),
  migratedAt: Instant,
  boards: z.record(
    z.string(),
    z.strictObject({ on: z.boolean(), setBy: z.enum(['migration', 'owner']), setAt: Instant }),
  ),
});
export type V4SwitchValue = z.infer<typeof V4Switch>;

const V4Lane = z.looseObject({
  id: LaneId,
  name: z.string().trim().min(1).max(40),
  category: z.enum(['backlog', 'active', 'review', 'shipped', 'verify', 'closed']),
});

/**
 * `board-lanes.ts` `LaneSetSchema`, at `<home>/board/lanes/<projectId>.json`. No format marker; `version` is the
 * lane-set revision. `doneLane`/`notGoodLane` are derived on read by v4 when absent (`withDerivedTargets`).
 */
export const V4LaneSet = z.looseObject({
  projectId: ProjectId,
  version: z.number().int().positive(),
  confirmedBy: z.literal('owner').nullable(),
  proposedBy: z.string().min(1),
  lanes: z.array(V4Lane).min(1).max(16),
  doneLane: LaneId.optional(),
  notGoodLane: LaneId.optional(),
  pending: z.looseObject({ version: z.number().int().positive() }).optional(),
});
export type V4LaneSetValue = z.infer<typeof V4LaneSet>;

/** v4 `defaultLaneTargets`: Done goes to the closed lane, Not good to the last active lane (else the backlog). */
export function defaultLaneTargets(
  lanes: readonly { readonly id: string; readonly category: string }[],
): { doneLane: string; notGoodLane: string } | undefined {
  const done = lanes.find(lane => lane.category === 'closed');
  const notGood = lanes.findLast(lane => lane.category === 'active') ?? lanes.find(lane => lane.category === 'backlog');
  return done === undefined || notGood === undefined ? undefined : { doneLane: done.id, notGoodLane: notGood.id };
}

/** A problem with a v4 board file, worded with the file or card id only: safe to put in the report. */
export class BoardInputError extends Error {
  override readonly name = 'BoardInputError';
}

/**
 * The regular files in a v4 board folder. A link anywhere in it is refused (never followed); a folder that is not
 * there is empty.
 */
export async function boardFiles(path: string, label: string): Promise<string[]> {
  const source = await info(path);
  if (source === undefined) return [];
  if (!source.isDirectory()) throw new BoardInputError(`${label} is not a folder`);
  const entries = await readdir(path, { withFileTypes: true });
  if (entries.some(entry => entry.isSymbolicLink())) throw new BoardInputError(`${label} contains a link`);
  return entries
    .filter(entry => entry.isFile())
    .map(entry => entry.name)
    .sort();
}

/** One v4 JSON document: `undefined` when absent; a link, a non-file or invalid JSON is an error naming `label`. */
export async function readDocument(path: string, label: string): Promise<unknown> {
  const source = await info(path);
  if (source === undefined) return undefined;
  if (!source.isFile()) throw new BoardInputError(`${label} is not a regular file`);
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch {
    throw new BoardInputError(`${label} is not valid JSON`);
  }
}

/** Where v4 keeps its board: cards, counters and sweep under `state/board/`, switch and lanes under `<home>/board/`. */
export function v4BoardPaths(home: string) {
  const state = join(home, 'state', 'board');
  const root = join(home, 'board');
  return {
    tasks: join(state, 'tasks'),
    counters: join(state, 'counters.json'),
    sweep: join(state, 'sweep.json'),
    switch: join(root, 'switch.json'),
    lanes: join(root, 'lanes'),
  };
}

/**
 * Every history event type v4.291.5 writes (`BoardTaskEventSchema`, a closed union). v5's `CardEventSchema` has each of
 * them under the same name except `migrated`, which the step rewrites as a `note`.
 */
export const V4_EVENT_TYPES: ReadonlySet<string> = new Set([
  'created',
  'moved',
  'reopened',
  'note',
  'clarified',
  'linked',
  'assigned',
  'depended',
  'undepended',
  'blocked',
  'unblocked',
  'field-edited',
  'file-claimed',
  'file-released',
  'ordered',
  'snoozed',
  'refiled',
  'reparented',
  'dropped',
  'migrated',
]);

/** v4 `LegacyTaskRefSchema`: the `<session>:<old id>` a `migrated` event and a card's `legacyRef` name. */
export const V4LegacyRef = z.string().regex(/^[^\s:]+:[BFIC][1-9][0-9]{0,8}$/u);

/** The board fields of a v4 session `config.json` (`SessionConfigSchema`): its name, callsign and focus. */
export const V4FerretBoardConfig = z.looseObject({
  id: SessionId,
  name: z.string().min(1),
  teammate: z.string().optional(),
});
/** `focusTask` / `focusAnchor`: a card ref. */
export const V4FocusRef = V4TaskRef;
/** `boardSkip`: v4 `BoardSkipSchema`. */
export const V4BoardSkip = z.strictObject({
  reason: z
    .string()
    .trim()
    .min(1)
    .max(2 * 1024),
  at: Instant,
});
