import { isAbsolute, normalize, parse, relative, sep } from 'node:path';
import type { DaemonLayout } from './layout.ts';
import type { ResetTreeMeasure } from './ports.ts';
import { megabytes } from './render.ts';

/**
 * WHAT A RESET IS, AND WHY IT IS A COMMAND RATHER THAN AN INSTRUCTION.
 *
 * A Ferretry installation occupies TWO trees, and the second one is not where anybody looks. Clearing
 * only the first leaves an owner running an executable pinned in the second, which is exactly what
 * happened: the machine came back up on a daemon from weeks earlier and nothing said so. An
 * instruction in a README is an instruction that reproduces that mistake once per person; a verb that
 * derives both trees from the layout the daemon itself resolves cannot.
 *
 * NOTHING HERE TOUCHES THE FILESYSTEM. This module decides which trees are in play, refuses the ones
 * that cannot possibly be Ferretry's, and turns a measurement into the sentences somebody reads before
 * they authorize it. The removal is a port, and the ORDER — measure, show, ask, stop the daemon,
 * remove — belongs to the controller.
 */

/** One tree a reset removes, with the words a person reads it under. */
export interface ResetRoot {
  /** Which half of the installation this is, in the preflight's own vocabulary. */
  readonly label: string;
  /** What is inside it, so the line is checkable by somebody who has never looked in this directory. */
  readonly holds: string;
  readonly path: string;
}

/**
 * The two trees a reset removes, derived from the layout and from nothing else.
 *
 * Both come off `DaemonLayout`, which is the SAME derivation the daemon resolves its own home from
 * and the same one `install`, `start` and `restart` address. A reset that rebuilt either path from
 * `HOME` and a literal would delete a different installation from the one this CLI manages the moment
 * an operator pinned `FY_HOME` — and pinning `FY_HOME` is precisely how somebody ends up with a
 * second installation worth resetting.
 */
export function resetRoots(layout: DaemonLayout): readonly [ResetRoot, ResetRoot] {
  return [
    {
      label: `${layout.daemonName} state home`,
      holds: 'config, fleet, sessions, secrets, paired devices, the operator password, logs',
      path: layout.stateHome,
    },
    {
      label: `${layout.product} installation artifacts`,
      holds: 'Nix garbage-collection roots, and the retired daemon snapshot store on an upgraded host',
      path: layout.stateArtifactRoot,
    },
  ];
}

/** Raised when a reset will not run, naming the root it refused and why. */
export class ResetRefusedError extends Error {
  constructor(reason: string) {
    super(`refusing to reset: ${reason}`);
    this.name = 'ResetRefusedError';
  }
}

/**
 * How many path segments a directory has below its filesystem root.
 *
 * The count is what the shallowness guard is expressed in, because "not the filesystem root" is not a
 * strong enough statement on its own: `/ferretry` satisfies it and is not a directory any installation
 * of this ever creates.
 */
function depthBelowRoot(path: string): number {
  const root = parse(path).root;
  const rest = path.slice(root.length);
  return rest === '' ? 0 : rest.split(sep).filter(segment => segment !== '').length;
}

/**
 * Is `candidate` inside `root`?
 *
 * Purely textual, on already-normalized absolute paths, and that is the right level: it answers
 * "did this path escape the tree it was derived from", which is a question about the derivation. A
 * link pointing out of the tree is a different question and is answered by never following one.
 */
function containsPath(root: string, candidate: string): boolean {
  const rest = relative(root, candidate);
  return rest !== '' && !rest.startsWith('..') && !isAbsolute(rest);
}

