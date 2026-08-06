/**
 * Driving Codex's native picker to an EXACT model and reasoning level.
 *
 * Codex offers no command that takes a model as an argument, so the only way to change the model of
 * a live session is to send keystrokes into its own modal. That makes this the most dangerous write
 * in the daemon, and every rule below exists because the alternative selects the wrong thing:
 *
 *   * NO ARROWS, NO ENTER, NO ASSUMED ORDERING. Every key is a digit derived from a row that was
 *     positively read off a positively identified screen. A row past the ninth is refused rather
 *     than reached by counting arrow presses — failing visibly beats selecting a neighbour.
 *   * THE SCREEN IS RE-READ BEFORE EVERY KEY. The transport is handed the exact row it is addressing
 *     and checks the pane still shows it; the picker is asynchronous, and a digit typed into a
 *     screen that has since changed picks whatever now sits in that position.
 *   * THE QUICK PICKER IS REFUSED WHEN IT CANNOT EXPRESS THE TARGET. Choosing a quick row applies
 *     that model's preset level directly whenever the row has no advanced level to reach, so a
 *     request for a different level would be silently lost. Preflight reads the real screen and
 *     refuses before a single digit is sent — but ONLY for a row that is actually visible in the
 *     quick list, because the same model reached through `All models` shows the normal level screen.
 *
 * BOUNDED BY OBSERVATIONS, NOT BY A DEADLINE, for the reason picker cleanup is: a wall clock makes
 * the number of keys sent into a live pane depend on how loaded the host is, and turns "Codex never
 * opened its picker" and "the box was busy for four seconds" into the same failure.
 */

import type { InjectionOutcome } from '../../tmux/delivery.ts';
import { type CodexPickerRow, type CodexPickerScreen, parseCodexPickerScreen, pickerRowFor } from './picker-screen.ts';
import { ADVANCED_EFFORTS, type CodexPickerTarget } from './runtime-switch.ts';

/** One frame of the pane the picker is on. */
export interface CodexPickerFrame {
  readonly alive: boolean;
  readonly dead: boolean;
  readonly promptReady: boolean;
  readonly visible: string;
}

/** The exact row a queued keystroke is aimed at, re-verified by the transport before it is sent. */
export interface CodexPickerKeyExpectation {
  readonly kind: CodexPickerScreen['kind'];
  readonly title?: string;
  readonly row: CodexPickerRow;
}

/** The IO seam the driver needs, so the decisions above never learn what a terminal is. */
export interface CodexPickerDrivePort {
  /** Type the picker-opening command. `turn-started` means Codex read it as a message instead. */
  openPicker(): Promise<InjectionOutcome>;
  readPane(): Promise<CodexPickerFrame>;
  /** Send one digit to the exact pane, refusing if the pane no longer shows `expected`. */
  sendKey(key: string, expected: CodexPickerKeyExpectation): Promise<void>;
}

/** Redraw allowance between observations, and the ceiling on how many are taken. */
export interface PickerDrivePolicy {
  readonly settleMs: number;
  readonly maxObservations: number;
}

export const defaultPickerDrivePolicy: PickerDrivePolicy = { settleMs: 50, maxObservations: 80 };

/** Sleeping is a capability, not a decision. */
export interface PickerSleeper {
  sleep(milliseconds: number): Promise<void>;
}

/** A picker drive that did not reach its target. Always paired with cleanup by the caller. */
export class CodexPickerDriveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CodexPickerDriveError';
  }
}

/**
 * The row label Codex renders for a reasoning level.
 *
 * A table rather than a capitalisation rule: `xhigh` renders as `Extra high`, and a rule that got
 * that one wrong would send a digit for a row that is not the one it names. An unknown level falls
 * through unchanged so a level this table has not learned still gets an exact-match attempt rather
 * than a mangled one.
 */
const EFFORT_LABELS: Readonly<Record<string, string>> = {
  none: 'None',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
  ultra: 'Ultra',
};

export function codexEffortLabel(effort: string): string {
  return EFFORT_LABELS[effort] ?? effort;
}

/** The `All models` row, and the submenu row that reaches the advanced levels. */
const ALL_MODELS_ROW = 'All models';
const MORE_REASONING_ROW = 'More reasoning…';
/** Codex asks which scopes a level change applies to when the session is in Plan mode. */
const PLAN_SCOPE_ROW = 'Apply to global default and Plan mode override';

/** Row names are matched case-insensitively: Codex title-cases them and a catalog value need not. */
function rowNamed(screen: CodexPickerScreen, name: string): CodexPickerRow | undefined {
  const exact = pickerRowFor(screen, name);
  if (exact !== undefined) return exact;
  const wanted = name.trim().toLocaleLowerCase();
  return screen.rows.find(row => row.name.toLocaleLowerCase() === wanted);
}

/**
 * Why the visible quick picker cannot express this target, if it cannot.
 *
 * Only a target that is a VISIBLE quick row is judged here. A model absent from the quick list is
 * reached through `All models`, whose flow shows the ordinary level screen, so it stays eligible.
 *
 * THE VERDICT COMES FROM THE PLANNER'S FLAG, NOT FROM THE PRESET'S NAME. Judging by the name read an
 * account that advertises levels and no default as "no mismatch" — the very case the planner marks
 * for preflight — so the row was selected, Codex applied whatever preset it liked, the picker
 * returned to a prompt, and the daemon reported the level the caller asked for on a session that was
 * not running it. An unknown preset is refused for the same reason a differing one is: neither can
 * be shown to be the requested effort.
 */
