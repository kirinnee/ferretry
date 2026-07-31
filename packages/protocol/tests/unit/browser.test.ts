import { describe, it } from 'bun:test';
import should from 'should';
import * as browser from '../../src/lib/browser.ts';
import type {
  BrowserAction,
  BrowserActionResult,
  BrowserAgentPage,
  BrowserCapacity,
  BrowserInputEvent,
  BrowserLastActor,
  BrowserPageActionSnapshot,
  BrowserPageSnapshot,
  BrowserPageSummary,
  BrowserScreencastFrame,
  BrowserStatus,
  BrowserViewport,
} from '../../src/lib/index.ts';
import { INSTANT, LATER_INSTANT } from '../fixtures.ts';
import { assertCoversEverySchema, assertRejects, assertRoundTrips, type SchemaCase } from './schema-cases.ts';

const viewport = { width: 1_280, height: 800 } satisfies BrowserViewport;

const homePage = { id: 'page-1', url: 'https://example.com/', title: 'Example' } satisfies BrowserPageSummary;
const docsPage = { id: 'page-2', url: 'https://example.com/docs', title: 'Docs' } satisfies BrowserPageSummary;

const readySnapshot = {
  url: homePage.url,
  title: homePage.title,
  pages: [homePage, docsPage],
  activePageId: homePage.id,
  pageState: 'ready',
  canGoBack: true,
  canGoForward: false,
} satisfies BrowserPageSnapshot;

const failedSnapshot = {
  ...readySnapshot,
  pageState: 'error',
  pageError: 'net::ERR_CONNECTION_REFUSED',
} satisfies BrowserPageSnapshot;

const actionSnapshot = { ...readySnapshot, actedPageId: docsPage.id } satisfies BrowserPageActionSnapshot;

const screencastFrame = {
  dataBase64: 'aGVsbG8=',
  width: viewport.width,
  height: viewport.height,
  pageId: homePage.id,
} satisfies BrowserScreencastFrame;

const lastActor = { kind: 'human', at: INSTANT, action: 'click' } satisfies BrowserLastActor;
const agentPage = {
  pageId: docsPage.id,
  kind: 'agent',
  action: 'navigate',
  at: LATER_INSTANT,
} satisfies BrowserAgentPage;
const capacity = { running: 1, maximum: browser.BROWSER_MAX_INSTANCES } satisfies BrowserCapacity;

const statusBase = {
  sessionId: 'session-1',
  viewport,
  viewers: 2,
  persistentProfile: true,
  profileKind: 'session',
  profileSignedIn: false,
  idleTimeoutSeconds: 300,
  idleDeadline: LATER_INSTANT,
  startedAt: INSTANT,
  agentPage,
  lastActor,
  capacity,
} as const;

const runningStatus = { ...statusBase, ...readySnapshot, state: 'running' } satisfies BrowserStatus;
const stoppedStatus = { ...statusBase, state: 'stopped', pages: [] } satisfies BrowserStatus;
const startingStatus = { ...statusBase, state: 'starting', pages: [] } satisfies BrowserStatus;
/** A browser that has launched but not yet opened its first tab. */
const emptyRunningStatus = { ...statusBase, state: 'running', pages: [] } satisfies BrowserStatus;
const stoppingStatus = { ...statusBase, state: 'stopping', pages: [homePage] } satisfies BrowserStatus;
const errorStatus = {
  ...statusBase,
  state: 'error',
  pages: [],
  error: 'chromium exited with code 1',
} satisfies BrowserStatus;

const mouseEvent = {
  kind: 'mouse',
  type: 'mousePressed',
  x: 120.5,
  y: 240.25,
  button: 'left',
  buttons: 1,
  clickCount: 1,
  deltaX: 0,
  deltaY: 0,
  modifiers: 0,
} satisfies BrowserInputEvent;

const keyEvent = {
  kind: 'key',
  type: 'keyDown',
  key: 'Enter',
  code: 'Enter',
  text: '\r',
  unmodifiedText: '\r',
  windowsVirtualKeyCode: 13,
  nativeVirtualKeyCode: 13,
  modifiers: 0,
  autoRepeat: false,
  isKeypad: false,
} satisfies BrowserInputEvent;

const insertTextEvent = { kind: 'insertText', text: 'ferretry' } satisfies BrowserInputEvent;

