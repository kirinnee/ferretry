import { z } from 'zod';
import { type AgendaItem, AgendaEditRequestSchema, AgendaTabEditSchema, MAX_AGENDA_TAB_EDITS } from './agenda.ts';

/**
 * AN AGENDA ITEM AS ONE EDITABLE DOCUMENT (`fy agenda patch`, docs/agenda.md § Patch: the item as one document).
 *
 * The semantics are JSON Merge Patch (RFC 7386), one level deep: a key that is present replaces that field, an absent
 * key leaves it, `null` removes it. `tabs` is the one map that merges by key — each tab addressed by its name, Markdown
 * makes or rewrites it, `null` removes it. Every other value (a list, the recommendation, the ask) is replaced whole.
 *
 * Each field is the edit request's own schema (`AgendaEditRequestSchema`), so a patch and an edit can never disagree on
 * what a field may hold; the patch only renames `subject` to `summary` (what the CLI calls it) and takes `neededBy` as
 * typed (`--by`: ISO, "in 3h", "17:00"), which the CLI resolves against its clock.
 *
 * STRICT: an unknown or read-only key (the state, history, versions, who raised it) is refused by name, so a typo never
 * silently does nothing, and the document has no token, digest or credential field for a patch to carry.
 */
const edit = AgendaEditRequestSchema.shape;

/** A field a patch may also remove with `null`. */
const removable = <T extends z.ZodType>(schema: z.ZodOptional<T>) => schema.unwrap().nullable().optional();

/** One tab's new words, or `null` to remove it. */
const TabBodySchema = AgendaTabEditSchema.shape.body.unwrap().nullable();

/** The ferret's own tabs, by name (or id): Markdown makes or rewrites one, `null` removes it. */
const AgendaPatchTabsSchema = z
  .record(AgendaTabEditSchema.shape.tab, TabBodySchema)
  .refine(tabs => Object.keys(tabs).length >= 1, 'tabs names at least one tab')
  .refine(
    tabs => Object.keys(tabs).length <= MAX_AGENDA_TAB_EDITS,
    `a patch changes at most ${MAX_AGENDA_TAB_EDITS} tabs at once`,
  );

const AgendaPatchSchema = z.strictObject({
  /**
   * READ BEFORE WRITE: the revision `fy agenda show <id> --yaml` printed. Required, so a patch is always written
   * against the whole item as last read; one the item has moved past is refused `stale` (read it again).
   */
  revision: edit.revision.unwrap(),
  /** The item's heading: rewritten, never removed. */
  title: edit.title,
  /** The one-line ask (`subject` on the wire): rewritten, never removed. */
  summary: edit.subject,
  /** The WHY line the owner reads: rewritten, never removed. */
  why: edit.why,
  /** How the owner resolves it, in one line: rewritten, never removed. */
  howToResolve: edit.howToResolve,
  stage: edit.stage,
  /** The situation: a cold reader starts here, so it is rewritten, never removed. */
  premise: edit.premise,
  /** The facts around it: rewritten, never removed. */
  context: edit.context.unwrap().unwrap().optional(),
  decided: removable(edit.decided),
  stillOpen: removable(edit.stillOpen),
  terms: removable(edit.terms),
  /** The ask's questions: rewording keeps the ask; other options replace it. Never removed. */
  questions: edit.questions,
  recommendation: removable(edit.recommendation),
  optionDetails: removable(edit.optionDetails),
  impact: removable(edit.impact),
  urgency: removable(edit.urgency),
  /** `true` sets it; `false` or `null` takes it off. */
  blockingNow: z.boolean().nullable().optional(),
  willBlock: removable(edit.willBlock),
  /** When the answer is needed, as `--by` takes it: ISO, "in 3h" or a clock time like 17:00. */
  neededBy: z.string().trim().min(1).max(64).nullable().optional(),
  links: removable(edit.links),
  /** A to-do's steps: replaced whole (their ticks clear), never removed. */
  steps: edit.steps,
  /** The ferret's answer to the owner's question, shown above the options. */
  questionAnswer: removable(edit.questionAnswer),
  /** THE MAIN TAB, "Where we are now". */
  whereWeAre: removable(edit.whereWeAre),
  /** "The full picture". */
  body: removable(edit.body),
  tabs: AgendaPatchTabsSchema.optional(),
  detail: removable(edit.detail),
  /** THE ASK: a value that differs from the item's replaces the ask, which then asks again, fresh. */
  kind: edit.kind,
  ask: edit.ask,
  answers: edit.answers,
  fields: edit.fields,
});
type AgendaPatch = z.infer<typeof AgendaPatchSchema>;

/** Every key a patch takes, in the order `show --yaml` prints them. */
const AGENDA_PATCH_KEYS = Object.keys(AgendaPatchSchema.shape) as readonly (keyof AgendaPatch)[];

/**
 * The fields an item's revision covers: everything the owner reads on it and a ferret may change, the ask's version,
 * the stage, and the owner's latest answer — so the owner's new answer, a replaced ask or anybody's rewrite moves it.
 */
const REVISION_FIELDS: readonly string[] = [
  'subject',
  ...AGENDA_PATCH_KEYS.filter(key => key !== 'revision' && key !== 'summary'),
  'askVersion',
  'ownerAnswer',
];

/** Plain JSON with its keys sorted, so the same content always reads the same. */
const stableJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, each]) => each !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, each]) => `${JSON.stringify(key)}:${stableJson(each)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
};

/** FNV-1a over UTF-16 code units from `seed`, as 32 bits. */
const fnv1a = (text: string, seed: number): number => {
  let hash = seed;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
};

/**
 * AN ITEM'S REVISION (`agenda.patch.1`): a fingerprint of what the item says now, which `show --yaml` prints and a
 * patch carries back. The CLI and the daemon compute it with this one function, so they cannot disagree on it. It is a
 * concurrency check, not a credential: it proves nothing about who may write, and it is derived from words the reader
 * already holds.
 */
export const agendaItemRevision = (item: AgendaItem): string => {
  const record = item as unknown as Record<string, unknown>;
  const text = stableJson(Object.fromEntries(REVISION_FIELDS.map(field => [field, record[field]])));
  return `${fnv1a(text, 0x811c9dc5).toString(36)}${fnv1a(text, 0x01000193 ^ 0x9e3779b9).toString(36)}`;
};
