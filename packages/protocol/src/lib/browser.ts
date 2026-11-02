import { z } from 'zod';
import { SurfaceNameSchema } from './agent-tools.ts';
import {
  BROWSER_MAX_FIND_CHARS,
  BROWSER_MAX_HEIGHT,
  BROWSER_MAX_WIDTH,
  BROWSER_MIN_HEIGHT,
  BROWSER_MIN_WIDTH,
  BROWSER_MAX_SNAPSHOT_DEPTH,
  BrowserChallengeProviderSchema,
  BrowserCoordinateSchema,
  BrowserModifierSchema,
  BrowserMouseButtonSchema,
  BrowserReadModeSchema,
  BrowserRefSchema,
  BrowserScreenshotFormatSchema,
  refineBrowserRead,
  refineBrowserScreenshot,
  refineBrowserTarget,
} from './browser-target.ts';
import {
  BROWSER_MAX_SCROLL_TEXT_CHARS,
  BrowserMouseActionSchema,
  BrowserPressKeysSchema,
  BrowserScrollDeltaSchema,
  BrowserScrollPagesSchema,
  BrowserSelectValuesSchema,
  browserDragShape,
  browserFormFieldsOf,
  refineBrowserDrag,
  refineBrowserHighlight,
  refineBrowserMouse,
  refineBrowserScroll,
} from './browser-pointer.ts';
import { InstantSchema, NonNegativeIntegerSchema } from './common.ts';
import { SECRET_REFERENCE_SOURCE } from './secrets.ts';
import { SurfaceOpenerSchema } from './surface.ts';

export { BROWSER_MAX_HEIGHT, BROWSER_MAX_WIDTH, BROWSER_MIN_HEIGHT, BROWSER_MIN_WIDTH };

export const BROWSER_MAX_INSTANCES = 3;
/** The most pages one SESSION keeps open; opening another past it is refused, never hidden. */
export const BROWSER_MAX_PAGES = 20;
/** The most pages the machine's one agent browser holds across every session. */
export const BROWSER_MAX_MACHINE_PAGES = 60;
export const BROWSER_MAX_PAGE_ID_LENGTH = 128;
export const BROWSER_MAX_SELECTOR_LENGTH = 4_096;
export const BROWSER_MAX_TEXT_LENGTH = 200_000;

export const BrowserLifecycleSchema = z.enum(['stopped', 'starting', 'running', 'stopping', 'error']);
export type BrowserLifecycle = z.infer<typeof BrowserLifecycleSchema>;

export const BrowserActorKindSchema = z.enum(['agent', 'human']);
export type BrowserActorKind = z.infer<typeof BrowserActorKindSchema>;

export const BrowserProfileKindSchema = z.enum(['shared', 'session']);
export type BrowserProfileKind = z.infer<typeof BrowserProfileKindSchema>;

export const BrowserPageStateSchema = z.enum(['loading', 'ready', 'error']);
export type BrowserPageState = z.infer<typeof BrowserPageStateSchema>;

/**
 * How this machine runs its one agent browser (`machine.yaml` `browserMode`, docs/browser-mode.md).
 *
 * - `headless` — no window: what agents get by default, and what a server with no display can run.
 * - `window` — a real Chrome window: a private virtual display on Linux, a real window on macOS. For an
 *   owner who browses and signs in through it themselves, so a site sees an ordinary desktop browser.
 *
 * Both are an honest Chrome. Neither disguises automation, and neither solves a challenge for anyone.
 */
export const BrowserModeSchema = z.enum(['headless', 'window']);
export type BrowserMode = z.infer<typeof BrowserModeSchema>;

export const BROWSER_PROXY_SCHEMES = ['http', 'https', 'socks5'] as const;
export type BrowserProxyScheme = (typeof BROWSER_PROXY_SCHEMES)[number];

/** The most bypass entries one proxy setting carries. */
export const BROWSER_PROXY_MAX_BYPASS = 64;

/**
 * Why a proxy address is refused, or `undefined` when it is a usable one: an `http://`, `https://` or
 * `socks5://` address with a host, no credentials in it and nothing after the port. Credentials never
 * travel in the address — the address is shown in the app and in the status — they are the
 * `username` / `password` references of {@link BrowserProxySettingSchema}.
 */