const readResult = {
  status: runningStatus,
  result: { ...actionSnapshot, text: 'Example body copy' },
} satisfies BrowserActionResult;

const screenshotResult = {
  status: runningStatus,
  result: { ...actionSnapshot, screenshotBase64: 'aGVsbG8=' },
} satisfies BrowserActionResult;

const navigateResult = { status: runningStatus, result: actionSnapshot } satisfies BrowserActionResult;
const stopResult = { status: stoppedStatus } satisfies BrowserActionResult;

const browserCases: SchemaCase[] = [
  { name: 'lifecycle', schema: browser.BrowserLifecycleSchema, value: 'running' },
  { name: 'actor kind', schema: browser.BrowserActorKindSchema, value: 'human' },
  { name: 'profile kind', schema: browser.BrowserProfileKindSchema, value: 'session' },
  { name: 'page state', schema: browser.BrowserPageStateSchema, value: 'ready' },
  { name: 'activity', schema: browser.BrowserActivitySchema, value: 'navigate' },
  { name: 'viewport', schema: browser.BrowserViewportSchema, value: viewport },
  { name: 'screencast frame', schema: browser.BrowserScreencastFrameSchema, value: screencastFrame },
  { name: 'input event', schema: browser.BrowserInputEventSchema, value: mouseEvent },
  { name: 'last actor', schema: browser.BrowserLastActorSchema, value: lastActor },
  { name: 'page summary', schema: browser.BrowserPageSummarySchema, value: homePage },
  { name: 'page snapshot', schema: browser.BrowserPageSnapshotSchema, value: readySnapshot },
  { name: 'page action snapshot', schema: browser.BrowserPageActionSnapshotSchema, value: actionSnapshot },
  { name: 'agent page', schema: browser.BrowserAgentPageSchema, value: agentPage },
  { name: 'capacity', schema: browser.BrowserCapacitySchema, value: capacity },
  { name: 'status', schema: browser.BrowserStatusSchema, value: runningStatus },
  { name: 'action', schema: browser.BrowserActionSchema, value: { action: 'navigate', url: homePage.url } },
  { name: 'action result', schema: browser.BrowserActionResultSchema, value: navigateResult },
  { name: 'error code', schema: browser.BrowserErrorCodeSchema, value: 'not_running' },
];

