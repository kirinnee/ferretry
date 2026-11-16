/**
 * DIALOG WATCH: a ferret parked on a harness screen nobody pre-answered, told to its owner ONCE.
 *
 * ═══ WHY ═══
 *
 * Ferretry pre-answers every harness screen it can in the ferret's own home (folder trust, the bypass warning,
 * onboarding, notices — see docs/launch-settings.md). A screen it cannot pre-answer (an MCP server approval, a
 * hooks review, a settings error, an update, a sign-in, a screen this build has no name for) still stops the ferret
 * until somebody presses a key, and a ferret nobody is watching would sit there for hours. The ferret's own state
 * already carries the screen as data (`harnessDialog`); this is the Warden's one read of it.
 *
 * ═══ WHAT IT DOES ═══
 *
 * ONE notice per ferret per dialog EPISODE, never one per sweep:
 *
 * - An episode is one dialog (its id digests everything a person decides on, never where the cursor is) standing on
 *   one ferret. The same dialog on the same ferret on the next look is the same episode: nothing is raised again,
 *   however often the owner closes the notice.
 * - A look that sees no dialog does not end the episode at once — a redraw can hide the screen for a tick — it ends
 *   after {@link GONE_LOOKS} looks in a row. The notice is closed then, and a dialog that comes back is a new episode.
 * - A DIFFERENT dialog on the same ferret closes the old notice and opens a new one.
 * - The usage-limit dialog is NOT this module's: a spent login is the auto-move's (`auto-move.ts`).
 *
 * The Warden never answers a dialog. A notice tells the owner what the screen says, which rows trust something to
 * run, and that the ferret waits until they choose.
 *
 * Pure but for its ports.
 */
import { z } from 'zod';
import { clipAtWord, MAX_AGENDA_DETAIL_LENGTH, MAX_AGENDA_SUBJECT_LENGTH } from './protocol.ts';
import type { MachineMembersStore } from './machine-notices.ts';
import { SerialQueue } from './serial-queue.ts';

/** The key the episodes are kept under in the Warden's state file (not an agenda item: nothing is listed on it). */
export const DIALOG_WATCH_REF = 'warden:dialog-watch';

/** How many looks in a row must see no dialog before the episode is over. */
export const GONE_LOOKS = 2;

/** The dialog kind this module leaves to the auto-move: a login out of spend or usage. */
const USAGE_LIMIT = 'usage-limit';

/** The words of the dialog the Warden reads off a ferret's state: only what the notice says. */
export const WatchedDialogSchema = z.looseObject({
  id: z.string().min(1),
  harness: z.string().optional(),
  kind: z.string().min(1),
  title: z.string().min(1),
  body: z.string().optional(),
  options: z
    .array(z.looseObject({ number: z.number(), label: z.string(), grantsTrust: z.boolean().optional() }))
    .default([]),
  escape: z.string().optional(),
});
export type WatchedDialogWords = z.infer<typeof WatchedDialogSchema>;

/** A tool-permission prompt (Ferrets' `permissionRequest`): only what a notice says of it. */
const WatchedPermissionSchema = z.looseObject({
  id: z.string().min(1),
  harness: z.string().optional(),
  tool: z.string().min(1),
  action: z.string().optional(),
  what: z.string().optional(),
  question: z.string().min(1),
  options: z.array(z.looseObject({ number: z.number(), label: z.string() })).default([]),
});

/**
 * A tool-permission prompt, said as a dialog (kind `permission`): it stops a ferret exactly as a screen does, and the
 * notice says the same things — what is asked, the rows, and that the Warden never picks one. `undefined` when
 * `permissionRequest` does not read as a prompt.
 */