/**
 * Refuse any root that cannot be a Ferretry directory, BEFORE a single entry is measured.
 *
 * Every rule here exists because a reachable input reaches it. `FY_HOME` and `XDG_STATE_HOME` are
 * operator-supplied, and a reset is the one verb where a wrong answer is unrecoverable — so this
 * refuses rather than sanitizes, and the refusal names the root and the reason so the fix is obvious:
 *
 * - **Not normalized, or not absolute.** A path holding `..` is a path whose meaning depends on where
 *   it is evaluated, and a removal must not be steerable by a working directory.
 * - **Shallower than two segments.** `/ferretry` and `/tmp` are not installations.
 * - **The home directory, or an ancestor of it.** `FY_HOME=$HOME` is a typo somebody will make, and
 *   the consequence of not catching it is the user's entire home directory.
 * - **One root inside the other, or the two equal.** Removing the outer removes the inner, so a
 *   nested pair would report one tree twice and destroy more than either line claimed.
 *
 * The home-directory rules are the reason `DaemonLayout` carries `homeDirectory` at all: a guard
 * cannot compare against a value it was never handed.
 */
export function assertResettableRoots(roots: readonly ResetRoot[], homeDirectory: string): void {
  const home = normalize(homeDirectory);
  for (const root of roots) {
    if (!isAbsolute(root.path) || normalize(root.path) !== root.path) {
      throw new ResetRefusedError(`the ${root.label} at ${root.path} is not a normalized absolute path`);
    }
    if (depthBelowRoot(root.path) < 2) {
      throw new ResetRefusedError(
        `the ${root.label} at ${root.path} is too close to the filesystem root to be a Ferretry directory`,
      );
    }
    if (root.path === home) {
      throw new ResetRefusedError(`the ${root.label} resolves to the home directory itself (${root.path})`);
    }
    if (containsPath(root.path, home)) {
      throw new ResetRefusedError(`the ${root.label} at ${root.path} contains the home directory ${home}`);
    }
  }
  for (const root of roots) {
    for (const other of roots) {
      if (root === other) continue;
      if (root.path === other.path) {
        throw new ResetRefusedError(`the ${root.label} and the ${other.label} are the same path (${root.path})`);
      }
      if (containsPath(root.path, other.path)) {
        throw new ResetRefusedError(`the ${root.label} at ${root.path} contains the ${other.label} at ${other.path}`);
      }
    }
  }
}

/** What one root holds right now, measured while everything is still there. */
export interface ResetSurvey {
  readonly root: ResetRoot;
  readonly measure: ResetTreeMeasure;
}

/**
 * What a reset destroys that nothing brings back, counted from the daemon that still holds it.
 *
 * Asked of the RUNNING daemon rather than counted off the disk, because the daemon owns this state and
 * the CLI does not read it — that seam is what the package split exists to enforce, and a reset is not
 * the verb that gets to be the exception. The consequence is honest and stated in the preflight: a
 * daemon that is already down cannot be asked, so the counts are absent and the sizes are still exact.
 */
interface ResetInventory {
  readonly secrets: number;
  readonly devices: number;
  readonly sessions: number;
}

/** Everything a person is shown before they are asked whether to go ahead. */
export interface ResetPlan {
  readonly daemon: string;
  readonly surveys: readonly ResetSurvey[];
  /** Absent when the daemon was not running, so nothing inside could be counted. */
  readonly inventory: ResetInventory | undefined;
  /** Named because it SURVIVES. Somebody who has just destroyed state needs to know what they kept. */
  readonly survivors: readonly string[];
}

/**
 * What a reset does NOT touch, spelled from the layout so it cannot promise something untrue.
 *
 * The service definition is named on every platform that has one because a reset deliberately LEAVES
 * supervision installed: the point of the verb is a machine that comes back up, and removing the unit
 * would turn a reset into a reinstall. Removing supervision is `uninstall`, which already exists.
 */
export function resetSurvivors(layout: DaemonLayout): readonly string[] {
  const definition =
    layout.manager === 'systemd'
      ? layout.systemdUnitFile
      : layout.manager === 'launchd'
        ? layout.launchAgentFile
        : undefined;
  return [
    `the installed ${layout.daemonName} and client executables, wherever the package manager put them`,
    ...(definition === undefined
      ? []
      : [`any user service definition at ${definition} — supervision stays installed, so a start still works`]),
    'every file outside the two paths above, including every repository and worktree a session was working in',
  ];
}

