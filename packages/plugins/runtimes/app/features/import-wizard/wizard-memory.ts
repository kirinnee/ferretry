/**
 * What the wizard remembers across a reload: which tool is open, the runtime names, what was left out and which GitHub
 * tokens were ticked. It rides in the address (`?fyimport=…`, rewritten without leaving the page, as the Board does for its
 * filters), so no new storage exists and a copied link reads the same. Names and item ids only; never a value.
 */
import { z } from 'zod';
import { HarnessKeySchema } from '@ferretry/core-ferrets/contract';
import { ImportItemIdSchema, type ImportItemId } from '../../../contract/index.ts';
import { supportedHarnessKeys } from '../../../contract/harness-words.ts';

const PARAM = 'fyimport';
/** A longer address is not written: losing the memory is better than an address a server refuses. */
const LONGEST = 6_000;

/** Each map is keyed by harness: the keys a person's address names are the plugin keys, whatever harnesses exist. */
const Names = z.record(HarnessKeySchema, z.string().max(200));
const Lists = <T extends z.ZodType<string>>(item: T) => z.record(HarnessKeySchema, z.array(item).max(512));

const End = z.enum(['imported', 'skipped']);

const MemorySchema = z.strictObject({
  tool: z
    .number()
    .int()
    .min(0)
    .max(supportedHarnessKeys().length - 1)
    .optional(),
  names: Names.optional(),
  left: Lists(ImportItemIdSchema).optional(),
  ticked: Lists(z.string().min(1).max(100)).optional(),
  /** Changed sources the person unticked: they are kept as they were. */
  declined: Lists(z.string().min(1).max(200)).optional(),
  /** How each finished tool ended, and whether the person pressed Finish: which step they were on. */
  ends: z.record(HarnessKeySchema, End).optional(),
  finished: z.boolean().optional(),
});

/** What each harness holds, by harness. A harness the wizard has not touched holds nothing (see {@link setOf}). */
export type PerHarness<T> = Readonly<Record<string, ReadonlySet<T>>>;

/** The set a harness holds in `sets`: empty when it has none. */
export const setOf = <T>(sets: PerHarness<T>, harness: string): ReadonlySet<T> => sets[harness] ?? new Set<T>();

const emptySets = <T>(): Record<string, ReadonlySet<T>> =>
  Object.fromEntries(supportedHarnessKeys().map(harness => [harness, new Set<T>()]));

/** The harnesses the wizard walks always hold a set, so what an address carries is the same whatever was touched. */
const setsOf = <T>(lists: Readonly<Record<string, readonly T[]>>): Record<string, ReadonlySet<T>> => ({
  ...emptySets<T>(),
  ...Object.fromEntries(Object.entries(lists).map(([harness, list]) => [harness, new Set(list)])),
});

const listsOf = <T>(sets: PerHarness<T>): Record<string, readonly T[]> =>
  Object.fromEntries(Object.entries(sets).map(([harness, set]) => [harness, [...set]]));

export interface Memory {
  readonly tool: number;
  readonly names: Readonly<Record<string, string>>;
  readonly left: PerHarness<ImportItemId>;
  readonly ticked: PerHarness<string>;
  readonly declined: PerHarness<string>;
  readonly ends: Readonly<Record<string, 'imported' | 'skipped'>>;
  readonly finished: boolean;
}

export const emptyMemory = (): Memory => ({
  tool: 0,
  names: {},
  left: emptySets(),
  ticked: emptySets(),
  declined: emptySets(),
  ends: {},
  finished: false,
});

/** The memory an address carries; a missing or damaged one reads as nothing remembered. */
export const readMemory = (search: string): Memory => {
  const raw = new URLSearchParams(search).get(PARAM);
  if (raw === null) return emptyMemory();
  try {
    const parsed = MemorySchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return emptyMemory();
    const { tool = 0, names = {}, left = {}, ticked = {}, declined = {}, ends = {}, finished = false } = parsed.data;
    return {
      tool,
      names,
      left: setsOf(left),
      ticked: setsOf(ticked),
      declined: setsOf(declined),
      ends,
      finished,
    };
  } catch {
    return emptyMemory();
  }
};

const nothingRemembered = (memory: Memory): boolean =>
  memory.tool === 0 &&
  Object.keys(memory.names).length === 0 &&
  Object.keys(memory.ends).length === 0 &&
  !memory.finished &&
  [memory.left, memory.ticked, memory.declined].every(sets => Object.values(sets).every(set => set.size === 0));

/** The address's query with this memory in it (and nothing else of the query touched), or null when it would be too long. */
export const withMemory = (search: string, memory: Memory): string | null => {
  const query = new URLSearchParams(search);
  if (nothingRemembered(memory)) query.delete(PARAM);
  else
    query.set(
      PARAM,
      JSON.stringify({
        tool: memory.tool,
        names: memory.names,
        left: listsOf(memory.left),
        ticked: listsOf(memory.ticked),
        declined: listsOf(memory.declined),
        ends: memory.ends,
        finished: memory.finished,
      }),
    );
  const text = query.toString();
  return text.length > LONGEST ? null : text === '' ? '' : `?${text}`;
};

/** Rewrites the address's query without leaving the page. A failure (no history, a blocked frame) is no memory, not an error. */
export const rememberInAddress = (memory: Memory): void => {
  try {
    const next = withMemory(globalThis.location.search, memory);
    if (next === null || next === globalThis.location.search) return;
    globalThis.history.replaceState(
      globalThis.history.state,
      '',
      `${globalThis.location.pathname}${next}${globalThis.location.hash}`,
    );
  } catch {
    /* the address is not ours to fail on */
  }
};