export function permissionAsDialog(permissionRequest: unknown): WatchedDialogWords | undefined {
  const read = WatchedPermissionSchema.safeParse(permissionRequest);
  if (!read.success) return undefined;
  const { id, harness, tool, action, what, question, options } = read.data;
  return {
    id,
    ...(harness === undefined ? {} : { harness }),
    kind: 'permission',
    title: question,
    body: `${tool}${action === undefined ? '' : ` wants to ${action}`}${what === undefined ? '' : `: ${what}`}`,
    options: options.map(option => ({ number: option.number, label: option.label })),
  };
}

/** One ferret and the dialog it is parked on, as the Warden reads it. */
export interface WatchedDialog {
  readonly sessionId: string;
  readonly name: string;
  readonly dialog: WatchedDialogWords;
}

/** The ref a dialog's notice stands under on its ferret's board: one per dialog. */
export const dialogNoticeRef = (dialogId: string): string => `warden-dialog:${dialogId}`;

/** What one notice says. */
export interface DialogNotice {
  readonly sessionId: string;
  readonly dialogId: string;
  readonly ref: string;
  readonly subject: string;
  readonly why: string;
  readonly howToResolve: string;
  readonly context: string;
}

/** The notice for one dialog, in the dialog's own words and with what to do. */
export function dialogNotice(watched: WatchedDialog): DialogNotice {
  const { dialog, name, sessionId } = watched;
  const harness = dialog.harness === 'codex' ? 'Codex' : dialog.harness === undefined ? 'its' : 'Claude Code';
  const rows = dialog.options.map(
    option => `${option.number}. ${option.label}${option.grantsTrust === true ? ' (trusts something to run)' : ''}`,
  );
  const said = [dialog.body, ...(rows.length === 0 ? [] : ['Choices:', ...rows])].filter(
    (part): part is string => part !== undefined && part !== '',
  );
  return {
    sessionId,
    dialogId: dialog.id,
    ref: dialogNoticeRef(dialog.id),
    subject: clipAtWord(`${name} is stopped at ${harness} screen: ${dialog.title}`, MAX_AGENDA_SUBJECT_LENGTH),
    why: clipAtWord(`It waits until somebody chooses. ${said.join(' ')}`, MAX_AGENDA_DETAIL_LENGTH),
    howToResolve:
      'Open the ferret’s terminal and choose a row. The Warden never chooses one, and a row that trusts something to run is yours to pick. This notice closes itself when the screen is gone.',
    context: `Harness dialog (${dialog.kind}) seen on ${name}.`,
  };
}

/**
 * What the Warden remembers per ferret: the dialog it told the owner about and how many looks in a row have missed it.
 * Kept as `[dialogId, misses]` in the machine-members store, keyed by session id.
 */
export type DialogEpisodes = Readonly<Record<string, readonly string[]>>;

/** The plan for one look. */
export interface DialogPlan {
  /** Dialogs whose episode is new: raise their notice. */
  readonly raise: readonly WatchedDialog[];
  /** Episodes that ended (the dialog is gone for good or another stands): close their notices. */
  readonly clear: readonly { readonly sessionId: string; readonly dialogId: string }[];
  /** The memory after this look, once the raises and clears land. */
  readonly next: DialogEpisodes;
}

/** Which dialogs are the Warden's to tell: every one but the usage limit. */
const dialogsToTell = (dialogs: readonly WatchedDialog[]): readonly WatchedDialog[] =>
  dialogs.filter(each => each.dialog.kind !== USAGE_LIMIT);