/** One measured root, as the line a person scans for the size and the surprise. */
function surveyLine(survey: ResetSurvey): string {
  const measure = survey.measure;
  const size =
    measure.kind === 'absent'
      ? 'absent — nothing to remove'
      : `${String(measure.files)} files, ${megabytes(measure.bytes)}`;
  return [`  ${survey.root.path}`, `    ${survey.root.label} — ${survey.root.holds}`, `    ${size}`].join('\n');
}

/** Links inside a root that point out of it, named so nobody has to trust that they are not followed. */
function escapeLines(surveys: readonly ResetSurvey[]): readonly string[] {
  const escaping = surveys.flatMap(survey =>
    survey.measure.kind === 'absent' ? [] : survey.measure.escapingLinks.map(link => `  ${link}`),
  );
  if (escaping.length === 0) return [];
  return [
    '',
    `${String(escaping.length)} symbolic link(s) inside these paths point outside them. Each link is`,
    'unlinked; NOTHING it points at is read, followed or removed:',
    ...escaping,
  ];
}

/** The unrecoverable half of the plan, which is the half somebody aborts on. */
function inventoryLines(daemon: string, inventory: ResetInventory | undefined): readonly string[] {
  if (inventory === undefined) {
    return [
      `  every secret, paired device and session in the paths above — ${daemon} is not running,`,
      '  so they cannot be counted; the paths and their sizes above are still exact',
      '  the operator password, so this machine has none afterwards',
    ];
  }
  return [
    `  ${String(inventory.secrets)} secret(s) — the values, not just the names`,
    `  ${String(inventory.devices)} paired device(s), each of which has to be paired again`,
    `  ${String(inventory.sessions)} session(s), with their transcripts`,
    '  the operator password, so this machine has none afterwards',
  ];
}

/**
 * The preflight: every path, its size, what cannot be recovered, and what survives.
 *
 * PRINTED BEFORE THE CONFIRMATION IS ASKED FOR, which is the whole point of it. "3 paired devices" is
 * a fact somebody can abort on without having known it beforehand, and it is unavailable to them
 * anywhere else — there is no command that lists what a reset would cost.
 */
export function renderResetPlan(plan: ResetPlan): string {
  return [
    `${plan.daemon} reset will remove ${String(plan.surveys.length)} path(s):`,
    ...plan.surveys.map(surveyLine),
    '',
    'It destroys, permanently, with no backup:',
    ...inventoryLines(plan.daemon, plan.inventory),
    '',
    'It does NOT touch:',
    ...plan.survivors.map(survivor => `  ${survivor}`),
    ...escapeLines(plan.surveys),
  ].join('\n');
}

/**
 * What a completed reset says: what actually went, and the one command that brings the machine back.
 *
 * The numbers are the REMOVAL's own, not the preflight's. The preflight measured a running daemon that
 * was still writing, so reporting those figures as the outcome would report a count nobody took.
 */
export function renderResetOutcome(daemon: string, removals: readonly ResetSurvey[], clientName: string): string {
  const removed = removals.filter(removal => removal.measure.kind !== 'absent');
  const total = (pick: (measure: Extract<ResetTreeMeasure, { kind: 'measured' }>) => number): number =>
    removed.reduce((sum, removal) => sum + (removal.measure.kind === 'absent' ? 0 : pick(removal.measure)), 0);
  const files = total(measure => measure.files);
  const bytes = total(measure => measure.bytes);
  return [
    removed.length === 0
      ? `${daemon} had no persistent data on this host; nothing was removed`
      : `${daemon} reset: removed ${String(removed.length)} path(s), ${String(files)} files, ${megabytes(bytes)}`,
    ...removals.map(removal => `  ${removal.measure.kind === 'absent' ? 'absent ' : 'removed'} ${removal.root.path}`),
    `Run \`${clientName} daemon start\` to bring ${daemon} up on a clean slate. It will offer to set this`,
    'machine a new operator password, exactly as a fresh install does.',
  ].join('\n');
}