export function quickPickerRefusal(screen: CodexPickerScreen, target: CodexPickerTarget): string | undefined {
  if (screen.kind !== 'quick-models' || rowNamed(screen, target.model) === undefined) return undefined;
  if (target.quickPickerAppliesPreset !== true) return undefined;
  const preset =
    target.quickPickerDefaultEffort === undefined
      ? 'a reasoning level this account does not advertise'
      : `its default ${target.quickPickerDefaultEffort} reasoning level`;
  return `Codex quick picker can only apply ${preset} for ${target.model}, not ${target.effort}`;
}

export class CodexModelPickerDriver {
  constructor(
    private readonly transport: CodexPickerDrivePort,
    private readonly sleeper: PickerSleeper,
    private readonly policy: PickerDrivePolicy = defaultPickerDrivePolicy,
  ) {}

  /**
   * Open the picker and read it WITHOUT selecting anything.
   *
   * Its answer is the screen {@link drive} then starts from, so the target is judged against the
   * pane that was actually rendered rather than against the catalog's description of it.
   */
  async preflight(target: CodexPickerTarget): Promise<CodexPickerScreen> {
    const opened = await this.transport.openPicker();
    if (opened !== 'handled-local')
      throw new CodexPickerDriveError('Codex consumed the picker command as a model turn instead of opening a picker');
    const screen = await this.#await(
      (candidate, frame) =>
        !frame.promptReady && (candidate.kind === 'quick-models' || candidate.kind === 'all-models'),
      'a model list',
    );
    this.#assertExpressible(screen, target);
    return screen;
  }

  /**
   * Reach the target, or throw with the stage that was not reached.
   *
   * Success means the picker positively returned to a parsed idle prompt. It does NOT mean Codex has
   * applied the setting: that is proved by the session's own observed runtime, which the caller
   * reads afterwards, and claiming it here would be the daemon asserting an outcome it did not see.
   */
  async drive(target: CodexPickerTarget, preflighted?: CodexPickerScreen): Promise<void> {
    let screen = preflighted ?? (await this.preflight(target));
    // Re-asserted for a caller that supplied its own screen: the invariant must not be bypassable by
    // passing preflight in.
    this.#assertExpressible(screen, target);

    if (screen.kind === 'quick-models' && rowNamed(screen, target.model) === undefined) {
      await this.#choose(screen, ALL_MODELS_ROW, 'the quick model list');
      screen = await this.#await(candidate => candidate.kind === 'all-models', 'the full model list');
    }
    await this.#choose(screen, target.model, 'the model list');

    const levels = `reasoning choices for ${target.model}`;
    let next = await this.#await(
      (candidate, frame) =>
        candidate.kind === 'reasoning' ||
        candidate.kind === 'plan-scope' ||
        (candidate.kind === 'none' && frame.promptReady),
      levels,
    );
    if (next.kind === 'reasoning') {
      if (ADVANCED_EFFORTS.includes(target.effort)) {
        await this.#choose(next, MORE_REASONING_ROW, levels);
        next = await this.#await(candidate => candidate.kind === 'advanced-reasoning', 'advanced reasoning choices');
      }
      await this.#choose(next, codexEffortLabel(target.effort), levels);
      next = await this.#await(
        (candidate, frame) => candidate.kind === 'plan-scope' || (candidate.kind === 'none' && frame.promptReady),
        'the applied setting',
      );
    }
    if (next.kind === 'plan-scope') {
      await this.#choose(next, PLAN_SCOPE_ROW, 'the Plan-mode scope prompt');
      await this.#await(
        (candidate, frame) => candidate.kind === 'none' && frame.promptReady,
        'the applied setting to return to an idle prompt',
      );
    }
  }

  #assertExpressible(screen: CodexPickerScreen, target: CodexPickerTarget): void {
    const refusal = quickPickerRefusal(screen, target);
    if (refusal !== undefined) throw new CodexPickerDriveError(refusal);
  }

  /** Observe until `accept` holds, or until the observation budget is spent. */
  async #await(
    accept: (screen: CodexPickerScreen, frame: CodexPickerFrame) => boolean,
    stage: string,
  ): Promise<CodexPickerScreen> {
    let last = 'no picker';
    for (let observation = 0; observation < this.policy.maxObservations; observation++) {
      const frame = await this.transport.readPane();
      if (!frame.alive || frame.dead) throw new CodexPickerDriveError(`Codex exited while reaching ${stage}`);
      const screen = parseCodexPickerScreen(frame.visible);
      last = screen.title ?? (frame.promptReady ? 'idle prompt' : 'unknown screen');
      if (accept(screen, frame)) return screen;
      await this.sleeper.sleep(this.policy.settleMs);
    }
    throw new CodexPickerDriveError(
      `Codex did not reach ${stage} within ${this.policy.maxObservations} observations (last: ${last})`,
    );
  }

  /** Send the digit for one named row on the CURRENT screen. */
  async #choose(screen: CodexPickerScreen, name: string, stage: string): Promise<void> {
    const row = rowNamed(screen, name);
    if (row === undefined) throw new CodexPickerDriveError(`Codex picker did not offer ${name} on ${stage}`);
    // Codex's list accepts single-digit shortcuts only. Do not degrade into arrow counting if a
    // catalog grows past nine: failing visibly is safer than selecting the wrong model.
    if (row.number > 9)
      throw new CodexPickerDriveError(`Codex picker row ${row.number} for ${name} is not safely addressable`);
    await this.transport.sendKey(String(row.number), {
      kind: screen.kind,
      ...(screen.title === undefined ? {} : { title: screen.title }),
      row,
    });
  }
}
