import { z } from 'zod';
import {
  BROWSER_MODIFIERS,
  BrowserCoordinateSchema,
  type BrowserModifier,
  BrowserRefSchema,
  browserTargetProblem,
} from './browser-target.ts';

/**
 * THE POINTER AND KEYS VOCABULARY — hover, drag, mouse, press, scroll, select, check, fill_form and
 * highlight, shared by the agent tools and the browser's own actions so the two can never disagree about
 * what a call may carry.
 *
 * Every number, string and list here has a ceiling. A key is a CLOSED grammar (modifiers, then a named key
 * or one printable character) so a call can never smuggle anything else through the keyboard.
 */

/** The most chords one `browser.press` presses. */
export const BROWSER_MAX_PRESS_KEYS = 32;
/** The longest one chord may be: `ControlOrMeta+Shift+ArrowRight` is 30. */
export const BROWSER_MAX_KEY_CHARS = 40;
/** The most options one `browser.select` picks, and the longest one may be. */
export const BROWSER_MAX_SELECT_VALUES = 64;
export const BROWSER_MAX_OPTION_CHARS = 256;
/** The most fields one `browser.fill_form` fills, and the most text they carry together. */
export const BROWSER_MAX_FORM_FIELDS = 32;
export const BROWSER_MAX_FORM_TEXT_CHARS = 65_536;
/** The longest text one form field takes, and the longest value (a slider, a date, a colour). */
export const BROWSER_MAX_FIELD_TEXT_CHARS = 16_384;
export const BROWSER_MAX_FIELD_VALUE_CHARS = 256;
/** The furthest one scroll or wheel may go, either way, in CSS pixels; and in screens. */
export const BROWSER_MAX_SCROLL_DELTA = 20_000;
export const BROWSER_MAX_SCROLL_PAGES = 20;
/** The longest text a scroll looks for. */
export const BROWSER_MAX_SCROLL_TEXT_CHARS = 256;
/** The most intermediate moves a drag by points makes, and what it makes when not told. */
export const BROWSER_MAX_DRAG_STEPS = 100;
export const BROWSER_DEFAULT_DRAG_STEPS = 10;

/** The keys a chord may end in, besides one printable character. */
export const BROWSER_NAMED_KEYS: readonly string[] = [
  'Backspace',
  'Tab',
  'Enter',
  'Escape',
  'Space',
  'Delete',
  'Insert',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  ...Array.from({ length: 12 }, (_, index) => `F${String(index + 1)}`),
  ...BROWSER_MODIFIERS,
];

export interface BrowserKeyChord {
  readonly modifiers: readonly BrowserModifier[];
  readonly key: string;
}

const isModifier = (value: string): value is BrowserModifier =>
  (BROWSER_MODIFIERS as readonly string[]).includes(value);

/** One printable character: a single code point that is not a control character. */
const isPrintable = (value: string): boolean => {
  const points = [...value];
  const code = points[0]?.codePointAt(0);
  return points.length === 1 && code !== undefined && code >= 0x20 && code !== 0x7f;
};

/**
 * A chord as Playwright writes it — `Enter`, `a`, `Control+Shift+K`, `Control++` — taken apart, or nothing
 * when it is not in the grammar: zero or more distinct modifiers, then a named key or one printable
 * character. The key may be `+` itself.
 */
export function parseBrowserKeyChord(chord: string): BrowserKeyChord | undefined {
  if (chord.length === 0 || chord.length > BROWSER_MAX_KEY_CHARS) return undefined;
  const keyStart = chord === '+' || chord.endsWith('++') ? chord.length - 1 : chord.lastIndexOf('+') + 1;
  const key = chord.slice(keyStart);
  const head = chord.slice(0, keyStart);
  if (!BROWSER_NAMED_KEYS.includes(key) && !isPrintable(key)) return undefined;
  if (head === '') return { modifiers: [], key };
  const modifiers = head.slice(0, -1).split('+');
  if (!modifiers.every(isModifier) || new Set(modifiers).size !== modifiers.length) return undefined;
  return { modifiers, key };
}

