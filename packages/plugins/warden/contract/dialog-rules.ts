import { RecordedHarnessSchema } from '@ferretry/core-ferrets/contract';
import { defineConfig, defineHook, defineState } from '@ferretry/kernel/contract';
import { z } from 'zod';

/**
 * DIALOG RULES: what the Warden may press on a ferret's terminal to dismiss a harness screen, as data.
 *
 * A rule names ONE screen by what the harness itself prints (never by free pane text) and says how to leave it: Esc, or
 * the row whose label is exactly `choose`. A rule can DECLINE or DISMISS; it can never GRANT. That is held in three
 * places, so no one of them is the only guard: the file's schema refuses a `choose` that reads as a grant, the planner
 * (`daemon/lib/dialog-rules.ts`) refuses to press a row the harness marked `grantsTrust` or whose words read as a grant,
 * and a rule that would press one is never active.
 *
 * `config/warden-dialogs.yaml` holds the rules the OWNER taught Ferretry (`fy warden dialog learn`); the built-in tables
 * (one per harness) are code, and each lives in ITS harness plugin: the plugin that draws a screen knows its words, and
 * hands them to the Warden through {@link WardenDialogRulesClaude} / {@link WardenDialogRulesCodex}. The file is `personOnly` (no agent edits it) and every rule added to it is a LOOSENING
 * (it presses keys on a ferret), so an edit by anyone but the owner is held for the owner (docs/config-files.md).
 */

/** The harnesses a rule is for: Ferrets' family table, spelled as Ferrets records a ferret's dialog (`claude`, never `claude-code`). */
export const DIALOG_RULE_HARNESSES = RecordedHarnessSchema.options;
export type DialogRuleHarness = (typeof DIALOG_RULE_HARNESSES)[number];

/**
 * What a harness plugin provides: its built-in rules, and what a ferret is told after a rule declined its prompt (fixed
 * words by rule id; never pane text; a rule with no entry says nothing). The Warden validates every rule it is handed
 * (`DialogRuleSchema`, which refuses a row that grants) and drops, and journals, any that fails: a plugin cannot give
 * the Warden a rule it could not have taught it.
 */
export interface HarnessDialogRules {
  readonly rules: readonly DialogRule[];
  readonly nudges?: Readonly<Record<string, string>>;
}

/** The key every dialog-rule hook is taken with. */
export const HARNESS_DIALOG_RULES_KEY = 'dialog-rules' as const;

const dialogRulesHook = (name: string, owner: string) =>
  defineHook(name, {
    mode: 'provide',
    key: z.literal(HARNESS_DIALOG_RULES_KEY),
    value: z.custom<HarnessDialogRules>(),
    // One hook per harness: the build refuses any other plugin, so Claude Code cannot hand the Warden Codex's rules.
    takers: [owner],
  });

/** Claude Code's built-in dialog rules. Taken by `claude-code`, read by the Warden. */
export const WardenDialogRulesClaude = dialogRulesHook('warden.dialog-rules.claude', 'claude-code');
/** Codex's built-in dialog rules. Taken by `codex`, read by the Warden. */
export const WardenDialogRulesCodex = dialogRulesHook('warden.dialog-rules.codex', 'codex');

/** A pattern the owner or a table wrote: it must compile, and stay short. */
const Pattern = z
  .string()
  .min(1)
  .max(160)
  .refine(
    source => {
      try {
        new RegExp(source, 'iu');
        return true;
      } catch {
        return false;
      }
    },
    { message: 'must be a valid pattern' },
  );

/** Words that grant, allow, approve or remember: a row that opens with one is never pressed by a rule. */
const GRANT_LEAD =
  /^(?:yes|y|ok(?:ay)?|allow|approve|accept|enable|install|grant|authorize|authorise|proceed|open|try|trust|use\s+(?:this|these|that|all|it)|update|sign in|provide|review|always)\b/iu;

