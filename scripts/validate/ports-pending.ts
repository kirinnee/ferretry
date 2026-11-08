/**
 * `ports-pending` (§7.9, spine §7): `ports-pending.json` grows (against the base ref, default `origin/rebuild/5.0`),
 * names an id that is no subsystem, or lists a plugin none of whose halves is a skeleton any more. A port removes its
 * own line in the same branch.
 *
 * A plugin whose halves are all ported but whose port still has named gaps open stays listed, and says why in
 * `pendingReasons` (`{ "<id>": ["<open gap>", …] }`): a listed plugin with no skeleton half left is accepted only
 * while it states at least one reason, and a reason for an id that is not listed is a finding.
 *
 * Two-way skeleton rule: `pendingHalves` (`{ "<id>": ["app", …] }`) names exactly the halves that are skeletons. A
 * skeleton half it does not name is a finding, and so is a name for a half that is real (or for a half that does not
 * exist). `pendingHalves` also only shrinks against the base, apart from the one-time corrections in
 * `ONE_TIME_HALF_ALLOWANCE`.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isSkeleton } from '../gen/lib/halves.ts';
import { type Check, type Finding, runMain } from '../gen/lib/check.ts';
import { readPendingApps } from '../gen/lib/pending-apps.ts';
import { HALVES, loadHalf } from '../gen/lib/workspace.ts';

/**
 * Halves that may enter `pendingHalves` once even though the list only shrinks. Each is a correction, not a new
 * deferral: the half was a skeleton the whole time and was never named. An entry is inert once the base names it.
 */
export const ONE_TIME_HALF_ALLOWANCE: readonly {
  readonly id: string;
  readonly half: string;
  readonly reason: string;
}[] = [
  { id: 'catalogs', half: 'app', reason: 'a correction: these halves were skeletons the whole time (britnee)' },
  { id: 'shells', half: 'app', reason: 'a correction: these halves were skeletons the whole time (britnee)' },
  { id: 'layouts', half: 'app', reason: 'a correction: these halves were skeletons the whole time (britnee)' },
  // Found while re-checking with isSkeleton: more skeleton halves nobody had named. Same correction, flagged for review.
  { id: 'gate', half: 'app', reason: 'a correction: these halves were skeletons the whole time (britnee)' },
  { id: 'vault', half: 'app', reason: 'a correction: these halves were skeletons the whole time (britnee)' },
  { id: 'vault', half: 'cli', reason: 'a correction: these halves were skeletons the whole time (britnee)' },
  { id: 'browsers', half: 'cli', reason: 'a correction: these halves were skeletons the whole time (britnee)' },
  { id: 'mcp', half: 'cli', reason: 'a correction: these halves were skeletons the whole time (britnee)' },
  { id: 'skills', half: 'cli', reason: 'a correction: these halves were skeletons the whole time (britnee)' },
];

/**
 * Plugins that may re-enter `pending` once even though the list only shrinks: each was taken off with open work and
 * goes back on by a lead ruling. An allowed id must state at least one `pendingReasons` line, or it is still a finding.
 * An entry is inert once the base lists the id.
 */
export const ONE_TIME_PENDING_ALLOWANCE: readonly { readonly id: string; readonly reason: string }[] = [
  { id: 'terminals', reason: 'ruling #23 (britnee): left with open work, back in pending' },
  { id: 'usage', reason: 'ruling #23 (britnee): left with open work, back in pending' },
  { id: 'access', reason: 'ruling #26 (britnee): ported but unwired, back in pending' },
  { id: 'voice', reason: 'ruling #26 (britnee): ported but unwired, back in pending' },
  { id: 'warden', reason: 'ruling #26 (britnee): ported but unwired, back in pending' },
];

export interface PortsPending {
  readonly format: 1;
  readonly pending: readonly string[];
  /** Why a fully ported plugin is still listed: its open gaps, by plugin id. */
  readonly reasons: Readonly<Record<string, readonly string[]>>;
  /** The halves each plugin still has as a skeleton, by plugin id. */
  readonly halves: Readonly<Record<string, readonly string[]>>;
}

export function parsePending(text: string, where: string): PortsPending {
  const value = JSON.parse(text) as {
    format?: unknown;
    pending?: unknown;
    pendingReasons?: unknown;
    pendingHalves?: unknown;
  };
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
  const halves: Record<string, string[]> = {};
  if (value.pendingHalves !== undefined) {
    const given = value.pendingHalves;
    if (typeof given !== 'object' || given === null || Array.isArray(given))
      throw new Error(`${where}: "pendingHalves" is not an object of plugin id to halves`);
    for (const [id, list] of Object.entries(given)) {
      if (!Array.isArray(list) || list.some(half => typeof half !== 'string'))
        throw new Error(`${where}: "pendingHalves.${id}" is not a list of half names`);
      halves[id] = list as string[];
    }
  }
  return { format: 1, pending: value.pending as string[], reasons, halves };
}

export function readPending(root: string): PortsPending {
  const file = join(root, 'ports-pending.json');
  if (!existsSync(file)) return { format: 1, pending: [], reasons: {}, halves: {} };
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
      for (const id of current.pending) {
        if (before.has(id)) continue;
        if (!ONE_TIME_PENDING_ALLOWANCE.some(allowed => allowed.id === id))
          findings.push({ check, where: 'ports-pending.json', message: `${id} was added; the list may only shrink` });
        else if ((current.reasons[id]?.length ?? 0) === 0)
          findings.push({
            check,
            where: 'ports-pending.json',
            message: `${id} is back in "pending" by a one-time ruling but states no "pendingReasons" line`,
          });
      }
      for (const [id, named] of Object.entries(current.halves))
        for (const half of named)
          if (
            !(base.halves[id] ?? []).includes(half) &&
            !ONE_TIME_HALF_ALLOWANCE.some(allowed => allowed.id === id && allowed.half === half)
          )
            findings.push({
              check,
              where: 'ports-pending.json',
              message: `pendingHalves ${id} ${half} was added; pendingHalves may only shrink`,
            });
    }
    const model = await ctx.model();
    const named = readPendingApps(ctx.root).named;
    for (const id of named.keys())
      if (!model.loaded.some(s => s.id === id))
        findings.push({
          check,
          where: 'ports-pending.json',
          message: `pendingHalves names ${id}, which is not a subsystem`,
        });
    for (const subsystem of model.loaded) {
      if (subsystem.id === 'kernel') continue;
      for (const half of HALVES) {
        let skeleton = false;
        let exists = false;
        try {
          const impl = await loadHalf(subsystem.pkg, half);
          exists = impl !== undefined;
          skeleton = impl !== undefined && isSkeleton(impl);
        } catch {
          continue; // manifest-match reports the load failure
        }
        const listed = named.get(subsystem.id)?.has(half) ?? false;
        const where = `${subsystem.pkg.rel}/${half}`;
        if (skeleton && !listed)
          findings.push({
            check,
            where,
            message: `${half} half of ${subsystem.id} is a skeleton but ports-pending.json pendingHalves does not name it`,
          });
        if (listed && !skeleton)
          findings.push({
            check,
            where,
            message: `pendingHalves names the ${half} half of ${subsystem.id}, but it is ${exists ? 'a real half' : 'not a half at all'}`,
          });
      }
    }
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