export const BrowserKeyChordSchema = z
  .string()
  .max(BROWSER_MAX_KEY_CHARS)
  .refine(
    chord => parseBrowserKeyChord(chord) !== undefined,
    'a key is modifiers (Alt, Control, ControlOrMeta, Meta, Shift) joined by + and then a named key (Enter, ArrowDown, F5, …) or one character, e.g. Control+Shift+K',
  );

export const BrowserPressKeysSchema = z.array(BrowserKeyChordSchema).min(1).max(BROWSER_MAX_PRESS_KEYS);

export const BrowserSelectValuesSchema = z
  .array(z.string().max(BROWSER_MAX_OPTION_CHARS))
  .min(1)
  .max(BROWSER_MAX_SELECT_VALUES);

export const BrowserMouseActionSchema = z.enum(['move', 'down', 'up', 'wheel']);
export type BrowserMouseAction = z.infer<typeof BrowserMouseActionSchema>;

export const BrowserScrollDeltaSchema = z.number().min(-BROWSER_MAX_SCROLL_DELTA).max(BROWSER_MAX_SCROLL_DELTA);
export const BrowserScrollPagesSchema = z.number().min(-BROWSER_MAX_SCROLL_PAGES).max(BROWSER_MAX_SCROLL_PAGES);
export const BrowserDragStepsSchema = z.number().int().min(1).max(BROWSER_MAX_DRAG_STEPS);

/** The fields a drag names its two ends with, as a shape; the selector's own bound is the caller's. */
export const browserDragShape = (selector: z.ZodString) => ({
  fromSelector: selector.optional(),
  fromRef: BrowserRefSchema.optional(),
  fromX: BrowserCoordinateSchema.optional(),
  fromY: BrowserCoordinateSchema.optional(),
  toSelector: selector.optional(),
  toRef: BrowserRefSchema.optional(),
  toX: BrowserCoordinateSchema.optional(),
  toY: BrowserCoordinateSchema.optional(),
  /** By points only: how many moves between the ends, for a slider or canvas that follows the pointer. */
  steps: BrowserDragStepsSchema.optional(),
});

export interface BrowserDragFields {
  readonly fromSelector?: string | undefined;
  readonly fromRef?: string | undefined;
  readonly fromX?: number | undefined;
  readonly fromY?: number | undefined;
  readonly toSelector?: string | undefined;
  readonly toRef?: string | undefined;
  readonly toX?: number | undefined;
  readonly toY?: number | undefined;
  readonly steps?: number | undefined;
}

/** A drag goes from one element to another, or from one point to another — never one of each. */
export const refineBrowserDrag = (value: BrowserDragFields, context: z.RefinementCtx): void => {
  const rule = { point: true, required: true } as const;
  const from = browserTargetProblem(
    { selector: value.fromSelector, ref: value.fromRef, x: value.fromX, y: value.fromY },
    rule,
  );
  const to = browserTargetProblem({ selector: value.toSelector, ref: value.toRef, x: value.toX, y: value.toY }, rule);
  if (from !== undefined) context.addIssue({ code: 'custom', message: `from: ${from}` });
  if (to !== undefined) context.addIssue({ code: 'custom', message: `to: ${to}` });
  if (from !== undefined || to !== undefined) return;
  const fromPoint = value.fromX !== undefined;
  const toPoint = value.toX !== undefined;
  if (fromPoint !== toPoint)
    context.addIssue({ code: 'custom', message: 'drag from an element to an element, or from a point to a point' });
  else if (!fromPoint && value.steps !== undefined)
    context.addIssue({ code: 'custom', message: 'steps is for a drag by points; an element drag is one gesture' });
};