export function browserProxyUrlProblem(value: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return 'a proxy address looks like http://host:8080, https://host:8443 or socks5://host:1080';
  }
  const scheme = url.protocol.slice(0, -1);
  if (!(BROWSER_PROXY_SCHEMES as readonly string[]).includes(scheme)) {
    return 'a proxy address starts with http://, https:// or socks5://';
  }
  if (url.hostname === '') return 'a proxy address needs a host';
  if (url.username !== '' || url.password !== '') {
    return 'a proxy address never carries a user name or password: set username and password to ${secret:NAME} references instead';
  }
  if ((url.pathname !== '' && url.pathname !== '/') || url.search !== '' || url.hash !== '') {
    return 'a proxy address is only a scheme, a host and a port';
  }
  return undefined;
}

const BROWSER_PROXY_BYPASS_ENTRY = /^[A-Za-z0-9*._:/<>\[\]-]{1,253}$/u;
const BROWSER_PROXY_SECRET_REFERENCE = new RegExp(`^${SECRET_REFERENCE_SOURCE}$`, 'u');

const BrowserProxySecretReferenceSchema = z
  .string()
  .regex(
    BROWSER_PROXY_SECRET_REFERENCE,
    'proxy credentials are written as a ${secret:NAME} reference to the secret store, never as the value',
  );

/**
 * Where the machine's one agent browser sends its traffic (`machine.yaml` `browserProxy`,
 * docs/browser-proxy.md). Absent means direct — what every browser did before this setting.
 *
 * - `url` — `http://`, `https://` or `socks5://` address of the proxy, without credentials.
 * - `bypass` — hosts that skip the proxy, in Chrome's own syntax (`*.internal.example`, `10.0.0.0/8`,
 *   `<local>`). Loopback is bypassed by Chrome itself.
 * - `username` / `password` — `${secret:NAME}` references and nothing else: a value here would sit in a
 *   file every editor of the directory can read. Both or neither.
 */
export const BrowserProxySettingSchema = z
  .strictObject({
    url: z
      .string()
      .trim()
      .min(1)
      .max(512)
      .superRefine((value, context) => {
        const problem = browserProxyUrlProblem(value);
        if (problem !== undefined) context.addIssue({ code: 'custom', message: problem });
      }),
    bypass: z
      .array(
        z
          .string()
          .trim()
          .regex(
            BROWSER_PROXY_BYPASS_ENTRY,
            'a bypass entry is a host, a *.domain pattern, an address range such as 10.0.0.0/8, or <local>',
          ),
      )
      .max(BROWSER_PROXY_MAX_BYPASS)
      .default([]),
    username: BrowserProxySecretReferenceSchema.optional(),
    password: BrowserProxySecretReferenceSchema.optional(),
  })
  .superRefine((value, context) => {
    if ((value.username === undefined) !== (value.password === undefined)) {
      context.addIssue({
        code: 'custom',
        message: 'a proxy with credentials needs both username and password, each a ${secret:NAME} reference',
        path: [value.username === undefined ? 'username' : 'password'],
      });
    }
  });
export type BrowserProxySetting = z.infer<typeof BrowserProxySettingSchema>;
export type BrowserProxySettingInput = z.input<typeof BrowserProxySettingSchema>;

/**
 * The proxy a RUNNING browser was started with, as the browser pane shows it. The address is the
 * proxy's, never a credential; the browser keeps the proxy it started with until it stops, whatever the
 * setting says since.
 */
export const BrowserProxyStatusSchema = z.strictObject({
  url: z.string().min(1).max(512),
  authenticated: z.boolean(),
  bypassCount: NonNegativeIntegerSchema,
});
export type BrowserProxyStatus = z.infer<typeof BrowserProxyStatusSchema>;

/** Who is asking the person on a page to prove they are human: kept beside the browser targets, which the input
 *  request reads too, and named here with the rest of the browser's schemas. */
export { type BrowserChallengeProvider, BrowserChallengeProviderSchema } from './browser-target.ts';

/**
 * A page that appears to be showing a human check — a captcha or a "checking your browser" interstitial.
 * A HINT for the view, recognised from the page's address, title and frames: it can be absent while a
 * check is showing and present on a page that only embeds one. Ferretry never solves one — the view asks
 * the person to take the page over and solve it themselves.
 */
