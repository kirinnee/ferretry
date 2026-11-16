/**
 * DIALOG CLEAR: a ferret parked on a harness screen a rule knows how to leave, left at once.
 *
 * ═══ WHY ═══
 *
 * A screen a key can dismiss should not wait for a person (a dangerous `rm` sat on its prompt for 1.5 minutes before
 * anyone noticed). The dialog look (`dialog-watch.ts`) already reads every ferret's recorded dialog; this is what it
 * does with the ones a rule names, in the same look, before it would tell the owner about them.
 *
 * ═══ WHAT IT DOES ═══
 *
 * For each dialog a rule fits (`dialog-rules.ts`), ONCE per episode:
 *
 *   1. reads the ferret's live frame and confirms the screen is still up (the recorded dialog can lag the pane, and Esc
 *      on a pane that moved on would interrupt a turn), the rule's fixed phrase is on it, and the runner's own reader
 *      says a dialog or prompt blocks it;
 *   2. plans the keys. No plan (a row that grants, a cursor it cannot read, no such row) leaves the dialog to the notice;
 *   3. moves the cursor, reads again and checks it is on the row — and only then confirms. Esc needs no cursor;
 *   4. writes ONE journal line (ferret, harness, kind, rule id): no agenda card, no pane text.
 *
 * The same dialog on the same ferret is never keyed twice. If the next look still sees it ON SCREEN, the keys failed and
 * the dialog is handed back to the notice path ({@link DialogClearResult.toTell}); if the frame no longer shows it, the
 * keys worked and the record was only slow. A ferret's key refused (a Vault hold) is a failure the same way.
 *
 * Never a grant: see `dialog-rules.ts`. Pure but for its ports.
 */
import type { FormKey } from '@ferretry/core-ferrets/contract';
import type { DialogRule } from '../../contract/dialog-rules.ts';
import { cursorRow, frameShows, planKeys, ruleFor } from './dialog-rules.ts';
import type { WatchedDialog } from './dialog-watch.ts';
import type { ClearableDialogWords } from './dialog-words.ts';
import type { MachineMembersStore } from './machine-notices.ts';
import { SerialQueue } from './serial-queue.ts';

/** The key the keyed episodes are kept under in the Warden's state file. */
export const DIALOG_CLEAR_REF = 'warden:dialog-clear';

/** The second member of a keyed episode that has already been reported failed, so it is journalled once. */
const FAILED = 'failed';

/** How long the pane gets to redraw after the cursor moved, before it is read again. */
const CURSOR_SETTLE_MS = 200;

/** One read of a ferret's live frame: only what the clear decides on. Never logged, never stored. */
export interface ClearFrame {
  readonly visible: string;
  /** The runner's own reader says a permission prompt or a dialog blocks the frame. */
  readonly blocking: boolean;
}

export interface DialogClearPorts {
  /** The rules in effect right now: the built-in tables and the ones the owner taught. */
  rules(): Promise<readonly DialogRule[]>;
  /** The words of the ferret's dialog, read for this press only (pane text: never logged, stored or told). */
  words(sessionId: string): Promise<ClearableDialogWords | undefined>;
  /** The ferret's live frame, or `undefined` when it cannot be read (gone, held, no pane). */
  frame(sessionId: string): Promise<ClearFrame | undefined>;
  /** Presses one key; `false` when nothing was pressed. */
  key(sessionId: string, key: FormKey): Promise<boolean>;
  sleep(ms: number): Promise<void>;
  /** `[dialogId]` per ferret already keyed this episode. */
  readonly memory: MachineMembersStore;
  record(type: string, data: Readonly<Record<string, string>>): void;
}

/** What one look did. */
export interface DialogClearResult {
  /** The dialogs that are still the notice's: no rule, no plan, or the keys already failed. */
  readonly toTell: readonly WatchedDialog[];
  /** How many ferrets had keys pressed this look. */
  readonly cleared: number;
}

export class WardenDialogClear {
  private readonly queue = new SerialQueue();

  constructor(private readonly ports: DialogClearPorts) {}

  /** Clear what a rule knows how to clear; answer what is left to tell. */
  clear(dialogs: readonly WatchedDialog[]): Promise<DialogClearResult> {
    return this.queue.run(async () => {
      const rules = await this.ports.rules();
      const memory = await this.ports.memory.read();
      const next: Record<string, readonly string[]> = {};
      const toTell: WatchedDialog[] = [];
      let cleared = 0;
      for (const watched of dialogs) {
        const { sessionId } = watched;
        // The words are read only for a screen some rule is about, and must be the very dialog the look saw.
        const read = rules.some(each => each.kind === watched.dialog.kind)
          ? await this.ports.words(sessionId)
          : undefined;
        const dialog = read?.id === watched.dialog.id ? read : undefined;
        const rule = dialog === undefined ? undefined : ruleFor(dialog, rules);
        if (dialog === undefined || rule === undefined) {
          toTell.push(watched);
          continue;
        }
        if (memory[sessionId]?.[0] === dialog.id) {
          // Keyed already. Still on screen: the keys failed, and the owner is told once. Gone from it: they worked.
          const frame = await this.ports.frame(sessionId);
          const reported = memory[sessionId]?.[1] === FAILED;
          next[sessionId] = reported ? [dialog.id, FAILED] : [dialog.id];
          if (frame !== undefined && frame.blocking && frameShows(rule, dialog, frame.visible)) {
            if (!reported) {
              next[sessionId] = [dialog.id, FAILED];
              this.ports.record('fleet.warden_dialog_clear_failed', {
                sessionId,
                harness: rule.harness,
                kind: dialog.kind,
                rule: rule.id,
              });
            }
            toTell.push(watched);
          }
          continue;
        }
        const pressed = await this.press(sessionId, dialog, rule);
        if (pressed === 'stale') continue;
        if (pressed === 'failed') {
          next[sessionId] = [dialog.id, FAILED];
          toTell.push(watched);
        } else {
          next[sessionId] = [dialog.id];
          cleared += 1;
        }
      }
      if (JSON.stringify(next) !== JSON.stringify(memory)) await this.ports.memory.write(next);
      return { toTell, cleared };
    });
  }

  /** `stale`: the frame does not show the screen, nothing was pressed. `failed`: a plan or a key did not go. */
  private async press(
    sessionId: string,
    dialog: ClearableDialogWords,
    rule: DialogRule,
  ): Promise<'sent' | 'failed' | 'stale'> {
    const frame = await this.ports.frame(sessionId);
    if (frame === undefined || !frame.blocking || !frameShows(rule, dialog, frame.visible)) return 'stale';
    const plan = planKeys(rule, dialog, frame.visible);
    if (typeof plan === 'string') {
      this.ports.record('fleet.warden_dialog_clear_skipped', {
        sessionId,
        kind: dialog.kind,
        rule: rule.id,
        why: plan,
      });
      return 'failed';
    }
    for (const move of plan.moves) if (!(await this.ports.key(sessionId, move))) return 'failed';
    if (plan.row !== undefined) {
      await this.ports.sleep(CURSOR_SETTLE_MS);
      const after = await this.ports.frame(sessionId);
      // Enter confirms whichever row the cursor is on: it must be positively on the one the rule chose.
      if (after === undefined || !after.blocking || cursorRow(after.visible, dialog) !== plan.row) return 'failed';
    }
    if (!(await this.ports.key(sessionId, plan.confirm))) return 'failed';
    this.ports.record('fleet.warden_dialog_autocleared', {
      sessionId,
      harness: rule.harness,
      kind: dialog.kind,
      rule: rule.id,
    });
    return 'sent';
  }
}
