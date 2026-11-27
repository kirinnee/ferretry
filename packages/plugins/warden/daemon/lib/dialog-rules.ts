/**
 * DIALOG RULES, applied: which rule fits a ferret's screen, and the keys that leave it.
 *
 * ═══ WHAT A RULE MAY DO ═══
 *
 * A rule DISMISSES or DECLINES. The planner is the second of three guards (the file's schema and the Warden's own tables
 * are the others; see `contract/dialog-rules.ts`): it never plans a key for a row the harness marked `grantsTrust` or
 * whose words read as a grant, however the rule was written. A screen whose only way out grants something has no plan,
 * so it stays a notice.
 *
 * ═══ WHAT A RULE MATCHES ═══
 *
 * (harness, dialog kind) and a FIXED pattern over the dialog's own title — plus, for a harness phrase that is printed on
 * the frame and recorded nowhere else, a pattern over ONE printed line of the live frame. Free pane text never picks a
 * rule: the frame is read only to confirm the screen is still up, the cursor is where the planner thinks, and a fixed
 * phrase is on it. What the frame says is never kept.
 *
 * Pure.
 */
import type { FormKey } from '@ferretry/core-ferrets/contract';
import { type DialogRule, isGrantLabel } from '../../contract/dialog-rules.ts';
import type { ClearFrame } from './dialog-clear.ts';
import type { ClearableDialogWords } from './dialog-words.ts';

/** How many of the frame's last lines a screen may sit in. */
const FRAME_WINDOW_LINES = 40;

/** The compile of a rule's patterns, case-insensitive; a pattern that does not compile matches nothing. */
function matches(source: string | undefined, text: string): boolean {
  if (source === undefined) return true;
  try {
    return new RegExp(source, 'iu').test(text);
  } catch {
    return false;
  }
}

/** The first rule that names this dialog by what Ferrets recorded of it; the live frame is checked separately. */
export function ruleFor(dialog: ClearableDialogWords, rules: readonly DialogRule[]): DialogRule | undefined {
  return rules.find(
    rule =>
      rule.kind === dialog.kind &&
      dialog.harness === rule.harness &&
      (rule.rows !== 'none' || dialog.options.length === 0) &&
      matches(rule.title, dialog.title) &&
      matches(rule.body, (dialog.body ?? '').split('\n')[0] ?? ''),
  );
}

/** The last lines of a frame that carry any words, trimmed. */
const tail = (frame: string): readonly string[] =>
  frame
    .replaceAll('\r\n', '\n')
    .split('\n')
    .map(line => line.trim())
    .filter(line => line !== '')
    .slice(-FRAME_WINDOW_LINES);

/**
 * Whether the live frame still shows what the rule names. A rule with no rows (a notice) is read from the RUNNER's own
 * reading of this very frame (`frame.dialog`: title, row count, footer) and nowhere else: the Warden keeps no screen
 * parse of its own, so it can never see a notice where the reader sees a dialog with rows.
 */
export function frameShows(rule: DialogRule, dialog: ClearableDialogWords, frame: ClearFrame): boolean {
  if (rule.rows === 'none') {
    const read = frame.dialog;
    return (
      read !== undefined && read.options === 0 && matches(rule.title, read.title) && matches(rule.text, read.footer)
    );
  }
  const lines = tail(frame.visible);
  if (rule.text !== undefined && !lines.some(line => matches(rule.text, line))) return false;
  if (rule.text === undefined && !lines.some(line => line.includes(dialog.title.slice(0, 40).trim()))) return false;
  return true;
}

/** One row of the cursor's view: which of the dialog's rows the live frame draws the cursor on, or `undefined`. */
export function cursorRow(frame: string, dialog: ClearableDialogWords): number | undefined {
  const found = new Set<number>();
  for (const line of tail(frame)) {
    const drawn = /^[❯›>»▌]\s*(?:[1-9][.)]\s+)?(\S.*)$/u.exec(line);
    if (drawn === null) continue;
    const text = (drawn[1] as string).trim();
    const row = dialog.options.find(option => option.label === text || text.startsWith(option.label));
    if (row !== undefined) found.add(row.number);
  }
  return found.size === 1 ? [...found][0] : undefined;
}

/** What to press, and which row the cursor must be on before the last key (absent for Esc). */
export interface KeyPlan {
  /** Moves of the cursor, then the confirming key. */
  readonly moves: readonly FormKey[];
  readonly confirm: FormKey;
  /** The row Enter confirms; `undefined` for Esc. */
  readonly row?: number;
}

/** Why no keys were planned. */
export type NoPlan = 'no-escape' | 'no-row' | 'grants' | 'cursor-unknown';

/**
 * The keys that leave `dialog` the way `rule` says, given the live frame. A permission prompt (`kind: 'permission'`) is
 * refused with Esc alone, and Esc is the only action it has. A choice is the arrows from where the cursor is, then Enter.
 */
export function planKeys(rule: DialogRule, dialog: ClearableDialogWords, frame: string): KeyPlan | NoPlan {
  if ('press' in rule.action) {
    // Esc is a decline on a permission prompt, and on a dialog only when its footer offers it.
    return dialog.kind === 'permission' || dialog.escape !== undefined ? { moves: [], confirm: 'Escape' } : 'no-escape';
  }
  const wanted = rule.action.choose.trim().toLowerCase();
  const rows = dialog.options.filter(option => option.label.trim().toLowerCase() === wanted);
  if (rows.length !== 1) return 'no-row';
  const row = rows[0] as (typeof rows)[number];
  if (isGrantLabel(row.label, row.grantsTrust)) return 'grants';
  const at = cursorRow(frame, dialog);
  if (at === undefined) return 'cursor-unknown';
  const delta = row.number - at;
  const moves: FormKey[] = Array.from({ length: Math.abs(delta) }, () => (delta > 0 ? 'Down' : 'Up'));
  return { moves, confirm: 'Enter', row: row.number };
}
