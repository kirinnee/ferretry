/**
 * DIALOG LEARN: a screen no rule knows, taught to Ferretry by its owner.
 *
 * ═══ THE FLOW ═══
 *
 * 1. `learn <ferret>`: the ferret's CURRENT frame is read, MASKED and kept in the Warden's own `0600` state (never in the
 *    agenda, a log or a notice), and a rule is PROPOSED from the dialog's fixed lines and its decline or dismiss row.
 * 2. The owner reads the match and the keys and says yes (`learn <ferret> --confirm`, or the app's confirm row).
 * 3. The rule is written to `config/warden-dialogs.yaml`. The kernel holds an edit by anyone but the owner, and the file
 *    is `personOnly`. The next time that screen shows, a ferret is cleared in the dialog look (`dialog-clear.ts`).
 *
 * A proposal is only ever a DECLINE or a DISMISS. If the row picked (by the owner's `--row`) grants, trusts or approves
 * anything, the proposal is HELD: it is shown, never saved, and the screen stays a notice for a person.
 *
 * Pure but for its ports.
 */
import {
  type DialogLearnAnswer,
  type DialogProposal,
  DialogProposalSchema,
  type DialogRule,
  DialogRuleSchema,
  isGrantLabel,
} from '../../contract/dialog-rules.ts';
import type { MachineMembersStore } from './machine-notices.ts';
import type { ClearableDialogWords } from './dialog-words.ts';
import type { ClearFrame } from './dialog-clear.ts';

/** The key the pending proposals are kept under in the Warden's state file: one per ferret, the last learned. */
export const DIALOG_PROPOSALS_REF = 'warden:dialog-proposals';

/** Rows whose own words decline or dismiss: the ones a proposal picks by itself. */
const DECLINE_ROW =
  /^(?:no\b|skip\b|dismiss|decline|not now|later\b|cancel|close\b|back\b|continue without|use existing|keep\b|never mind|ignore|stay\b|don['’]t)/iu;

/** How much of a title a learned rule's pattern covers. */
const TITLE_PATTERN_CHARS = 60;

/**
 * A second, SHAPE-based pass over text the Vault-value masker may not know: an `Authorization` value, a provider key.
 * It only ever hides more. The masker (`kernel.redaction`) is the one that matters; this is a belt on it.
 */
export function maskShapes(text: string): string {
  return text
    .replaceAll(/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/gu, '$1 ***')
    .replaceAll(/\b(?:sk|pk|ghp|gho|xox[abp])[-_][A-Za-z0-9_-]{16,}/gu, '***');
}

const escapePattern = (text: string): string => text.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);

/** A short stable slug for a title, so the same screen learned twice is the same rule. */
function slug(text: string): string {
  let hash = 5381;
  for (const char of text) hash = ((hash << 5) + hash + char.charCodeAt(0)) >>> 0;
  return hash.toString(36);
}

const rowsOf = (dialog: ClearableDialogWords, pressed: number | undefined) =>
  dialog.options.map(option => ({ number: option.number, label: option.label, pressed: option.number === pressed }));

/**
 * The proposal for a ferret's dialog. `row` is the owner's own pick; without it, the first row whose words decline. A
 * dialog with no such row but an Esc offers Esc. A tool prompt, the usage-limit screen and a harness this build does not
 * know are not taught.
 */
export function proposeRule(input: {
  readonly ferret: string;
  readonly dialog: ClearableDialogWords;
  readonly row?: number | undefined;
}): DialogProposal {
  const { ferret, dialog } = input;
  const base = { ferret, title: dialog.title, rows: rowsOf(dialog, undefined), held: false };
  if (dialog.kind === 'permission')
    return { ...base, note: 'a tool permission prompt is never taught: it is yours to answer.' };
  if (dialog.kind === 'usage-limit') return { ...base, note: 'a spent login is the auto-move’s, not a rule’s.' };
  const harness = dialog.harness;
  if (harness !== 'claude' && harness !== 'codex')
    return { ...base, note: 'which harness drew this screen is not known, so no rule can name it.' };
  const asked = input.row === undefined ? undefined : dialog.options.find(option => option.number === input.row);
  if (input.row !== undefined && asked === undefined)
    return { ...base, note: `the screen has no row ${String(input.row)}.` };
  const picked =
    asked ??
    dialog.options.find(
      option => !isGrantLabel(option.label, option.grantsTrust) && DECLINE_ROW.test(option.label.trim()),
    );
  const id = `learned-${dialog.kind}-${slug(dialog.title)}`;
  const title = `^${escapePattern(dialog.title.slice(0, TITLE_PATTERN_CHARS).trim())}`;
  if (picked === undefined) {
    if (dialog.escape === undefined)
      return { ...base, note: 'no row of this screen declines or dismisses it, and it offers no Esc: it stays yours.' };
    const rule: DialogRule = { id, harness, kind: dialog.kind, title, action: { press: 'escape' } };
    return { ...base, rule, note: `no row declines, so the rule presses Esc (${dialog.escape}).` };
  }
  if (isGrantLabel(picked.label, picked.grantsTrust))
    return {
      ...base,
      rows: rowsOf(dialog, picked.number),
      held: true,
      note: 'that row grants, trusts or approves something, so it is held: a rule never presses one. Choose a row that declines, or answer it at the terminal.',
    };
  const rule: DialogRule = { id, harness, kind: dialog.kind, title, action: { choose: picked.label } };
  return { ...base, rows: rowsOf(dialog, picked.number), rule };
}

export interface DialogLearnPorts {
  /** The dialog the ferret's state records now (words only), or `undefined` when it records none. */
  dialogOf(ferret: string): Promise<ClearableDialogWords | undefined>;
  /** The ferret's live frame. */
  frame(ferret: string): Promise<ClearFrame | undefined>;
  /** The secret masker the terminal and screenshot paths use. */
  mask(text: string): Promise<string>;
  /** Keeps the masked frame in the Warden's own owner-only state. */
  saveFrame(ferret: string, masked: string): Promise<void>;
  /** The pending proposals, one per ferret, as the JSON of a {@link DialogProposal}. */
  readonly proposals: MachineMembersStore;
  /** Writes the rule to `config/warden-dialogs.yaml`; says what waits for the owner, or `[]` when it is in effect. */
  saveRule(rule: DialogRule): Promise<readonly string[]>;
  record(type: string, data: Readonly<Record<string, string>>): void;
}

/** Why a learn or a confirm cannot go on: said to the owner as it is. */
export class DialogLearnRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DialogLearnRefused';
  }
}

