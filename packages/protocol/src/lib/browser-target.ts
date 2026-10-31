import { z } from 'zod';

/**
 * WHAT A BROWSER ACT POINTS AT — one vocabulary for the agent tools and the browser's own actions.
 *
 * An act names exactly ONE target:
 *
 * - a `ref`, which a page snapshot (`browser.read` with mode `snapshot`) hands out beside every element
 *   it lists — `e12`, or `f1e3` for an element inside a frame. It is the cheapest way for an agent to say
 *   "that button": read once, then act on what was read. A ref is only good against the page's latest
 *   snapshot; after the page changes, read it again;
 * - a `selector` (CSS or Playwright), as before refs existed;
 * - a point, `x` and `y` in the viewport's CSS pixels — for a canvas, a map or anything a snapshot
 *   cannot name — where the act allows one.
 */

/** The smallest and largest viewport a page may be sized to, in CSS pixels. */
export const BROWSER_MIN_WIDTH = 320;
export const BROWSER_MIN_HEIGHT = 240;
export const BROWSER_MAX_WIDTH = 1_920;
export const BROWSER_MAX_HEIGHT = 1_200;

/** A ref as a snapshot writes it: `e12`, or `f1e3` inside a frame. */
export const BROWSER_REF_PATTERN = /^(?:f\d{1,6})?e\d{1,7}$/u;
/** The furthest a point may be from the viewport's top-left corner, either way. */
export const BROWSER_MAX_COORDINATE = 10_000;
/** The longest text `browser.read` may search a snapshot for. */
export const BROWSER_MAX_FIND_CHARS = 256;
/** The deepest a snapshot may be asked to go. */
export const BROWSER_MAX_SNAPSHOT_DEPTH = 64;

export const BrowserRefSchema = z
  .string()
  .trim()
  .regex(BROWSER_REF_PATTERN, 'a ref is what a page snapshot names an element: e12, or f1e3 inside a frame');

export const BrowserCoordinateSchema = z.number().min(0).max(BROWSER_MAX_COORDINATE);

export const BrowserMouseButtonSchema = z.enum(['left', 'right', 'middle']);
export type BrowserMouseButton = z.infer<typeof BrowserMouseButtonSchema>;

/** The modifier keys a click may hold. `ControlOrMeta` is Command on a Mac and Control elsewhere. */
export const BROWSER_MODIFIERS = ['Alt', 'Control', 'ControlOrMeta', 'Meta', 'Shift'] as const;
export const BrowserModifierSchema = z.enum(BROWSER_MODIFIERS);
export type BrowserModifier = z.infer<typeof BrowserModifierSchema>;

/**
 * How a page is read: `text` is what a person reads; `a11y` is the accessibility tree; `snapshot` is the
 * accessibility tree with a ref beside every element, which every act accepts.
 */
export const BrowserReadModeSchema = z.enum(['text', 'a11y', 'snapshot']);
export type BrowserReadMode = z.infer<typeof BrowserReadModeSchema>;

export const BrowserScreenshotFormatSchema = z.enum(['png', 'jpeg']);
export type BrowserScreenshotFormat = z.infer<typeof BrowserScreenshotFormatSchema>;

/** One resolved target. */
export type BrowserTarget =
  | { readonly kind: 'selector'; readonly selector: string }
  | { readonly kind: 'ref'; readonly ref: string }
  | { readonly kind: 'point'; readonly x: number; readonly y: number };
/** A target that is an element — every act but a click can take only these. */
export type BrowserElementTarget = Exclude<BrowserTarget, { readonly kind: 'point' }>;

/** The flat fields a call names its target with. */
export interface BrowserTargetFields {
  readonly selector?: string | undefined;
  readonly ref?: string | undefined;
  readonly x?: number | undefined;
  readonly y?: number | undefined;
}

/** What a call may name: whether a point is allowed, and whether a target is required at all. */
export interface BrowserTargetRule {
  readonly point: boolean;
  readonly required: boolean;
}

/** Why these fields do not name a target the rule allows, as one sentence — or nothing. */
export function browserTargetProblem(fields: BrowserTargetFields, rule: BrowserTargetRule): string | undefined {
  const point = fields.x !== undefined || fields.y !== undefined;
  if (point && !rule.point) return 'this act takes a ref or a selector, not a point';
  if (point && (fields.x === undefined || fields.y === undefined)) return 'a point needs both x and y';
  const named = [fields.selector !== undefined, fields.ref !== undefined, point].filter(Boolean).length;
  if (named > 1) return 'name one target: a ref, a selector or a point, not several';
  if (named === 0 && rule.required)
    return rule.point ? 'name a target: a ref, a selector, or x and y' : 'name a target: a ref or a selector';
  return undefined;
}

/** A zod refinement that holds a call's flat target fields to a rule. */
export const refineBrowserTarget =
  (rule: BrowserTargetRule) =>
  (value: BrowserTargetFields, context: z.RefinementCtx): void => {
    const problem = browserTargetProblem(value, rule);
    if (problem !== undefined) context.addIssue({ code: 'custom', message: problem });
  };

/** The one target these fields name, or nothing when they name none. Assumes the fields passed the rule. */
export function browserTargetOf(fields: BrowserTargetFields): BrowserTarget | undefined {
  if (fields.ref !== undefined) return { kind: 'ref', ref: fields.ref };
  if (fields.selector !== undefined) return { kind: 'selector', selector: fields.selector };
  if (fields.x !== undefined && fields.y !== undefined) return { kind: 'point', x: fields.x, y: fields.y };
  return undefined;
}

/** The mode a read runs in: asked for, or `snapshot` when it asked for something only a snapshot has. */
export function browserReadModeOf(read: {
  readonly mode?: BrowserReadMode | undefined;
  readonly find?: string | undefined;
  readonly depth?: number | undefined;
  readonly boxes?: true | undefined;
}): BrowserReadMode {
  if (read.mode !== undefined) return read.mode;
  return read.find !== undefined || read.depth !== undefined || read.boxes !== undefined ? 'snapshot' : 'text';
}

/** Refuses `find`, `depth` and `boxes` on a read that is not a snapshot. */
export const refineBrowserRead = (
  value: {
    readonly mode?: BrowserReadMode | undefined;
    readonly find?: string | undefined;
    readonly depth?: number | undefined;
    readonly boxes?: true | undefined;
  },
  context: z.RefinementCtx,
): void => {
  if (browserReadModeOf(value) !== 'snapshot' && (value.find ?? value.depth ?? value.boxes) !== undefined)
    context.addIssue({ code: 'custom', message: 'find, depth and boxes need mode "snapshot"' });
};

/** Refuses a full-page screenshot of one element: an element shot is already its own size. */
export const refineBrowserScreenshot = (
  value: BrowserTargetFields & { readonly fullPage?: true | undefined },
  context: z.RefinementCtx,
): void => {
  if (value.fullPage === true && (value.selector ?? value.ref) !== undefined)
    context.addIssue({ code: 'custom', message: 'a screenshot is of the full page or of one element, not both' });
};
