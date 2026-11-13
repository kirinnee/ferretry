/**
 * The inputs of the four page tools that type into a page or hand it to its owner: `browser_type`,
 * `browser_fill_form`, `browser_request_input` and `browser_ask_owner`. Copied field for field from today's
 * `protocol/src/lib/agent-tools.ts` (the `browser.type`, `browser.fill_form`, `browser.request_input` and
 * `browser.ask_owner` calls) and the target rules of `browser-target.ts` / `browser-pointer.ts`; the tool name is the
 * MCP name, so the body is the call without its `tool`.
 */
import {
  INPUT_MAX_EXPIRY_SECONDS,
  INPUT_MAX_FIELDS,
  INPUT_PROMPT_MAX_LENGTH,
  InputFieldIdSchema,
  InputSensitivitySchema,
  InputSubmitModeSchema,
  SecretNameSchema,
  SurfaceKeySchema,
} from '@ferretry/core-vault/contract';
import { z } from 'zod';
import { BROWSER_REF_PATTERN } from '../lib/element.ts';

/** The longest text one `browser_type` carries. */
const AGENT_TOOL_MAX_TEXT_CHARS = 16_384;
/** The longest selector an agent may type into. */
const AGENT_TOOL_MAX_SELECTOR_CHARS = 1_024;
/** The longest sentence an agent may leave the owner when it hands a page over. */
const AGENT_TOOL_MAX_ASK_CHARS = 280;
/** The most fields one form fill carries, and the most text in all. */
const BROWSER_MAX_FORM_FIELDS = 32;
const BROWSER_MAX_FORM_TEXT_CHARS = 65_536;
/** The longest text one form field takes, the longest option and the longest value (a slider, a date, a colour). */
const BROWSER_MAX_FIELD_TEXT_CHARS = 16_384;
const BROWSER_MAX_OPTION_CHARS = 256;
const BROWSER_MAX_FIELD_VALUE_CHARS = 256;
/** The longest a card's field label may be. */
const INPUT_FIELD_LABEL_MAX_LENGTH = 60;
/** How long a push approval waits for the owner, at least and at most. */
const PHONE_APPROVAL_MIN_WAIT_SECONDS = 30;
const PHONE_APPROVAL_MAX_WAIT_SECONDS = 300;

const SelectorSchema = z.string().trim().min(1).max(AGENT_TOOL_MAX_SELECTOR_CHARS);

const BrowserRefSchema = z
  .string()
  .trim()
  .regex(BROWSER_REF_PATTERN, 'a ref is what a page snapshot names an element: e12, or f1e3 inside a frame');

/** The element an act names: a ref from a page snapshot (`e12`), or a selector. */
const ElementTargetShape = { selector: SelectorSchema.optional(), ref: BrowserRefSchema.optional() };

/** Why these fields do not name exactly one element, as one sentence — or nothing (today's `browserTargetProblem`). */
function elementProblem(fields: {
  readonly selector?: string | undefined;
  readonly ref?: string | undefined;
}): string | undefined {
  const named = [fields.selector !== undefined, fields.ref !== undefined].filter(Boolean).length;
  if (named > 1) return 'name one target: a ref, a selector or a point, not several';
  if (named === 0) return 'name a target: a ref or a selector';
  return undefined;
}

const refineElement = (
  value: { readonly selector?: string | undefined; readonly ref?: string | undefined },
  context: z.RefinementCtx,
): void => {
  const problem = elementProblem(value);
  if (problem !== undefined) context.addIssue({ code: 'custom', message: problem });
};

/** What the owner is asked to do when a page is handed to them: a short plain sentence, never a secret. */
const AskOwnerMessageSchema = z.string().trim().min(1).max(AGENT_TOOL_MAX_ASK_CHARS);

/** `browser_type`: text into one element, Enter after it when `submit`, one key at a time when `slowly`. */
export const BrowserTypeInputSchema = z
  .strictObject({
    name: SurfaceKeySchema,
    ...ElementTargetShape,
    text: z.string().max(AGENT_TOOL_MAX_TEXT_CHARS),
    submit: z.literal(true).optional(),
    slowly: z.literal(true).optional(),
  })
  .superRefine(refineElement);
export type BrowserTypeInput = z.infer<typeof BrowserTypeInputSchema>;

