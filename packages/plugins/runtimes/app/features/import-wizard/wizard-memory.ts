/**
 * What the wizard remembers across a reload: which tool is open, the runtime names, what was left out and which GitHub
 * tokens were ticked. It rides in the address (`?fyimport=…`, rewritten without leaving the page, as the Board does for its
 * filters), so no new storage exists and a copied link reads the same. Names and item ids only; never a value.
 */
import type { HarnessKey } from '@ferretry/core-ferrets/contract';
import { z } from 'zod';
import { ImportItemIdSchema, type ImportItemId } from '../../../contract/index.ts';

const PARAM = 'fyimport';
/** A longer address is not written: losing the memory is better than an address a server refuses. */
const LONGEST = 6_000;

const Names = z.strictObject({
  'claude-code': z.string().max(200).optional(),
  codex: z.string().max(200).optional(),
});
const Lists = <T extends z.ZodType<string>>(item: T) =>
  z.strictObject({ 'claude-code': z.array(item).max(512).optional(), codex: z.array(item).max(512).optional() });

const End = z.enum(['imported', 'skipped']);

const MemorySchema = z.strictObject({
  tool: z.number().int().min(0).max(1).optional(),
  names: Names.optional(),
  left: Lists(ImportItemIdSchema).optional(),
  ticked: Lists(z.string().min(1).max(100)).optional(),
  /** How each finished tool ended, and whether the person pressed Finish: which step they were on. */
  ends: z.strictObject({ 'claude-code': End.optional(), codex: End.optional() }).optional(),
  finished: z.boolean().optional(),
});

export interface Memory {
  readonly tool: number;
  readonly names: Partial<Record<HarnessKey, string>>;
  readonly left: Readonly<Record<HarnessKey, ReadonlySet<ImportItemId>>>;
  readonly ticked: Readonly<Record<HarnessKey, ReadonlySet<string>>>;
  readonly ends: Partial<Record<HarnessKey, 'imported' | 'skipped'>>;
  readonly finished: boolean;
}

export const emptyMemory = (): Memory => ({
  tool: 0,
  names: {},
  left: { 'claude-code': new Set(), codex: new Set() },
  ticked: { 'claude-code': new Set(), codex: new Set() },
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
    const { tool = 0, names = {}, left = {}, ticked = {}, ends = {}, finished = false } = parsed.data;
    return {
      tool,
      names,
      left: { 'claude-code': new Set(left['claude-code']), codex: new Set(left.codex) },
      ticked: { 'claude-code': new Set(ticked['claude-code']), codex: new Set(ticked.codex) },
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
  memory.left['claude-code'].size +
    memory.left.codex.size +
    memory.ticked['claude-code'].size +
    memory.ticked.codex.size ===
    0;

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
        left: { 'claude-code': [...memory.left['claude-code']], codex: [...memory.left.codex] },
        ticked: { 'claude-code': [...memory.ticked['claude-code']], codex: [...memory.ticked.codex] },
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
