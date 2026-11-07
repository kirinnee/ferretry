/**
 * `ports-pending` (§7.9, spine §7): `ports-pending.json` grows (against the base ref, default `origin/rebuild/5.0`),
 * names an id that is no subsystem, or lists a plugin none of whose halves is a skeleton any more. A port removes its
 * own line in the same branch.
 *
 * `pendingGaps` is a ported plugin's declared GAPs, in words: `{ "<id>": ["<what is missing>: <what it needs>", …] }`.
 * It may name only subsystems, each with at least one non-empty reason; it is what a port that left a half of today's
 * behaviour waiting on another subsystem says out loud.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isSkeleton } from '../gen/lib/halves.ts';
import { type Check, type Finding, runMain } from '../gen/lib/check.ts';
import { HALVES, loadHalf } from '../gen/lib/workspace.ts';

export interface PortsPending {
  readonly format: 1;
  readonly pending: readonly string[];
}

export function parsePending(text: string, where: string): PortsPending {
  const value = JSON.parse(text) as { format?: unknown; pending?: unknown };
  if (value.format !== 1) throw new Error(`${where}: format is not 1`);
  if (!Array.isArray(value.pending) || value.pending.some(id => typeof id !== 'string'))
    throw new Error(`${where}: "pending" is not a list of ids`);
  return { format: 1, pending: value.pending as string[] };
}

/** The declared GAPs of `ports-pending.json`, or a finding's message when the field is malformed. */
export function readPendingGaps(root: string): ReadonlyMap<string, readonly string[]> | string {
  const file = join(root, 'ports-pending.json');
  if (!existsSync(file)) return new Map();
  const value = (JSON.parse(readFileSync(file, 'utf8')) as { pendingGaps?: unknown }).pendingGaps;
  if (value === undefined) return new Map();
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return 'pendingGaps must map subsystem ids to their reasons';
  const gaps = new Map<string, readonly string[]>();
  for (const [id, reasons] of Object.entries(value)) {
    if (
      !Array.isArray(reasons) ||
      reasons.length === 0 ||
      reasons.some(reason => typeof reason !== 'string' || reason.trim() === '')
    )
      return `pendingGaps: ${id} needs a list of non-empty reasons`;
    gaps.set(id, reasons as string[]);
  }
  return gaps;
}

export function readPending(root: string): PortsPending {
  const file = join(root, 'ports-pending.json');
  if (!existsSync(file)) return { format: 1, pending: [] };
  return parsePending(readFileSync(file, 'utf8'), 'ports-pending.json');
}

/** The base list: a git ref's committed `ports-pending.json`, or `file:<path>` (tests, and a release compare). */
function readBase(root: string, ref: string): PortsPending | undefined {
  if (ref.startsWith('file:')) {
    const file = ref.slice(5);
    return existsSync(file) ? parsePending(readFileSync(file, 'utf8'), file) : undefined;
  }
  const shown = spawnSync('git', ['show', `${ref}:ports-pending.json`], { cwd: root, encoding: 'utf8' });
  if (shown.status !== 0) return undefined;
  return parsePending(shown.stdout, `${ref}:ports-pending.json`);
}

export const check: Check = {
  name: 'ports-pending',
  summary: 'ports-pending.json only shrinks and lists only skeletons',
  async run(ctx) {
    const check = 'ports-pending';
    const findings: Finding[] = [];
    let current: PortsPending;
    try {
      current = readPending(ctx.root);
    } catch (error) {
      return [{ check, where: 'ports-pending.json', message: error instanceof Error ? error.message : String(error) }];
    }
    const seen = new Set<string>();
    for (const id of current.pending) {
      if (seen.has(id)) findings.push({ check, where: 'ports-pending.json', message: `${id} listed twice` });
      seen.add(id);
    }
    const base = readBase(ctx.root, ctx.base ?? 'origin/rebuild/5.0');
    if (base !== undefined) {
      const before = new Set(base.pending);
      for (const id of current.pending)
        if (!before.has(id))
          findings.push({ check, where: 'ports-pending.json', message: `${id} was added; the list may only shrink` });
    }
    const model = await ctx.model();
    const gaps = readPendingGaps(ctx.root);
    if (typeof gaps === 'string') findings.push({ check, where: 'ports-pending.json', message: gaps });
    else
      for (const id of gaps.keys())
        if (!model.loaded.some(s => s.id === id))
          findings.push({ check, where: 'ports-pending.json', message: `pendingGaps: ${id} is not a subsystem` });
    for (const id of current.pending) {
      const subsystem = model.loaded.find(s => s.id === id);
      if (subsystem === undefined) {
        findings.push({ check, where: 'ports-pending.json', message: `${id} is not a subsystem in this workspace` });
        continue;
      }
      let anySkeleton = false;
      for (const half of HALVES) {
        try {
          const impl = await loadHalf(subsystem.pkg, half);
          if (impl !== undefined && isSkeleton(impl)) anySkeleton = true;
        } catch {
          anySkeleton = true; // manifest-match reports the load failure
        }
      }
      if (!anySkeleton)
        findings.push({
          check,
          where: 'ports-pending.json',
          message: `${id} has no skeleton half left; remove its line`,
        });
    }
    return findings;
  },
};

if (import.meta.main) await runMain(check, process.argv.slice(2));