/** What to do this look: which notices to raise, which to close, and the memory that stands without them. */
export function planDialogNotices(input: {
  readonly dialogs: readonly WatchedDialog[];
  readonly memory: DialogEpisodes;
}): DialogPlan {
  const standing = new Map(dialogsToTell(input.dialogs).map(each => [each.sessionId, each]));
  const raise: WatchedDialog[] = [];
  const clear: { sessionId: string; dialogId: string }[] = [];
  const next: Record<string, readonly string[]> = {};
  for (const [sessionId, entry] of Object.entries(input.memory)) {
    const told = entry[0];
    if (told === undefined) continue;
    const now = standing.get(sessionId);
    if (now?.dialog.id === told) {
      next[sessionId] = [told, '0'];
      continue;
    }
    if (now !== undefined) {
      // Another dialog: the old episode is over.
      clear.push({ sessionId, dialogId: told });
      continue;
    }
    const misses = Number(entry[1] ?? '0') + 1;
    if (misses >= GONE_LOOKS) clear.push({ sessionId, dialogId: told });
    else next[sessionId] = [told, String(misses)];
  }
  for (const [sessionId, watched] of standing) {
    const told = input.memory[sessionId]?.[0];
    if (told !== watched.dialog.id) raise.push(watched);
  }
  return { raise, clear, next };
}

/** What the Warden's agenda does for this module. */
export interface DialogNoticePort {
  /** Raise one notice; `rejected` when the agenda refused it (the next look tries again). */
  raise(notice: DialogNotice): Promise<'created' | 'unchanged' | 'rejected'>;
  /** Close a notice the episode that raised it is over. */
  clear(sessionId: string, ref: string): Promise<void>;
}

export interface DialogWatchPorts {
  /** Every ferret that is parked on a dialog right now. Throws when it cannot be read. */
  dialogs(): Promise<readonly WatchedDialog[]>;
  readonly memory: MachineMembersStore;
  readonly notices: DialogNoticePort;
  /** Leaves the screens a rule knows how to leave, before the owner is told of anything (`dialog-clear.ts`). Absent: none is. */
  readonly clear?: { clear(dialogs: readonly WatchedDialog[]): Promise<{ readonly toTell: readonly WatchedDialog[] }> };
  record(type: string, data: Readonly<Record<string, string>>): void;
}

/** The look: read the dialogs, plan, write the notices, remember. One at a time. */
export class WardenDialogWatch {
  private readonly queue = new SerialQueue();

  constructor(private readonly ports: DialogWatchPorts) {}

  /** `enabled` false (the Warden is off): nothing is raised, and what stands is closed. */
  look(enabled: boolean): Promise<DialogPlan | undefined> {
    return this.queue.run(async () => {
      const memory = await this.ports.memory.read();
      let dialogs: readonly WatchedDialog[];
      try {
        dialogs = enabled ? await this.ports.dialogs() : [];
      } catch (error) {
        // An unreadable fleet proves nothing: no episode starts or ends on it.
        this.ports.record('fleet.warden_dialog_unreadable', { reason: String(error).slice(0, 200) });
        return undefined;
      }
      // A screen a rule cleared is not the owner's to hear about; one whose keys failed, or no rule fits, still is.
      if (enabled && this.ports.clear !== undefined) {
        try {
          dialogs = (await this.ports.clear.clear(dialogs)).toTell;
        } catch (error) {
          this.ports.record('fleet.warden_dialog_clear_unavailable', { reason: String(error).slice(0, 200) });
        }
      }
      const plan = planDialogNotices({ dialogs, memory });
      const next: Record<string, readonly string[]> = { ...plan.next };
      for (const { sessionId, dialogId } of plan.clear) {
        await this.ports.notices.clear(sessionId, dialogNoticeRef(dialogId));
        this.ports.record('fleet.warden_dialog_cleared', { sessionId, dialogId });
      }
      for (const watched of plan.raise) {
        const written = await this.ports.notices.raise(dialogNotice(watched));
        if (written === 'rejected') {
          this.ports.record('fleet.warden_dialog_notice_failed', { sessionId: watched.sessionId });
          continue;
        }
        next[watched.sessionId] = [watched.dialog.id, '0'];
        if (written === 'created')
          this.ports.record('fleet.warden_dialog_raised', {
            sessionId: watched.sessionId,
            dialogId: watched.dialog.id,
            kind: watched.dialog.kind,
          });
      }
      if (JSON.stringify(next) !== JSON.stringify(memory)) await this.ports.memory.write(next);
      return plan;
    });
  }
}