export interface BrowserMouseFields {
  readonly action: BrowserMouseAction;
  readonly x?: number | undefined;
  readonly y?: number | undefined;
  readonly button?: string | undefined;
  readonly deltaX?: number | undefined;
  readonly deltaY?: number | undefined;
}

/** What each mouse action needs: move a place; wheel a distance; down and up only the button. */
export const refineBrowserMouse = (value: BrowserMouseFields, context: z.RefinementCtx): void => {
  const issue = (message: string): void => context.addIssue({ code: 'custom', message });
  if ((value.x === undefined) !== (value.y === undefined)) issue('a point needs both x and y');
  if (value.action === 'move' && value.x === undefined) issue('move needs x and y');
  const delta = value.deltaX !== undefined || value.deltaY !== undefined;
  if (value.action === 'wheel' && !delta) issue('wheel needs deltaX, deltaY, or both');
  if (value.action !== 'wheel' && delta) issue('deltaX and deltaY are for wheel');
  if (value.button !== undefined && value.action !== 'down' && value.action !== 'up')
    issue('button is for down and up');
};

export interface BrowserScrollFields {
  readonly selector?: string | undefined;
  readonly ref?: string | undefined;
  readonly text?: string | undefined;
  readonly deltaX?: number | undefined;
  readonly deltaY?: number | undefined;
  readonly pages?: number | undefined;
}

/** A scroll goes to an element, to a text, by a distance, or by screens — exactly one of those. */
export const refineBrowserScroll = (value: BrowserScrollFields, context: z.RefinementCtx): void => {
  const modes = [
    value.selector !== undefined || value.ref !== undefined,
    value.text !== undefined,
    value.deltaX !== undefined || value.deltaY !== undefined,
    value.pages !== undefined,
  ].filter(Boolean).length;
  if (modes !== 1)
    context.addIssue({
      code: 'custom',
      message: 'scroll to an element (ref or selector), to a text, by deltaX/deltaY, or by pages — exactly one',
    });
  const problem = browserTargetProblem({ selector: value.selector, ref: value.ref }, { point: false, required: false });
  if (problem !== undefined) context.addIssue({ code: 'custom', message: problem });
};

/** A highlight outlines one element, or clears the outline — not both, not neither. */
export const refineBrowserHighlight = (
  value: {
    readonly selector?: string | undefined;
    readonly ref?: string | undefined;
    readonly clear?: true | undefined;
  },
  context: z.RefinementCtx,
): void => {
  const target = value.selector !== undefined || value.ref !== undefined;
  if (value.clear === true && target)
    context.addIssue({ code: 'custom', message: 'clear removes the outline; it takes no target' });
  else if (value.clear !== true) {
    const problem = browserTargetProblem(
      { selector: value.selector, ref: value.ref },
      { point: false, required: true },
    );
    if (problem !== undefined) context.addIssue({ code: 'custom', message: problem });
  }
};

/** One field of a form: an element, and exactly one thing to do to it. */
export const browserFormFieldOf = (selector: z.ZodString) =>
  z
    .strictObject({
      selector: selector.optional(),
      ref: BrowserRefSchema.optional(),
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
      const problem = browserTargetProblem(field, { point: false, required: true });
      if (problem !== undefined) context.addIssue({ code: 'custom', message: problem });
      const things = [field.text, field.checked, field.option, field.value].filter(thing => thing !== undefined).length;
      if (things !== 1)
        context.addIssue({ code: 'custom', message: 'a field needs exactly one of text, checked, option or value' });
    });

export const browserFormFieldsOf = (selector: z.ZodString) =>
  z
    .array(browserFormFieldOf(selector))
    .min(1)
    .max(BROWSER_MAX_FORM_FIELDS)
    .refine(
      fields => fields.reduce((sum, field) => sum + (field.text?.length ?? 0), 0) <= BROWSER_MAX_FORM_TEXT_CHARS,
      `a form carries at most ${String(BROWSER_MAX_FORM_TEXT_CHARS)} characters of text in all`,
    );