export class WardenDialogLearn {
  constructor(private readonly ports: DialogLearnPorts) {}

  /** Read the ferret's screen, keep its masked frame, and propose the rule. Saves nothing. */
  async learn(ferret: string, row?: number): Promise<DialogLearnAnswer> {
    const dialog = await this.ports.dialogOf(ferret);
    if (dialog === undefined) throw new DialogLearnRefused('that ferret is not parked on a dialog right now.');
    const frame = await this.ports.frame(ferret);
    if (frame === undefined || !frame.blocking)
      throw new DialogLearnRefused(
        'that ferret’s screen could not be read as a dialog just now; try again while it is up.',
      );
    // The words and the frame go through the masker before anything is kept or said.
    const masked = maskShapes(await this.ports.mask(frame.visible));
    await this.ports.saveFrame(ferret, masked);
    const words: ClearableDialogWords = {
      ...dialog,
      title: maskShapes(await this.ports.mask(dialog.title)),
      options: await Promise.all(
        dialog.options.map(async option => ({ ...option, label: maskShapes(await this.ports.mask(option.label)) })),
      ),
    };
    const unchanged =
      words.title === dialog.title &&
      words.options.every((option, index) => option.label === dialog.options[index]?.label);
    const proposal: DialogProposal = unchanged
      ? proposeRule({ ferret, dialog: words, row })
      : {
          ferret,
          title: words.title,
          rows: rowsOf(words, undefined),
          held: false,
          note: 'the screen carries something secret-shaped, so no rule can be written from its words.',
        };
    const members = await this.ports.proposals.read();
    const { [ferret]: _replaced, ...others } = members;
    await this.ports.proposals.write(
      proposal.rule === undefined || proposal.held ? others : { ...others, [ferret]: [JSON.stringify(proposal)] },
    );
    this.ports.record('fleet.warden_dialog_learned', {
      sessionId: ferret,
      kind: dialog.kind,
      proposed: String(proposal.rule !== undefined),
    });
    return { proposal, saved: false, heldFor: [] };
  }

  /** Save the rule the last `learn` of this ferret proposed. */
  async confirm(ferret: string): Promise<DialogLearnAnswer> {
    const members = await this.ports.proposals.read();
    const raw = members[ferret]?.[0];
    const parsed = raw === undefined ? undefined : DialogProposalSchema.safeParse(JSON.parse(raw));
    if (parsed === undefined || !parsed.success || parsed.data.rule === undefined)
      throw new DialogLearnRefused(
        'nothing is waiting to be saved for that ferret: run learn first, and read what it proposes.',
      );
    const proposal = parsed.data;
    const rule = DialogRuleSchema.parse(proposal.rule);
    const heldFor = await this.ports.saveRule(rule);
    const { [ferret]: _done, ...others } = members;
    await this.ports.proposals.write(others);
    this.ports.record('fleet.warden_dialog_rule_saved', {
      sessionId: ferret,
      rule: rule.id,
      held: String(heldFor.length > 0),
    });
    return { proposal, saved: heldFor.length === 0, heldFor: [...heldFor] };
  }
}