export const BrowserChallengeSchema = z.object({
  provider: BrowserChallengeProviderSchema,
});
export type BrowserChallenge = z.infer<typeof BrowserChallengeSchema>;

export const BrowserActivitySchema = z.enum([
  'start',
  'stop',
  'navigate',
  'click',
  'type',
  'read',
  'screenshot',
  'back',
  'forward',
  'reload',
  'new-page',
  'activate-page',
  'close-page',
  'resize',
  'pointer',
  'keyboard',
  'paste',
]);
export type BrowserActivity = z.infer<typeof BrowserActivitySchema>;

export const BrowserViewportSchema = z.object({
  width: z.number().int().min(BROWSER_MIN_WIDTH).max(BROWSER_MAX_WIDTH),
  height: z.number().int().min(BROWSER_MIN_HEIGHT).max(BROWSER_MAX_HEIGHT),
});
export type BrowserViewport = z.infer<typeof BrowserViewportSchema>;

export const BrowserScreencastFrameSchema = z.object({
  dataBase64: z.string().min(1),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  pageId: z.string().min(1).max(BROWSER_MAX_PAGE_ID_LENGTH),
});
export type BrowserScreencastFrame = z.infer<typeof BrowserScreencastFrameSchema>;

export const BrowserInputEventSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('mouse'),
    type: z.enum(['mouseMoved', 'mousePressed', 'mouseReleased', 'mouseWheel']),
    x: z.number().finite(),
    y: z.number().finite(),
    button: z.enum(['none', 'left', 'middle', 'right', 'back', 'forward']).optional(),
    buttons: NonNegativeIntegerSchema.optional(),
    clickCount: NonNegativeIntegerSchema.optional(),
    deltaX: z.number().finite().optional(),
    deltaY: z.number().finite().optional(),
    modifiers: NonNegativeIntegerSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal('key'),
    type: z.enum(['keyDown', 'keyUp']),
    key: z.string(),
    code: z.string(),
    text: z.string().optional(),
    unmodifiedText: z.string().optional(),
    windowsVirtualKeyCode: NonNegativeIntegerSchema.optional(),
    nativeVirtualKeyCode: NonNegativeIntegerSchema.optional(),
    modifiers: NonNegativeIntegerSchema.optional(),
    autoRepeat: z.boolean().optional(),
    isKeypad: z.boolean().optional(),
  }),
  z.strictObject({ kind: z.literal('insertText'), text: z.string() }),
]);
export type BrowserInputEvent = z.infer<typeof BrowserInputEventSchema>;

export const BrowserLastActorSchema = z.object({
  kind: BrowserActorKindSchema,
  at: InstantSchema,
  action: BrowserActivitySchema,
});
export type BrowserLastActor = z.infer<typeof BrowserLastActorSchema>;

export const BrowserPageSummarySchema = z.object({
  id: z.string().min(1).max(BROWSER_MAX_PAGE_ID_LENGTH),
  url: z.url(),
  title: z.string(),
  /** The page's human name — `app` in `%browser:app` — when it was opened with one. */
  name: SurfaceNameSchema.optional(),
  /** Who opened it by name, as the daemon attests it. Absent for a page nobody opened by name. */
  openedBy: SurfaceOpenerSchema.optional(),
  /**
   * An INCOGNITO page: its own throwaway browser context — its own cookies and storage, nothing shared
   * with the machine's agent profile or with any other page — discarded when it closes or its session
   * ends. Absent means the page uses the shared agent profile.
   */
  incognito: z.literal(true).optional(),
  /** The page that opened this one, when it is a popup. */
  openerId: z.string().min(1).max(BROWSER_MAX_PAGE_ID_LENGTH).optional(),
  /** The page appears to be asking the person to prove they are human. Absent when nothing was seen. */
  challenge: BrowserChallengeSchema.optional(),
  /**
   * The session the page belongs to, and that session's display name — what a reader groups pages by
   * ("Hadi's browser": every page one agent opened, together). Each page has its own window; the
   * grouping is the session, not the window.
   */
  ownerSessionId: z.string().min(1).max(128).optional(),
  ownerName: z.string().min(1).max(128).optional(),
});
export type BrowserPageSummary = z.infer<typeof BrowserPageSummarySchema>;

