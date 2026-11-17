/**
 * `ports-pending` (§7.9, spine §7): the pending ledger (ONE FILE PER OPEN LINE under each owning package's
 * `ports-pending/` folder, plus a root `ports-pending/unwired/`; the rule is in `scripts/gen/lib/pending-files.ts`) grows
 * (against the base ref, default `origin/rebuild/5.0`), names an id that is no subsystem, or holds a line some other
 * owner keeps. A port removes its own line files in the same branch.
 *
 * A plugin is pending while it holds at least one gap file (`ports-pending/<slug>.txt`); a plugin whose halves are all
 * ported but whose port still has named gaps open stays pending through them. A plugin that is not pending in the base
 * may not gain a gap (the list only shrinks), apart from `ONE_TIME_PENDING_ALLOWANCE`.
 *
 * Two-way skeleton rule: `halves/<half>.txt` names exactly the halves that are skeletons. A skeleton half it does not
 * name is a finding, and so is a name for a half that is real (or for a half that does not exist). The halves also only
 * shrink against the base, apart from the one-time corrections in `ONE_TIME_HALF_ALLOWANCE`.
 */
import { isSkeleton } from '../gen/lib/halves.ts';
import { type Check, type Finding, runMain } from '../gen/lib/check.ts';
import {
  PENDING_FILE,
  readPendingEntries,
  readPendingMerged,
  readPendingMergedBase,
} from '../gen/lib/pending-files.ts';
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
  { id: 'projects', reason: 'ruling #28 (britnee): ported but unwired, back in pending' },
  { id: 'updates', reason: 'ruling #28 (britnee): ported but unwired, back in pending' },
  {
    id: 'vault',
    reason: 'ruling (britnee): left pending with its app and cli halves still skeletons, back in pending',
  },
  {
    id: 'lessons',
    reason: 'kac2 R5 ruling (britnee): GAP(lessons) is Lessons own launch flag, owner nelly, back in pending',
  },
];

export interface PortsPending {
  readonly format: 1;
  readonly pending: readonly string[];
  /** Why a fully ported plugin is still listed: its open gaps, by plugin id. */
  readonly reasons: Readonly<Record<string, readonly string[]>>;
  /** The halves each plugin still has as a skeleton, by plugin id. */
  readonly halves: Readonly<Record<string, readonly string[]>>;
  /** The slug (file name) of each of a plugin's gap lines, in the order of `reasons`: what an `@pending <id>/<slug>` tag names. */
  readonly slugs: Readonly<Record<string, readonly string[]>>;
}

export function parsePending(text: string, where: string): PortsPending {
  const value = JSON.parse(text) as {
    format?: unknown;
    pending?: unknown;
    pendingReasons?: unknown;
    pendingHalves?: unknown;
    pendingSlugs?: unknown;
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
  const slugs = (value.pendingSlugs ?? {}) as Record<string, string[]>;
  return { format: 1, pending: value.pending as string[], reasons, halves, slugs };
}

/** Every pending file of the tree, merged: a line named in two files throws. */
export function readPending(root: string): PortsPending {
  return parsePending(readPendingMerged(root), PENDING_FILE);
}

/** The base lists: a git ref's committed pending files, or `file:<path>` (a file or a tree; tests, a release compare). */
function readBase(root: string, ref: string): PortsPending | undefined {
  try {
    const text = readPendingMergedBase(root, ref);
    return text === undefined ? undefined : parsePending(text, `${ref}:${PENDING_FILE}`);
  } catch {
    return undefined; // an unreadable base proves nothing here
  }
}

/** An `unwired` seam that names a file inside a package: `code:packages/<core|plugins>/<id>/…`. Group 1 is the owner. */
const PACKAGE_SEAM = /^code:packages\/(?:core|plugins)\/([^/]+)\//u;

/** Findings for a file outside the rule, a malformed one, or one that holds a line some other owner keeps. */
export function ownershipFindings(root: string): Finding[] {
  const check = 'ports-pending';
  const findings: Finding[] = [];
  for (const entry of readPendingEntries(root)) {
    const { where, owner } = entry;
    const add = (message: string): number => findings.push({ check, where, message });
    if (entry.problem !== undefined) {
      add(entry.problem);
      continue;
    }
    if (entry.kind === 'app-port') {
      const plugin = (JSON.parse(entry.text) as { plugin?: unknown }).plugin;
      if (plugin !== owner)
        add(
          `holds ${String(plugin)}'s app port; this folder is ${owner}'s, move it to ${String(plugin)}'s own ports-pending/`,
        );
      continue;
    }
    if (entry.kind !== 'unwired') continue;
    const seam = (JSON.parse(entry.text) as { seam?: unknown }).seam;
    if (typeof seam !== 'string') {
      add('an "unwired" entry has no "seam" text');
      continue;
    }
    // A seam naming a file inside a package belongs to that package's folder; hooks and the like are repo-wide.
    const seamOwner = PACKAGE_SEAM.exec(seam)?.[1];
    if (seamOwner !== undefined && seamOwner !== owner)
      add(
        `holds the "unwired" seam ${seam}, which is ${seamOwner}'s; ${
          owner === undefined ? 'the root folder keeps only repo-wide seams' : `this folder is ${owner}'s`
        }, move it to ${seamOwner}'s own ports-pending/unwired/`,
      );
  }
  return findings;
}

export const check: Check = {
  name: 'ports-pending',
  summary: 'the ports-pending/ ledger only shrinks and lists only skeletons',
  async run(ctx) {
    const check = 'ports-pending';
    // A file outside the rule or a malformed one cannot be merged: name each of them and stop.
    const misplaced = ownershipFindings(ctx.root);
    if (misplaced.length > 0) return misplaced;
    const findings: Finding[] = [];
    let current: PortsPending;
    try {
      current = readPending(ctx.root);
    } catch (error) {
      return [{ check, where: PENDING_FILE, message: error instanceof Error ? error.message : String(error) }];
    }
    const base = readBase(ctx.root, ctx.base ?? 'origin/rebuild/5.0');
    if (base !== undefined) {
      const before = new Set(base.pending);
      for (const id of current.pending) {
        if (before.has(id)) continue;
        if (!ONE_TIME_PENDING_ALLOWANCE.some(allowed => allowed.id === id))
          findings.push({ check, where: PENDING_FILE, message: `${id} gained a gap line; the list may only shrink` });
      }
      for (const [id, named] of Object.entries(current.halves))
        for (const half of named)
          if (
            !(base.halves[id] ?? []).includes(half) &&
            !ONE_TIME_HALF_ALLOWANCE.some(allowed => allowed.id === id && allowed.half === half)
          )
            findings.push({
              check,
              where: PENDING_FILE,
              message: `pendingHalves ${id} ${half} was added; pendingHalves may only shrink`,
            });
    }
    const model = await ctx.model();
    const named = readPendingApps(ctx.root).named;
    for (const id of named.keys())
      if (!model.loaded.some(s => s.id === id))
        findings.push({
          check,
          where: PENDING_FILE,
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
            message: `${half} half of ${subsystem.id} is a skeleton but ports-pending/halves/${half}.txt does not name it`,
          });
        if (listed && !skeleton)
          findings.push({
            check,
            where,
            message: `pendingHalves names the ${half} half of ${subsystem.id}, but it is ${exists ? 'a real half' : 'not a half at all'}`,
          });
      }
    }
    for (const id of current.pending)
      if (!model.loaded.some(s => s.id === id))
        findings.push({ check, where: PENDING_FILE, message: `${id} is not a subsystem in this workspace` });
    return findings;
  },
};

if (import.meta.main) await runMain(check, process.argv.slice(2));
