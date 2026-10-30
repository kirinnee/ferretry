import { z } from 'zod';
import {
  BROWSER_MAX_HEIGHT,
  BROWSER_MAX_WIDTH,
  BROWSER_MIN_HEIGHT,
  BROWSER_MIN_WIDTH,
  BrowserRefSchema,
} from './browser-target.ts';

/**
 * A PAGE'S LIFECYCLE — what happens to a page that is not a click, a keystroke or a read: a dialog it
 * raises, a popup it opens, a condition an agent waits on, what it logged, what it fetched, and the
 * device it pretends to be.
 *
 * This module owns the vocabulary the agent tools (`browser.dialog`, `browser.tabs`, `browser.wait_for`,
 * `browser.console`, `browser.network`, `browser.emulate`) and the daemon-to-worker `lifecycle` request
 * share. It imports nothing from the agent-tool or browser modules so both can import it.
 *
 * EVERYTHING HERE IS BOUNDED. A dialog is held for {@link BROWSER_DIALOG_HOLD_MS} and then dismissed, a
 * wait is run in {@link BROWSER_WAIT_SLICE_MS} slices, a log is a ring of a fixed size, and a response
 * body is cut at {@link BROWSER_NETWORK_BODY_MAX_BYTES}.
 */

/** How long a page's dialog waits for an agent before it is dismissed, so a forgotten one cannot freeze a page. */
export const BROWSER_DIALOG_HOLD_MS = 30_000;
/** The longest text an agent may answer a `prompt` dialog with. */
export const BROWSER_DIALOG_PROMPT_MAX_CHARS = 1_024;
/** The longest dialog message that is shown to an agent. */
export const BROWSER_DIALOG_MESSAGE_MAX_CHARS = 1_024;

/** The longest one `browser.wait_for` call may wait, and the slice it is run in between takeover checks. */
export const BROWSER_WAIT_MAX_MS = 25_000;
export const BROWSER_WAIT_DEFAULT_MS = 10_000;
export const BROWSER_WAIT_SLICE_MS = 1_000;
/** The longest text or URL fragment a wait may look for. */
export const BROWSER_WAIT_TEXT_MAX_CHARS = 1_024;

/** How many console entries a page keeps, and how many one call returns. */
export const BROWSER_CONSOLE_BUFFER = 500;
export const BROWSER_CONSOLE_DEFAULT_LIMIT = 100;
export const BROWSER_CONSOLE_MAX_LIMIT = 500;
/** The longest one console entry is kept. */
export const BROWSER_CONSOLE_MESSAGE_MAX_CHARS = 2_000;

/** How many requests a page keeps, and how many one list returns. */
export const BROWSER_NETWORK_BUFFER = 300;
export const BROWSER_NETWORK_LIST_LIMIT = 100;
/** The most of a text response body `browser.network` get returns. */
export const BROWSER_NETWORK_BODY_MAX_BYTES = 65_536;
/** The longest URL fragment a network list may filter by. */
export const BROWSER_NETWORK_FILTER_MAX_CHARS = 256;

export const BrowserDialogActionSchema = z.enum(['accept', 'dismiss']);
export type BrowserDialogAction = z.infer<typeof BrowserDialogActionSchema>;

/** What kind of dialog the page raised, as the browser names it. */
export const BrowserDialogTypeSchema = z.enum(['alert', 'beforeunload', 'confirm', 'prompt']);
export type BrowserDialogType = z.infer<typeof BrowserDialogTypeSchema>;

/** A dialog a page is waiting on: what it is and what it says. */
export const BrowserDialogInfoSchema = z.strictObject({
  type: BrowserDialogTypeSchema,
  message: z.string().max(BROWSER_DIALOG_MESSAGE_MAX_CHARS),
});
export type BrowserDialogInfo = z.infer<typeof BrowserDialogInfoSchema>;

export const BrowserElementStateSchema = z.enum(['visible', 'hidden', 'attached', 'detached']);
export type BrowserElementState = z.infer<typeof BrowserElementStateSchema>;

export const BrowserLoadStateSchema = z.enum(['load', 'domcontentloaded', 'networkidle']);
export type BrowserLoadState = z.infer<typeof BrowserLoadStateSchema>;