export const BrowserPageSnapshotSchema = z
  .strictObject({
    url: z.url(),
    title: z.string(),
    pages: z.array(BrowserPageSummarySchema).min(1),
    activePageId: z.string().min(1).max(BROWSER_MAX_PAGE_ID_LENGTH),
    pageState: BrowserPageStateSchema,
    pageError: z.string().optional(),
    canGoBack: z.boolean(),
    canGoForward: z.boolean(),
  })
  .superRefine((value, context) => {
    if (!value.pages.some(page => page.id === value.activePageId)) {
      context.addIssue({ code: 'custom', message: 'activePageId must name a page in pages', path: ['activePageId'] });
    }
    if (value.pageState === 'error' && value.pageError === undefined) {
      context.addIssue({ code: 'custom', message: 'pageError is required in the error state', path: ['pageError'] });
    }
    if (value.pageState !== 'error' && value.pageError !== undefined) {
      context.addIssue({ code: 'custom', message: 'pageError is valid only in the error state', path: ['pageError'] });
    }
  });
export type BrowserPageSnapshot = z.infer<typeof BrowserPageSnapshotSchema>;

/** The most downloads one act reports. */
export const BROWSER_MAX_DOWNLOAD_NOTICES = 20;

/**
 * A download the page started, as an act reports it: the id `browser.download` takes, the name the page
 * suggested (a leaf name, never a path), and its size once it has finished arriving.
 */
export const BrowserDownloadNoticeSchema = z.strictObject({
  id: z.string().regex(/^dl-[a-z0-9]{1,16}$/u),
  name: z.string().min(1).max(255),
  size: z.number().int().min(0).optional(),
  state: z.enum(['ready', 'downloading', 'failed']),
});
export type BrowserDownloadNotice = z.infer<typeof BrowserDownloadNoticeSchema>;

/** A document's host as a page reports it: lowercase, with a port when it has one. */
export const BrowserFieldHostSchema = z
  .string()
  .max(260)
  .regex(/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?(?::[0-9]{1,5})?$/u);

export const BrowserPageActionSnapshotSchema = BrowserPageSnapshotSchema.safeExtend({
  actedPageId: z.string().min(1).max(BROWSER_MAX_PAGE_ID_LENGTH),
  /** Downloads the page started since the last act reported any. Absent when there are none. */
  downloads: z.array(BrowserDownloadNoticeSchema).max(BROWSER_MAX_DOWNLOAD_NOTICES).optional(),
  /** The act typed into a password field — a real secret never belongs in a tool call. */
  passwordField: z.literal(true).optional(),
  /**
   * A `type` act put text in an identifier field (an email or username box): the host of the document that field is
   * in. The daemon keeps what was typed as who this page is signing in (docs/input-requests.md, "Who is signing in").
   */
  identifierHost: BrowserFieldHostSchema.optional(),
});
export type BrowserPageActionSnapshot = z.infer<typeof BrowserPageActionSnapshotSchema>;

export const BrowserAgentPageSchema = z.object({
  pageId: z.string().min(1).max(BROWSER_MAX_PAGE_ID_LENGTH),
  kind: z.literal('agent'),
  action: BrowserActivitySchema,
  at: InstantSchema,
});
export type BrowserAgentPage = z.infer<typeof BrowserAgentPageSchema>;

export const BrowserCapacitySchema = z.object({
  running: NonNegativeIntegerSchema,
  maximum: z.number().int().positive(),
});
export type BrowserCapacity = z.infer<typeof BrowserCapacitySchema>;

const BrowserStatusBaseShape = {
  sessionId: z.string().min(1),
  viewport: BrowserViewportSchema,
  viewers: NonNegativeIntegerSchema,
  persistentProfile: z.literal(true),
  profileKind: BrowserProfileKindSchema.optional(),
  profileSignedIn: z.boolean().optional(),
  idleTimeoutSeconds: NonNegativeIntegerSchema,
  idleDeadline: InstantSchema.optional(),
  startedAt: InstantSchema.optional(),
  agentPage: BrowserAgentPageSchema.optional(),
  lastActor: BrowserLastActorSchema.optional(),
  capacity: BrowserCapacitySchema,
  /** The proxy this running browser was started with. Absent: it goes direct. */
  proxy: BrowserProxyStatusSchema.optional(),
};

const RunningBrowserStatusSchema = BrowserPageSnapshotSchema.safeExtend({
  ...BrowserStatusBaseShape,
  state: z.literal('running'),
});

