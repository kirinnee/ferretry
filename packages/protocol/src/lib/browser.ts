import { z } from 'zod';
import { InstantSchema, NonNegativeIntegerSchema } from './common.ts';

export const BROWSER_MAX_INSTANCES = 3;
export const BROWSER_MIN_WIDTH = 320;
export const BROWSER_MIN_HEIGHT = 240;
export const BROWSER_MAX_WIDTH = 1_920;
export const BROWSER_MAX_HEIGHT = 1_200;
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

export const BrowserPageActionSnapshotSchema = BrowserPageSnapshotSchema.safeExtend({
  actedPageId: z.string().min(1).max(BROWSER_MAX_PAGE_ID_LENGTH),
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

export const BrowserActionSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('start') }),
  z.strictObject({ action: z.literal('open'), url: z.url().optional() }),
  z.strictObject({ action: z.literal('stop') }),
  z.strictObject({ action: z.literal('navigate'), url: z.url() }),
  z.strictObject({ action: z.literal('click'), selector: z.string().min(1).max(BROWSER_MAX_SELECTOR_LENGTH) }),
  z.strictObject({
    action: z.literal('type'),
    selector: z.string().min(1).max(BROWSER_MAX_SELECTOR_LENGTH),
    text: z.string().max(BROWSER_MAX_TEXT_LENGTH),
  }),
  z.strictObject({
    action: z.literal('read'),
    selector: z.string().min(1).max(BROWSER_MAX_SELECTOR_LENGTH).optional(),
  }),
  z.strictObject({ action: z.literal('screenshot') }),
  z.strictObject({ action: z.literal('back') }),
  z.strictObject({ action: z.literal('forward') }),
  z.strictObject({ action: z.literal('reload') }),
  z.strictObject({ action: z.literal('new-page'), url: z.url().optional() }),
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
});

/** Actual action responses carry status plus an optional shape-specific result. */
export const BrowserActionResultSchema = z.union([
  z.strictObject({
    status: RunningBrowserStatusSchema,
    result: BrowserResultPageSchema.safeExtend({ text: z.string() }),
  }),
  z.strictObject({
    status: RunningBrowserStatusSchema,
    result: BrowserResultPageSchema.safeExtend({ screenshotBase64: z.string().min(1) }),
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