const WaitTextSchema = z.string().min(1).max(BROWSER_WAIT_TEXT_MAX_CHARS);
const ElementSelectorSchema = z.string().trim().min(1).max(1_024);

/** The one thing a `wait_for` waits for. */
export const BrowserWaitConditionSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('element'),
    target: z.discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('selector'), selector: ElementSelectorSchema }),
      z.strictObject({ kind: z.literal('ref'), ref: BrowserRefSchema }),
    ]),
    state: BrowserElementStateSchema,
  }),
  z.strictObject({ kind: z.literal('text'), text: WaitTextSchema }),
  z.strictObject({ kind: z.literal('textGone'), text: WaitTextSchema }),
  z.strictObject({ kind: z.literal('url'), url: WaitTextSchema }),
  z.strictObject({ kind: z.literal('load'), state: BrowserLoadStateSchema }),
  z.strictObject({ kind: z.literal('time'), ms: z.number().int().min(1).max(BROWSER_WAIT_MAX_MS) }),
]);
export type BrowserWaitCondition = z.infer<typeof BrowserWaitConditionSchema>;

/** Console levels, from the loudest to the quietest. */
export const BROWSER_CONSOLE_LEVELS = ['error', 'warning', 'info', 'log', 'debug'] as const;
export const BrowserConsoleLevelSchema = z.enum(BROWSER_CONSOLE_LEVELS);
export type BrowserConsoleLevel = z.infer<typeof BrowserConsoleLevelSchema>;

/** The kinds of request a network list may be narrowed to, as the browser names them. */
export const BROWSER_RESOURCE_TYPES = [
  'document',
  'stylesheet',
  'image',
  'media',
  'font',
  'script',
  'texttrack',
  'xhr',
  'fetch',
  'eventsource',
  'websocket',
  'manifest',
  'other',
] as const;
export const BrowserResourceTypeSchema = z.enum(BROWSER_RESOURCE_TYPES);
export type BrowserResourceType = z.infer<typeof BrowserResourceTypeSchema>;

/** A request as a network list names it: `r12`. */
export const BrowserRequestIdSchema = z
  .string()
  .trim()
  .regex(/^r\d{1,9}$/u, 'a request id is what a network list names it: r12');

/** The permissions an agent may grant a page: never the clipboard's read side, never the camera or microphone. */
export const BROWSER_EMULATED_PERMISSIONS = [
  'geolocation',
  'notifications',
  'midi',
  'clipboard-write',
  'accelerometer',
  'gyroscope',
  'magnetometer',
  'background-sync',
] as const;
export const BrowserEmulatedPermissionSchema = z.enum(BROWSER_EMULATED_PERMISSIONS);
export type BrowserEmulatedPermission = z.infer<typeof BrowserEmulatedPermissionSchema>;

/** The slowest a CPU may be throttled: 1 is not throttled, 20 is twenty times slower. */
export const BROWSER_CPU_THROTTLE_MAX = 20;
/** The longest and the slowest an emulated network may be. */
export const BROWSER_NETWORK_LATENCY_MAX_MS = 60_000;
export const BROWSER_NETWORK_THROUGHPUT_MAX_KBPS = 1_000_000;

export const BrowserEmulatedViewportSchema = z.strictObject({
  width: z.number().int().min(BROWSER_MIN_WIDTH).max(BROWSER_MAX_WIDTH),
  height: z.number().int().min(BROWSER_MIN_HEIGHT).max(BROWSER_MAX_HEIGHT),
});

export const BrowserEmulatedMediaSchema = z
  .strictObject({
    colorScheme: z.enum(['light', 'dark', 'no-preference']).optional(),
    reducedMotion: z.enum(['reduce', 'no-preference']).optional(),
    forcedColors: z.enum(['active', 'none']).optional(),
    contrast: z.enum(['more', 'less', 'custom', 'no-preference']).optional(),
    /** Lay the page out as it would print. */
    print: z.literal(true).optional(),
  })
  .refine(media => Object.values(media).some(value => value !== undefined), 'name at least one media feature');