export const BrowserStatusSchema = z.union([
  z.object({ ...BrowserStatusBaseShape, state: z.literal('stopped'), pages: z.tuple([]) }),
  z.object({ ...BrowserStatusBaseShape, state: z.literal('starting'), pages: z.tuple([]) }),
  RunningBrowserStatusSchema,
  z.object({ ...BrowserStatusBaseShape, state: z.literal('running'), pages: z.tuple([]) }),
  z.object({
    ...BrowserStatusBaseShape,
    state: z.literal('stopping'),
    pages: z.array(BrowserPageSummarySchema),
  }),
  z.object({
    ...BrowserStatusBaseShape,
    state: z.literal('error'),
    pages: z.array(BrowserPageSummarySchema),
    error: z.string().min(1),
  }),
]);
export type BrowserStatus = z.infer<typeof BrowserStatusSchema>;

const BrowserSelectorSchema = z.string().min(1).max(BROWSER_MAX_SELECTOR_LENGTH);

/** The element an act names: a ref from a snapshot, or a selector. */
const BrowserTargetShape = {
  selector: BrowserSelectorSchema.optional(),
  ref: BrowserRefSchema.optional(),
};

export const BrowserActionSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('start') }),
  z.strictObject({ action: z.literal('open'), url: z.url().optional() }),
  z.strictObject({ action: z.literal('stop') }),
  z.strictObject({ action: z.literal('navigate'), url: z.url() }),
  z
    .strictObject({
      action: z.literal('click'),
      ...BrowserTargetShape,
      x: BrowserCoordinateSchema.optional(),
      y: BrowserCoordinateSchema.optional(),
      button: BrowserMouseButtonSchema.optional(),
      double: z.literal(true).optional(),
      modifiers: z.array(BrowserModifierSchema).max(5).optional(),
    })
    .superRefine(refineBrowserTarget({ point: true, required: true })),
  z
    .strictObject({
      action: z.literal('type'),
      ...BrowserTargetShape,
      text: z.string().max(BROWSER_MAX_TEXT_LENGTH),
      /** Press Enter after the text. */
      submit: z.literal(true).optional(),
      /** One key at a time, for a field that reacts to each keystroke, instead of filling it at once. */
      slowly: z.literal(true).optional(),
    })
    .superRefine(refineBrowserTarget({ point: false, required: true })),
  z
    .strictObject({
      action: z.literal('read'),
      ...BrowserTargetShape,
      /**
       * `text` (the default) is the visible text; `a11y` is the accessibility tree as YAML; `snapshot` is
       * that tree with a ref beside every element, which every act accepts.
       */
      mode: BrowserReadModeSchema.optional(),
      /** `snapshot` only: just the lines that contain this text, each with its ref. */
      find: z.string().trim().min(1).max(BROWSER_MAX_FIND_CHARS).optional(),
      depth: z.number().int().min(1).max(BROWSER_MAX_SNAPSHOT_DEPTH).optional(),
      /** `snapshot` only: each element's box in the viewport, for a later act by point. */
      boxes: z.literal(true).optional(),
    })
    .superRefine(refineBrowserTarget({ point: false, required: false }))
    .superRefine(refineBrowserRead),
  z
    .strictObject({
      action: z.literal('screenshot'),
      ...BrowserTargetShape,
      fullPage: z.literal(true).optional(),
      format: BrowserScreenshotFormatSchema.optional(),
    })
    .superRefine(refineBrowserTarget({ point: false, required: false }))
    .superRefine(refineBrowserScreenshot),
  z
    .strictObject({
      action: z.literal('hover'),
      ...BrowserTargetShape,
      x: BrowserCoordinateSchema.optional(),
      y: BrowserCoordinateSchema.optional(),
    })
    .superRefine(refineBrowserTarget({ point: true, required: true })),
  z
    .strictObject({ action: z.literal('drag'), ...browserDragShape(BrowserSelectorSchema) })
    .superRefine(refineBrowserDrag),
  z
    .strictObject({
      action: z.literal('mouse'),
      mouseAction: BrowserMouseActionSchema,
      x: BrowserCoordinateSchema.optional(),
      y: BrowserCoordinateSchema.optional(),
      button: BrowserMouseButtonSchema.optional(),
      deltaX: BrowserScrollDeltaSchema.optional(),
      deltaY: BrowserScrollDeltaSchema.optional(),
    })
    .superRefine((value, context) => refineBrowserMouse({ ...value, action: value.mouseAction }, context)),
  z
    .strictObject({ action: z.literal('press'), keys: BrowserPressKeysSchema, ...BrowserTargetShape })
    .superRefine(refineBrowserTarget({ point: false, required: false })),
  z
    .strictObject({
      action: z.literal('scroll'),
      ...BrowserTargetShape,
      text: z.string().min(1).max(BROWSER_MAX_SCROLL_TEXT_CHARS).optional(),
      deltaX: BrowserScrollDeltaSchema.optional(),
      deltaY: BrowserScrollDeltaSchema.optional(),
      pages: BrowserScrollPagesSchema.optional(),
    })
    .superRefine(refineBrowserScroll),
  z
    .strictObject({ action: z.literal('select'), ...BrowserTargetShape, values: BrowserSelectValuesSchema })
    .superRefine(refineBrowserTarget({ point: false, required: true })),
  z
    .strictObject({ action: z.literal('check'), ...BrowserTargetShape, checked: z.boolean() })
    .superRefine(refineBrowserTarget({ point: false, required: true })),
  z.strictObject({ action: z.literal('fill-form'), fields: browserFormFieldsOf(BrowserSelectorSchema) }),
  z
    .strictObject({ action: z.literal('highlight'), ...BrowserTargetShape, clear: z.literal(true).optional() })
    .superRefine(refineBrowserHighlight),
  z.strictObject({ action: z.literal('back') }),
  z.strictObject({ action: z.literal('forward') }),
  z.strictObject({ action: z.literal('reload') }),
  z.strictObject({ action: z.literal('new-page'), url: z.url().optional(), incognito: z.literal(true).optional() }),
  z.strictObject({ action: z.literal('activate-page'), pageId: z.string().min(1).max(BROWSER_MAX_PAGE_ID_LENGTH) }),
  z.strictObject({ action: z.literal('close-page'), pageId: z.string().min(1).max(BROWSER_MAX_PAGE_ID_LENGTH) }),
  z.strictObject({
    action: z.literal('resize'),
    width: z.number().int().min(BROWSER_MIN_WIDTH).max(BROWSER_MAX_WIDTH),
    height: z.number().int().min(BROWSER_MIN_HEIGHT).max(BROWSER_MAX_HEIGHT),
  }),
  z.strictObject({ action: z.literal('human-activity'), kind: z.enum(['pointer', 'keyboard', 'paste']) }),
]);
export type BrowserAction = z.infer<typeof BrowserActionSchema>;