/** Words anywhere in a row that mean it grants or remembers something. */
const GRANT_ANYWHERE = /\b(?:allow\w*|always|approv\w*|grant\w*|authori[sz]\w*|don['’]t ask again|trust\w*)\b/iu;

/** A row that says it does NOT do the thing (`Continue without trusting`) is a decline, not a grant. */
const NEGATED = /\bwithout\b|\bnot\b|\bnever\b|n['’]t\b/iu;

/**
 * Whether a row's words read as granting trust, access or approval. ERRS TOWARD "grant": a decline that reads as one only
 * costs a notice, a grant that reads as a decline costs the owner's trust. `grantsTrust` is the harness's own mark.
 */
export function isGrantLabel(label: string, grantsTrust?: boolean): boolean {
  if (grantsTrust === true) return true;
  const text = label.trim().replaceAll('’', "'");
  if (GRANT_LEAD.test(text)) return true;
  return GRANT_ANYWHERE.test(text) && !NEGATED.test(text);
}

/** How a rule leaves a screen: Esc, or the one row whose label is exactly this. */
export const DialogActionSchema = z.union([
  z.strictObject({ press: z.literal('escape') }),
  z
    .strictObject({ choose: z.string().min(1).max(200) })
    .refine(action => !isGrantLabel(action.choose), { message: 'a rule never chooses a row that grants or approves' }),
]);
export type DialogAction = z.infer<typeof DialogActionSchema>;

export const DialogRuleSchema = z
  .strictObject({
    /** The rule's name in the journal: a short slug. */
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/u),
    harness: z.enum(DIALOG_RULE_HARNESSES),
    /** The dialog `kind` Ferrets recorded, or `permission` for a tool-permission prompt. */
    kind: z.string().min(1).max(40),
    /** A pattern over the dialog's own title line (a permission prompt's question). */
    title: Pattern.optional(),
    /** A pattern over the first line of what the dialog says (a permission prompt's tool: `Bash`). */
    body: Pattern.optional(),
    /** A pattern over one printed line of the live frame, checked fresh before any key (a fixed harness phrase). */
    text: Pattern.optional(),
    action: DialogActionSchema,
  })
  .refine(rule => rule.title !== undefined || rule.text !== undefined, {
    message: 'a rule names its screen by a title or a fixed printed line',
  });
export type DialogRule = z.infer<typeof DialogRuleSchema>;

/** `config/warden-dialogs.yaml`: the rules the owner taught. */
export const DialogRulesFileSchema = z.strictObject({ rules: z.array(DialogRuleSchema).max(64).optional() });
export type DialogRulesFile = z.infer<typeof DialogRulesFileSchema>;

/** Every rule is a loosening: it presses keys on a ferret. A rule the file already had is not new. */
export function dialogRulesLoosen(before: DialogRulesFile | undefined, after: DialogRulesFile): readonly string[] {
  const known = new Set((before?.rules ?? []).map(rule => JSON.stringify(rule)));
  return (after.rules ?? [])
    .filter(rule => !known.has(JSON.stringify(rule)))
    .map(rule => `the Warden may press keys to clear the ${rule.harness} ${rule.kind} screen (${rule.id})`);
}

/** `config/warden-dialogs.yaml`: the owner's taught rules; an edit that adds one waits for the owner. */
export const WARDEN_DIALOG_RULES = defineConfig({
  file: 'warden-dialogs.yaml',
  schema: DialogRulesFileSchema,
  axis: 'configure',
  loosens: dialogRulesLoosen,
  personOnly: true,
});

/**
 * The frame a ferret was parked on when the owner taught Ferretry a screen, masked, one file per ferret (`dialog-frames/<ferret>`).
 * Owner-only (`0600`) and declared private in the manifest: it is a screen of a person's work, kept so the owner can see
 * what they taught. Never read by a route, never in the agenda, a log or a notice.
 */
export const WARDEN_DIALOG_FRAMES = defineState({
  name: 'dialog-frames',
  path: 'dialog-frames/*',
  store: 'opaque',
  format: 1,
  mode: 0o600,
});

/** What `fy warden dialog learn <ferret>` answers: a proposal to review, never a saved rule. */
export const DialogProposalSchema = z.strictObject({
  ferret: z.string().min(1),
  /** The rule the owner would save, or `undefined` when no safe way out could be found. */
  rule: DialogRuleSchema.optional(),
  /** The dialog's own rows (masked), so the owner sees what the rule would press; `pressed` marks the one it presses. */
  rows: z.array(z.strictObject({ number: z.number().int(), label: z.string(), pressed: z.boolean() })),
  title: z.string(),
  /** Why nothing was proposed, or why the proposal waits for the owner. */
  note: z.string().optional(),
  /** The proposal picks a row that grants something: it is HELD and can never be saved as a rule. */
  held: z.boolean(),
});
export type DialogProposal = z.infer<typeof DialogProposalSchema>;

export const DialogLearnRequestSchema = z.strictObject({
  ferret: z.string().min(1),
  /** Save the rule the last `learn` of this ferret proposed. */
  confirm: z.boolean().optional(),
  /** Press THIS row instead of the one proposed. A row that grants something is held and never saved. */
  row: z.number().int().min(1).max(9).optional(),
});
export type DialogLearnRequest = z.infer<typeof DialogLearnRequestSchema>;

/** The answer: the proposal, and whether this call saved it (`saved`) or the kernel holds it for the owner (`held`). */
export const DialogLearnAnswerSchema = z.strictObject({
  proposal: DialogProposalSchema,
  saved: z.boolean(),
  /** Sentences of what waits for the owner. */
  heldFor: z.array(z.string()),
});
export type DialogLearnAnswer = z.infer<typeof DialogLearnAnswerSchema>;

/** One rule as the app lists it: what screen, and what it does in a sentence. */
export const DialogRuleViewSchema = z.strictObject({
  id: z.string(),
  harness: z.enum(DIALOG_RULE_HARNESSES),
  kind: z.string(),
  /** `presses Esc` or `chooses “No, not now”`. */
  does: z.string(),
});
export type DialogRuleView = z.infer<typeof DialogRuleViewSchema>;

/** `GET /v1/warden/dialog/rules`: what Ferretry clears by itself, what the owner taught it, and what waits for a yes. */
export const DialogRulesViewSchema = z.strictObject({
  builtIn: z.array(DialogRuleViewSchema),
  taught: z.array(DialogRuleViewSchema),
  pending: z.array(DialogProposalSchema),
});
export type DialogRulesView = z.infer<typeof DialogRulesViewSchema>;

/** A rule said in a sentence, for the app and the CLI. */
export const doesOf = (rule: DialogRule): string =>
  'press' in rule.action ? 'presses Esc' : `chooses “${rule.action.choose}”`;