/** One field of a form: an element, and exactly one thing to do to it. */
const BrowserFormFieldSchema = z
  .strictObject({
    ...ElementTargetShape,
    /** Replace what a text field holds. */
    text: z.string().max(BROWSER_MAX_FIELD_TEXT_CHARS).optional(),
    /** Tick or untick a checkbox or radio button. */
    checked: z.boolean().optional(),
    /** Pick an option of a select, by its value or its label. */
    option: z.string().max(BROWSER_MAX_OPTION_CHARS).optional(),
    /** Set a slider, date, colour or other non-text input. */
    value: z.string().max(BROWSER_MAX_FIELD_VALUE_CHARS).optional(),
  })
  .superRefine((field, context) => {
    refineElement(field, context);
    const things = [field.text, field.checked, field.option, field.value].filter(thing => thing !== undefined).length;
    if (things !== 1)
      context.addIssue({ code: 'custom', message: 'a field needs exactly one of text, checked, option or value' });
  });

/** `browser_fill_form`: several fields in one act. */
export const BrowserFillFormInputSchema = z.strictObject({
  name: SurfaceKeySchema,
  fields: z
    .array(BrowserFormFieldSchema)
    .min(1)
    .max(BROWSER_MAX_FORM_FIELDS)
    .refine(
      fields => fields.reduce((sum, field) => sum + (field.text?.length ?? 0), 0) <= BROWSER_MAX_FORM_TEXT_CHARS,
      `a form carries at most ${String(BROWSER_MAX_FORM_TEXT_CHARS)} characters of text in all`,
    ),
});
export type BrowserFillFormInput = z.infer<typeof BrowserFillFormInputSchema>;

/** `browser_ask_owner`: hand a page to the owner, optionally saying what to do there. */
export const BrowserAskOwnerInputSchema = z.strictObject({
  name: SurfaceKeySchema,
  message: AskOwnerMessageSchema.optional(),
});

const InputFieldLabelSchema = z
  .string()
  .trim()
  .min(1)
  .max(INPUT_FIELD_LABEL_MAX_LENGTH)
  .regex(/^[^\p{Cc}\p{Cf}]*$/u, 'a label is one line');

/**
 * One field of a `browser_request_input` card: what it is called, how careful to be with it, and the element it goes
 * into (a snapshot's ref or a selector). `plain` is a value the ferret may see (an e-mail); `secret` is a password.
 */
const BrowserInputFieldSchema = z
  .strictObject({
    id: InputFieldIdSchema,
    label: InputFieldLabelSchema.optional(),
    sensitivity: InputSensitivitySchema,
    ...ElementTargetShape,
  })
  .superRefine(refineElement);

/** An ask the card follows in a multi-step sign-in (`A12`). */
const ChainSchema = z.string().regex(/^A[1-9][0-9]*$/u);

/**
 * A PUSH APPROVAL (docs/input-requests.md, "Approve on your phone"): `push: true` asks the owner to approve a push on
 * their phone, with nothing typed. No element: the number is read only from a provider's own challenge view, never
 * from where the ferret points, because the page may echo back text the ferret typed (secrev-1244 H1).
 */
const BrowserPushApprovalInputSchema = z.strictObject({
  push: z.literal(true),
  name: SurfaceKeySchema,
  secretHint: SecretNameSchema.optional(),
  factor: z.string().min(1).max(128).optional(),
  waitSeconds: z.number().int().min(PHONE_APPROVAL_MIN_WAIT_SECONDS).max(PHONE_APPROVAL_MAX_WAIT_SECONDS).optional(),
});
export type BrowserPushApprovalInput = z.infer<typeof BrowserPushApprovalInputSchema>;

/** A card of values the owner types into the page's fields. */
const BrowserValuesInputSchema = z.strictObject({
  push: z.literal(false).optional(),
  name: SurfaceKeySchema,
  /** What the owner is told the values are for: shown as "the agent says", never as fact. */
  prompt: z.string().trim().min(1).max(INPUT_PROMPT_MAX_LENGTH),
  /** The values, in the order they are typed: each with its own sensitivity and its own element. */
  fields: z
    .array(BrowserInputFieldSchema)
    .min(1)
    .max(INPUT_MAX_FIELDS)
    .refine(fields => new Set(fields.map(field => field.id)).size === fields.length, 'each field needs its own id'),
  /** Press Enter in the last field after typing: offered to the owner by default. */
  submit: InputSubmitModeSchema.optional(),
  expiresInSeconds: z.number().int().min(30).max(INPUT_MAX_EXPIRY_SECONDS).optional(),
  blocking: z.boolean().optional(),
  chain: ChainSchema.optional(),
  secretHint: SecretNameSchema.optional(),
});

/** `browser_request_input`: a push approval, or a card of values. */
export const BrowserRequestInputSchema = z.union([BrowserPushApprovalInputSchema, BrowserValuesInputSchema]);