const BrowserResultPageSchema = BrowserPageSnapshotSchema.safeExtend({
  actedPageId: z.string().min(1).max(BROWSER_MAX_PAGE_ID_LENGTH).optional(),
  downloads: z.array(BrowserDownloadNoticeSchema).max(BROWSER_MAX_DOWNLOAD_NOTICES).optional(),
  passwordField: z.literal(true).optional(),
  identifierHost: BrowserFieldHostSchema.optional(),
});

/** Actual action responses carry status plus an optional shape-specific result. */
export const BrowserActionResultSchema = z.union([
  z.strictObject({
    status: RunningBrowserStatusSchema,
    result: BrowserResultPageSchema.safeExtend({ text: z.string() }),
  }),
  z.strictObject({
    status: RunningBrowserStatusSchema,
    result: BrowserResultPageSchema.safeExtend({
      screenshotBase64: z.string().min(1),
      /** Absent from an older worker, whose screenshots are always PNG. */
      screenshotFormat: BrowserScreenshotFormatSchema.optional(),
    }),
  }),
  z.strictObject({ status: RunningBrowserStatusSchema, result: BrowserResultPageSchema }),
  z.strictObject({ status: BrowserStatusSchema }),
]);
export type BrowserActionResult = z.infer<typeof BrowserActionResultSchema>;

export const BrowserErrorCodeSchema = z.enum([
  'bad_request',
  'not_found',
  'forbidden',
  'capacity',
  'not_running',
  'profile_busy',
  'login_window_open',
  'launch_failed',
  'upstream_failed',
]);
export type BrowserErrorCode = z.infer<typeof BrowserErrorCodeSchema>;