describe('browser schemas', () => {
  it('should round-trip every public browser schema', () => {
    // Arrange
    const cases = browserCases;

    // Act + Assert
    assertRoundTrips(cases);
    assertCoversEverySchema(browser, cases);
  });

  it('should resolve every lifecycle, actor, profile, page-state, activity, and error enum member', () => {
    // Arrange
    const enums = [
      { schema: browser.BrowserLifecycleSchema, members: ['stopped', 'starting', 'running', 'stopping', 'error'] },
      { schema: browser.BrowserActorKindSchema, members: ['agent', 'human'] },
      { schema: browser.BrowserProfileKindSchema, members: ['shared', 'session'] },
      { schema: browser.BrowserPageStateSchema, members: ['loading', 'ready', 'error'] },
      {
        schema: browser.BrowserActivitySchema,
        members: [
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
        ],
      },
      {
        schema: browser.BrowserErrorCodeSchema,
        members: [
          'bad_request',
          'not_found',
          'forbidden',
          'capacity',
          'not_running',
          'profile_busy',
          'login_window_open',
          'launch_failed',
          'upstream_failed',
        ],
      },
    ];

    // Act + Assert
    for (const entry of enums) {
      for (const member of entry.members) should(entry.schema.parse(member)).equal(member);
      should(entry.schema.safeParse('nonesuch').success).be.false();
    }
  });

  it('should resolve every input-event union member and mouse or key type', () => {
    // Arrange
    const mouseTypes = ['mouseMoved', 'mousePressed', 'mouseReleased', 'mouseWheel'];
    const buttons = ['none', 'left', 'middle', 'right', 'back', 'forward'];
    const minimalEvents = [
      { kind: 'mouse', type: 'mouseMoved', x: 0, y: 0 },
      { kind: 'key', type: 'keyUp', key: 'a', code: 'KeyA' },
      insertTextEvent,
    ];

    // Act
    const parsed = [mouseEvent, keyEvent, insertTextEvent].map(value => browser.BrowserInputEventSchema.parse(value));

    // Assert
    should(parsed).deepEqual([mouseEvent, keyEvent, insertTextEvent]);
    for (const type of mouseTypes) {
      should(browser.BrowserInputEventSchema.parse({ ...mouseEvent, type })).deepEqual({ ...mouseEvent, type });
    }
    for (const button of buttons)
      should(browser.BrowserInputEventSchema.safeParse({ ...mouseEvent, button }).success).be.true();
    for (const type of ['keyDown', 'keyUp']) {
      should(browser.BrowserInputEventSchema.parse({ ...keyEvent, type })).deepEqual({ ...keyEvent, type });
    }
    for (const value of minimalEvents) should(browser.BrowserInputEventSchema.safeParse(value).success).be.true();
  });

  it('should resolve every action union member', () => {
    // Arrange
    const actions = [
      { action: 'start' },
      { action: 'open' },
      { action: 'open', url: homePage.url },
      { action: 'stop' },
      { action: 'navigate', url: docsPage.url },
      { action: 'click', selector: '#submit' },
      { action: 'type', selector: 'input[name=q]', text: 'ferretry' },
      { action: 'read' },
      { action: 'read', selector: 'main' },
      { action: 'screenshot' },
      { action: 'back' },
      { action: 'forward' },
      { action: 'reload' },
      { action: 'new-page' },
      { action: 'new-page', url: docsPage.url },
      { action: 'activate-page', pageId: docsPage.id },
      { action: 'close-page', pageId: docsPage.id },
      { action: 'resize', width: browser.BROWSER_MIN_WIDTH, height: browser.BROWSER_MIN_HEIGHT },
      { action: 'human-activity', kind: 'pointer' },
      { action: 'human-activity', kind: 'keyboard' },
      { action: 'human-activity', kind: 'paste' },
    ] satisfies BrowserAction[];

    // Act
    const parsed = actions.map(value => browser.BrowserActionSchema.parse(value));

    // Assert
    should(parsed).deepEqual(actions);
    should(new Set(parsed.map(entry => entry.action)).size).equal(16);
  });

  it('should resolve every browser-status union member including the empty running transient', () => {
    // Arrange
    const statuses = [stoppedStatus, startingStatus, runningStatus, emptyRunningStatus, stoppingStatus, errorStatus];

    // Act
    const parsed = statuses.map(value => browser.BrowserStatusSchema.parse(value));

    // Assert
    should(parsed).deepEqual(statuses);
    should(parsed.map(entry => entry.state)).deepEqual([
      'stopped',
      'starting',
      'running',
      'running',
      'stopping',
      'error',
    ]);
    should(parsed[3]?.pages).deepEqual([]);
  });

  it('should resolve a minimal status that omits every optional field', () => {
    // Arrange
    const minimal = {
      sessionId: 'session-1',
      viewport,
      viewers: 0,
      persistentProfile: true,
      idleTimeoutSeconds: 0,
      capacity: { running: 0, maximum: browser.BROWSER_MAX_INSTANCES },
      state: 'stopped',
      pages: [],
    };

    // Act
    const parsed = browser.BrowserStatusSchema.parse(minimal);

    // Assert
    should(parsed).deepEqual(minimal);
  });

  it('should resolve every action-result union member', () => {
    // Arrange
    const results = [readResult, screenshotResult, navigateResult, stopResult];

    // Act
    const parsed = results.map(value => browser.BrowserActionResultSchema.parse(value));

    // Assert
    should(parsed).deepEqual(results);
    should(browser.BrowserActionResultSchema.safeParse({ status: errorStatus }).success).be.true();
    should(
      browser.BrowserActionResultSchema.safeParse({ status: runningStatus, result: readySnapshot }).success,
    ).be.true();
  });

  it('should reject unknown keys on strict input events and actions', () => {
    // Arrange
    const cases: SchemaCase[] = [
      { name: 'unknown mouse key', schema: browser.BrowserInputEventSchema, value: { ...mouseEvent, pressure: 1 } },
      { name: 'unknown key-event key', schema: browser.BrowserInputEventSchema, value: { ...keyEvent, location: 1 } },
      {
        name: 'unknown insert-text key',
        schema: browser.BrowserInputEventSchema,
        value: { ...insertTextEvent, selector: 'input' },
      },
      { name: 'unknown event kind', schema: browser.BrowserInputEventSchema, value: { kind: 'touch', x: 0, y: 0 } },
      {
        name: 'non-finite coordinate',
        schema: browser.BrowserInputEventSchema,
        value: { ...mouseEvent, x: Number.NaN },
      },
      {
        name: 'fractional modifiers',
        schema: browser.BrowserInputEventSchema,
        value: { ...mouseEvent, modifiers: 1.5 },
      },
      {
        name: 'unknown mouse type',
        schema: browser.BrowserInputEventSchema,
        value: { ...mouseEvent, type: 'mouseDown' },
      },
      {
        name: 'key event without code',
        schema: browser.BrowserInputEventSchema,
        value: { kind: 'key', type: 'keyDown', key: 'a' },
      },
      { name: 'unknown action key', schema: browser.BrowserActionSchema, value: { action: 'start', force: true } },
      { name: 'unknown action', schema: browser.BrowserActionSchema, value: { action: 'evaluate', script: '1' } },
      { name: 'navigate without url', schema: browser.BrowserActionSchema, value: { action: 'navigate' } },
      {
        name: 'navigate with a malformed url',
        schema: browser.BrowserActionSchema,
        value: { action: 'navigate', url: 'example.com' },
      },
      { name: 'click without a selector', schema: browser.BrowserActionSchema, value: { action: 'click' } },
      {
        name: 'click with an empty selector',
        schema: browser.BrowserActionSchema,
        value: { action: 'click', selector: '' },
      },
      {
        name: 'unknown human activity',
        schema: browser.BrowserActionSchema,
        value: { action: 'human-activity', kind: 'scroll' },
      },
    ];

    // Act + Assert
    assertRejects(cases);
  });

  it('should reject page snapshots whose active page, state, and error disagree', () => {
    // Arrange
    const cases: SchemaCase[] = [
      {
        name: 'active page missing from pages',
        schema: browser.BrowserPageSnapshotSchema,
        value: { ...readySnapshot, activePageId: 'page-9' },
      },
      { name: 'no pages at all', schema: browser.BrowserPageSnapshotSchema, value: { ...readySnapshot, pages: [] } },
      {
        name: 'error state without an error',
        schema: browser.BrowserPageSnapshotSchema,
        value: { ...readySnapshot, pageState: 'error' },
      },
      {
        name: 'error carried outside the error state',
        schema: browser.BrowserPageSnapshotSchema,
        value: { ...readySnapshot, pageError: 'boom' },
      },
      {
        name: 'loading state carrying an error',
        schema: browser.BrowserPageSnapshotSchema,
        value: { ...failedSnapshot, pageState: 'loading' },
      },
      {
        name: 'action snapshot inheriting the active-page rule',
        schema: browser.BrowserPageActionSnapshotSchema,
        value: { ...actionSnapshot, activePageId: 'page-9' },
      },
      {
        name: 'action snapshot inheriting the error rule',
        schema: browser.BrowserPageActionSnapshotSchema,
        value: { ...actionSnapshot, pageError: 'boom' },
      },
      {
        name: 'action snapshot without an acted page',
        schema: browser.BrowserPageActionSnapshotSchema,
        value: readySnapshot,
      },
      {
        name: 'snapshot carrying an unknown key',
        schema: browser.BrowserPageSnapshotSchema,
        value: { ...readySnapshot, favicon: 'data:,' },
      },
      {
        name: 'action snapshot carrying an unknown key',
        schema: browser.BrowserPageActionSnapshotSchema,
        value: { ...actionSnapshot, favicon: 'data:,' },
      },
      {
        name: 'snapshot carrying the acted page of an action snapshot',
        schema: browser.BrowserPageSnapshotSchema,
        value: actionSnapshot,
      },
      {
        name: 'page summary with a malformed url',
        schema: browser.BrowserPageSummarySchema,
        value: { ...homePage, url: 'nowhere' },
      },
      {
        name: 'page summary with an empty id',
        schema: browser.BrowserPageSummarySchema,
        value: { ...homePage, id: '' },
      },
    ];

    // Act + Assert
    assertRejects(cases);
  });

  it('should accept the error page state only when it carries an error', () => {
    // Arrange
    const states = [{ ...readySnapshot, pageState: 'loading' }, readySnapshot, failedSnapshot];

    // Act
    const parsed = states.map(value => browser.BrowserPageSnapshotSchema.parse(value));

    // Assert
    should(parsed.map(entry => entry.pageState)).deepEqual(['loading', 'ready', 'error']);
    should(parsed[2]?.pageError).equal(failedSnapshot.pageError);
  });

  it('should reject statuses whose state and pages disagree', () => {
    // Arrange
    const cases: SchemaCase[] = [
      {
        name: 'stopped with pages',
        schema: browser.BrowserStatusSchema,
        value: { ...stoppedStatus, pages: [homePage] },
      },
      {
        name: 'starting with pages',
        schema: browser.BrowserStatusSchema,
        value: { ...startingStatus, pages: [homePage] },
      },
      {
        name: 'error without a message',
        schema: browser.BrowserStatusSchema,
        value: { ...statusBase, state: 'error', pages: [] },
      },
      {
        name: 'error with an empty message',
        schema: browser.BrowserStatusSchema,
        value: { ...errorStatus, error: '' },
      },
      {
        name: 'running with an unknown active page',
        schema: browser.BrowserStatusSchema,
        value: { ...runningStatus, activePageId: 'page-9' },
      },
      {
        name: 'running in the error page state without an error',
        schema: browser.BrowserStatusSchema,
        value: { ...runningStatus, pageState: 'error' },
      },
      {
        name: 'running with pages but no snapshot',
        schema: browser.BrowserStatusSchema,
        value: { ...statusBase, state: 'running', pages: [homePage] },
      },
      { name: 'unknown state', schema: browser.BrowserStatusSchema, value: { ...stoppedStatus, state: 'paused' } },
      {
        name: 'non-persistent profile',
        schema: browser.BrowserStatusSchema,
        value: { ...stoppedStatus, persistentProfile: false },
      },
      {
        name: 'unknown profile kind',
        schema: browser.BrowserStatusSchema,
        value: { ...stoppedStatus, profileKind: 'incognito' },
      },
      { name: 'empty session id', schema: browser.BrowserStatusSchema, value: { ...stoppedStatus, sessionId: '' } },
      {
        name: 'unanchored idle deadline',
        schema: browser.BrowserStatusSchema,
        value: { ...stoppedStatus, idleDeadline: '2026-07-30T12:00:00' },
      },
      {
        name: 'agent page claiming a human actor',
        schema: browser.BrowserAgentPageSchema,
        value: { ...agentPage, kind: 'human' },
      },
      {
        name: 'capacity without a maximum',
        schema: browser.BrowserCapacitySchema,
        value: { running: 1, maximum: 0 },
      },
      {
        name: 'negative running count',
        schema: browser.BrowserCapacitySchema,
        value: { running: -1, maximum: browser.BROWSER_MAX_INSTANCES },
      },
      {
        name: 'last actor with an unknown action',
        schema: browser.BrowserLastActorSchema,
        value: { ...lastActor, action: 'scroll' },
      },
    ];

    // Act + Assert
    assertRejects(cases);
  });

  it('should reject action results that pair a non-running status with a page result', () => {
    // Arrange
    const cases: SchemaCase[] = [
      {
        name: 'stopped status with a result',
        schema: browser.BrowserActionResultSchema,
        value: { status: stoppedStatus, result: actionSnapshot },
      },
      {
        name: 'result contradicting the active-page rule',
        schema: browser.BrowserActionResultSchema,
        value: { status: runningStatus, result: { ...actionSnapshot, activePageId: 'page-9' } },
      },
      {
        name: 'empty screenshot payload',
        schema: browser.BrowserActionResultSchema,
        value: { status: runningStatus, result: { ...actionSnapshot, screenshotBase64: '' } },
      },
      {
        name: 'unknown envelope key',
        schema: browser.BrowserActionResultSchema,
        value: { status: runningStatus, result: actionSnapshot, elapsedMs: 12 },
      },
      {
        name: 'unknown result key',
        schema: browser.BrowserActionResultSchema,
        value: { status: runningStatus, result: { ...actionSnapshot, favicon: 'data:,' } },
      },
      { name: 'no status at all', schema: browser.BrowserActionResultSchema, value: { result: actionSnapshot } },
    ];

    // Act + Assert
    assertRejects(cases);
  });

  it('should hold viewport, identifier, and payload sizes to their documented bounds', () => {
    // Arrange
    const maxSelector = 'a'.repeat(browser.BROWSER_MAX_SELECTOR_LENGTH);
    const maxPageId = 'p'.repeat(browser.BROWSER_MAX_PAGE_ID_LENGTH);
    const accepted = [
      { width: browser.BROWSER_MIN_WIDTH, height: browser.BROWSER_MIN_HEIGHT },
      { width: browser.BROWSER_MAX_WIDTH, height: browser.BROWSER_MAX_HEIGHT },
    ];
    const rejected: SchemaCase[] = [
      {
        name: 'width below the minimum',
        schema: browser.BrowserViewportSchema,
        value: { width: browser.BROWSER_MIN_WIDTH - 1, height: viewport.height },
      },
      {
        name: 'height below the minimum',
        schema: browser.BrowserViewportSchema,
        value: { width: viewport.width, height: browser.BROWSER_MIN_HEIGHT - 1 },
      },
      {
        name: 'width above the maximum',
        schema: browser.BrowserViewportSchema,
        value: { width: browser.BROWSER_MAX_WIDTH + 1, height: viewport.height },
      },
      {
        name: 'height above the maximum',
        schema: browser.BrowserViewportSchema,
        value: { width: viewport.width, height: browser.BROWSER_MAX_HEIGHT + 1 },
      },
      {
        name: 'fractional viewport',
        schema: browser.BrowserViewportSchema,
        value: { width: 1_280.5, height: viewport.height },
      },
      {
        name: 'resize outside the viewport bounds',
        schema: browser.BrowserActionSchema,
        value: { action: 'resize', width: browser.BROWSER_MAX_WIDTH + 1, height: viewport.height },
      },
      {
        name: 'selector above the maximum length',
        schema: browser.BrowserActionSchema,
        value: { action: 'click', selector: `${maxSelector}a` },
      },
      {
        name: 'typed text above the maximum length',
        schema: browser.BrowserActionSchema,
        value: { action: 'type', selector: '#q', text: 'a'.repeat(browser.BROWSER_MAX_TEXT_LENGTH + 1) },
      },
      {
        name: 'page id above the maximum length',
        schema: browser.BrowserActionSchema,
        value: { action: 'activate-page', pageId: `${maxPageId}p` },
      },
      {
        name: 'screencast frame without data',
        schema: browser.BrowserScreencastFrameSchema,
        value: { ...screencastFrame, dataBase64: '' },
      },
      {
        name: 'screencast frame with a zero dimension',
        schema: browser.BrowserScreencastFrameSchema,
        value: { ...screencastFrame, height: 0 },
      },
      {
        name: 'screencast frame with a fractional width',
        schema: browser.BrowserScreencastFrameSchema,
        value: { ...screencastFrame, width: 10.5 },
      },
      {
        name: 'screencast frame without a page id',
        schema: browser.BrowserScreencastFrameSchema,
        value: { ...screencastFrame, pageId: undefined },
      },
      {
        name: 'screencast frame with an empty page id',
        schema: browser.BrowserScreencastFrameSchema,
        value: { ...screencastFrame, pageId: '' },
      },
      {
        name: 'screencast frame with an overlong page id',
        schema: browser.BrowserScreencastFrameSchema,
        value: { ...screencastFrame, pageId: `${maxPageId}p` },
      },
    ];

    // Act + Assert
    for (const value of accepted) should(browser.BrowserViewportSchema.parse(value)).deepEqual(value);
    should(browser.BrowserActionSchema.safeParse({ action: 'click', selector: maxSelector }).success).be.true();
    should(browser.BrowserActionSchema.safeParse({ action: 'activate-page', pageId: maxPageId }).success).be.true();
    should(
      browser.BrowserActionSchema.safeParse({
        action: 'type',
        selector: '#q',
        text: 'a'.repeat(browser.BROWSER_MAX_TEXT_LENGTH),
      }).success,
    ).be.true();
    should(browser.BrowserScreencastFrameSchema.safeParse({ ...screencastFrame, pageId: maxPageId }).success).be.true();
    assertRejects(rejected);
  });
});
