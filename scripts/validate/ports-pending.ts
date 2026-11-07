/**
 * `ports-pending` (§7.9, spine §7): `ports-pending.json` grows (against the base ref, default `origin/rebuild/5.0`),
 * names an id that is no subsystem, or lists a plugin none of whose halves is a skeleton any more. A port removes its
 * own line in the same branch.
 *
 * A plugin whose halves are all ported but whose port still has named gaps open stays listed, and says why in
 * `pendingReasons` (`{ "<id>": ["<open gap>", …] }`): a listed plugin with no skeleton half left is accepted only
 * while it states at least one reason, and a reason for an id that is not listed is a finding.
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
  /** Why a fully ported plugin is still listed: its open gaps, by plugin id. */
  readonly reasons: Readonly<Record<string, readonly string[]>>;
}

export function parsePending(text: string, where: string): PortsPending {
  const value = JSON.parse(text) as { format?: unknown; pending?: unknown; pendingReasons?: unknown };
  if (value.format !== 1) throw new Error(`${where}: format is not 1`);
  if (!Array.isArray(value.pending) || value.pending.some(id => typeof id !== 'string'))
    throw new Error(`${where}: "pending" is not a list of ids`);
  const reasons: Record<string, string[]> = {};
  if (value.pendingReasons !== undefined) {
    const given = value.pendingReasons;
    if (typeof given !== 'object' || given === null || Array.isArray(given))
      throw new Error(`${where}: "pendingReasons" is not an object of plugin id to reasons`);
    for (const [id, list] of Object.entries(given)) {
      if (!Array.isArray(list) || list.some(reason => typeof reason !== 'string' || reason.trim() === ''))
        throw new Error(`${where}: "pendingReasons.${id}" is not a list of non-empty sentences`);
      reasons[id] = list as string[];
    }
  }
  return { format: 1, pending: value.pending as string[], reasons };
}

export function readPending(root: string): PortsPending {
  const file = join(root, 'ports-pending.json');
  if (!existsSync(file)) return { format: 1, pending: [], reasons: {} };
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
    for (const id of Object.keys(current.reasons))
      if (!seen.has(id))
        findings.push({
          check,
          where: 'ports-pending.json',
          message: `${id} has reasons but is not listed in "pending"`,
        });
    const base = readBase(ctx.root, ctx.base ?? 'origin/rebuild/5.0');
    if (base !== undefined) {
      const before = new Set(base.pending);
      for (const id of current.pending)
        if (!before.has(id))
          findings.push({ check, where: 'ports-pending.json', message: `${id} was added; the list may only shrink` });
    }
    const model = await ctx.model();
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
      if (!anySkeleton && (current.reasons[id]?.length ?? 0) === 0)
        findings.push({
          check,
          where: 'ports-pending.json',
          message: `${id} has no skeleton half left; remove its line, or say what is still open in "pendingReasons"`,
        });
    }
    return findings;
  },
};

if (import.meta.main) await runMain(check, process.argv.slice(2));