export const BrowserEmulatedGeolocationSchema = z.strictObject({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  /** Metres. */
  accuracy: z.number().min(0).max(100_000).optional(),
});

export const BrowserEmulatedNetworkSchema = z
  .strictObject({
    offline: z.literal(true).optional(),
    /** Added round-trip time, in milliseconds. */
    latency: z.number().int().min(0).max(BROWSER_NETWORK_LATENCY_MAX_MS).optional(),
    /** The most data per second in each direction, in kilobits. */
    throughput: z.number().int().min(1).max(BROWSER_NETWORK_THROUGHPUT_MAX_KBPS).optional(),
  })
  .refine(network => Object.values(network).some(value => value !== undefined), 'name at least one network condition');

/** A BCP 47 language tag such as `en-US` or `zh-Hant-TW`. */
export const BrowserLocaleSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$/u, 'a locale is a language tag such as en-US');
/** An IANA timezone such as `Europe/Berlin`. */
export const BrowserTimezoneSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+){0,2}$/u, 'a timezone is an IANA name such as Europe/Berlin')
  .max(64);

/**
 * What a page may be made to look like. NEVER the user agent or the client-hint headers (a site would
 * treat the agent as someone else), and NEVER permission to read the clipboard.
 */
export const BrowserEmulationShape = {
  viewport: BrowserEmulatedViewportSchema.optional(),
  media: BrowserEmulatedMediaSchema.optional(),
  geolocation: BrowserEmulatedGeolocationSchema.optional(),
  locale: BrowserLocaleSchema.optional(),
  timezone: BrowserTimezoneSchema.optional(),
  cpuThrottle: z.number().min(1).max(BROWSER_CPU_THROTTLE_MAX).optional(),
  network: BrowserEmulatedNetworkSchema.optional(),
  permissions: z.array(BrowserEmulatedPermissionSchema).min(1).max(BROWSER_EMULATED_PERMISSIONS.length).optional(),
  /** Put the page back as it was: viewport, media, geolocation, locale, timezone, throttle, network, permissions. */
  reset: z.literal(true).optional(),
} as const;

export const BrowserEmulationSchema = z
  .strictObject(BrowserEmulationShape)
  .refine(
    emulation => Object.values(emulation).some(value => value !== undefined),
    'name something to emulate, or reset: true',
  );
export type BrowserEmulation = z.infer<typeof BrowserEmulationSchema>;

/** The daemon-to-worker request: one lifecycle operation on one page. */
export const BrowserPageLifecycleRequestSchema = z.discriminatedUnion('op', [
  z.strictObject({
    op: z.literal('dialog'),
    action: BrowserDialogActionSchema,
    promptText: z.string().max(BROWSER_DIALOG_PROMPT_MAX_CHARS).optional(),
  }),
  z.strictObject({
    op: z.literal('wait'),
    condition: BrowserWaitConditionSchema,
    timeoutMs: z.number().int().min(1).max(BROWSER_WAIT_MAX_MS),
  }),
  z.strictObject({
    op: z.literal('console'),
    level: BrowserConsoleLevelSchema.optional(),
    since: z.number().int().min(0).optional(),
    limit: z.number().int().min(1).max(BROWSER_CONSOLE_MAX_LIMIT).optional(),
  }),
  z.strictObject({
    op: z.literal('network'),
    action: z.enum(['list', 'get']),
    id: BrowserRequestIdSchema.optional(),
    filter: z.string().min(1).max(BROWSER_NETWORK_FILTER_MAX_CHARS).optional(),
    types: z.array(BrowserResourceTypeSchema).min(1).max(BROWSER_RESOURCE_TYPES.length).optional(),
  }),
  z.strictObject({ op: z.literal('emulate'), emulation: BrowserEmulationSchema }),
]);
export type BrowserPageLifecycleRequest = z.infer<typeof BrowserPageLifecycleRequestSchema>;

/** What the worker answers a lifecycle request with, beside the page snapshot. Text is page-derived: scrub it. */
export interface BrowserPageLifecycleReply {
  readonly text: string;
  /** A wait: whether the condition held. */
  readonly matched?: boolean;
  /** A dialog answer: the kind of dialog that was answered. */
  readonly dialogType?: BrowserDialogType;
}
