import { describe, it } from 'bun:test';
import should from 'should';
import type {
  CloseTerminalResponse,
  CreateTerminalRequest,
  RenameTerminalRequest,
  TerminalListView,
  TerminalResizeFrame,
  TerminalSize,
  TerminalView,
} from '../../src/lib/index.ts';
import * as terminal from '../../src/lib/terminal.ts';
import { INSTANT, LATER_INSTANT } from '../fixtures.ts';
import { assertCoversEverySchema, assertRejects, assertRoundTrips, type SchemaCase } from './schema-cases.ts';

const SESSION_ID = 'session-1';
const VIEWED_ID = 'a1b2c3d4e5f6';
const IDLE_ID = '0f1e2d3c4b5a';

const size = { cols: 80, rows: 24 } satisfies TerminalSize;

const viewedTerminal = {
  id: VIEWED_ID,
  sessionId: SESSION_ID,
  title: 'build',
  state: 'running',
  cols: size.cols,
  rows: size.rows,
  viewers: 2,
  openedBy: { by: 'agent', sessionId: 'mse7wwti-2a75bd9c' },
  createdAt: INSTANT,
  lastActivityAt: LATER_INSTANT,
} satisfies TerminalView;

/** With nobody watching, the terminal carries the deadline that will reap it. */
const idleTerminal = {
  ...viewedTerminal,
  id: IDLE_ID,
  title: 'logs',
  viewers: 0,
  idleDeadline: LATER_INSTANT,
} satisfies TerminalView;

const listView = {
  sessionId: SESSION_ID,
  terminals: [viewedTerminal, idleTerminal],
  limits: {
    perSession: terminal.TERMINAL_MAX_PER_SESSION,
    global: terminal.TERMINAL_MAX_GLOBAL,
    runningGlobal: 2,
    idleTimeoutSeconds: 300,
    scrollbackLines: terminal.TERMINAL_SCROLLBACK_LINES,
  },
} satisfies TerminalListView;

const emptyListView = { ...listView, terminals: [], limits: { ...listView.limits, runningGlobal: 0 } };

const createRequest = { title: 'build', cols: size.cols, rows: size.rows } satisfies CreateTerminalRequest;
const renameRequest = { title: 'tests' } satisfies RenameTerminalRequest;
const closeResponse = { closed: true, id: VIEWED_ID } satisfies CloseTerminalResponse;
const resizeFrame = { type: 'resize', cols: 120, rows: 40 } satisfies TerminalResizeFrame;
const binaryFrame = new Uint8Array([0x1b, 0x5b, 0x30, 0x6d]);

const terminalCases: SchemaCase[] = [
  { name: 'terminal id', schema: terminal.TerminalIdSchema, value: VIEWED_ID },
  { name: 'size', schema: terminal.TerminalSizeSchema, value: size },
  { name: 'view', schema: terminal.TerminalViewSchema, value: viewedTerminal },
  { name: 'list view', schema: terminal.TerminalListViewSchema, value: listView },
  { name: 'create request', schema: terminal.CreateTerminalRequestSchema, value: createRequest },
  { name: 'rename request', schema: terminal.RenameTerminalRequestSchema, value: renameRequest },
  { name: 'close response', schema: terminal.CloseTerminalResponseSchema, value: closeResponse },
  { name: 'resize frame', schema: terminal.TerminalResizeFrameSchema, value: resizeFrame },
  { name: 'binary frame', schema: terminal.TerminalBinaryFrameSchema, value: binaryFrame },
  { name: 'error code', schema: terminal.TerminalErrorCodeSchema, value: 'capacity' },
];

describe('terminal schemas', () => {
  it('should round-trip every public terminal schema', () => {
    // Arrange
    const cases = terminalCases;

    // Act + Assert
    assertRoundTrips(cases);
    assertCoversEverySchema(terminal, cases);
  });

  it('should keep the documented capacity and geometry bounds ordered', () => {
    // Arrange
    const bounds = [
      { low: terminal.TERMINAL_MIN_COLUMNS, high: terminal.TERMINAL_MAX_COLUMNS },
      { low: terminal.TERMINAL_MIN_ROWS, high: terminal.TERMINAL_MAX_ROWS },
      { low: terminal.TERMINAL_MAX_PER_SESSION, high: terminal.TERMINAL_MAX_GLOBAL },
    ];

    // Act
    const parsed = terminal.TerminalListViewSchema.parse(listView);

    // Assert
    for (const bound of bounds) should(bound.low).be.below(bound.high);
    should(terminal.TERMINAL_MAX_TITLE_LENGTH).be.above(0);
    should(terminal.TERMINAL_SCROLLBACK_LINES).be.above(0);
    should(parsed.limits.perSession).equal(terminal.TERMINAL_MAX_PER_SESSION);
    should(parsed.limits.global).equal(terminal.TERMINAL_MAX_GLOBAL);
    should(parsed.limits.scrollbackLines).equal(terminal.TERMINAL_SCROLLBACK_LINES);
  });

  it('should resolve every terminal error-code member', () => {
    // Arrange
    const members = ['bad_request', 'not_found', 'forbidden', 'capacity', 'unavailable', 'upstream_failed'];

    // Act + Assert
    for (const member of members) should(terminal.TerminalErrorCodeSchema.parse(member)).equal(member);
    should(terminal.TerminalErrorCodeSchema.safeParse('not_running').success).be.false();
    should(terminal.TerminalErrorCodeSchema.options).have.length(members.length);
  });

  it('should accept only twelve-character lowercase hexadecimal terminal ids', () => {
    // Arrange
    const accepted = [VIEWED_ID, IDLE_ID, '000000000000', 'ffffffffffff'];
    const cases: SchemaCase[] = [
      { name: 'uppercase', schema: terminal.TerminalIdSchema, value: VIEWED_ID.toUpperCase() },
      { name: 'too short', schema: terminal.TerminalIdSchema, value: VIEWED_ID.slice(0, 11) },
      { name: 'too long', schema: terminal.TerminalIdSchema, value: `${VIEWED_ID}0` },
      { name: 'non-hexadecimal', schema: terminal.TerminalIdSchema, value: 'g1b2c3d4e5f6' },
      { name: 'empty', schema: terminal.TerminalIdSchema, value: '' },
      { name: 'padded', schema: terminal.TerminalIdSchema, value: ` ${VIEWED_ID}` },
      {
        name: 'view with a malformed id',
        schema: terminal.TerminalViewSchema,
        value: { ...viewedTerminal, id: 'abc' },
      },
      {
        name: 'close response with a malformed id',
        schema: terminal.CloseTerminalResponseSchema,
        value: { ...closeResponse, id: 'abc' },
      },
    ];

    // Act + Assert
    for (const value of accepted) should(terminal.TerminalIdSchema.parse(value)).equal(value);
    assertRejects(cases);
  });

  it('should hold titles to their trimmed length and forbid control or format characters', () => {
    // Arrange
    const maxTitle = 't'.repeat(terminal.TERMINAL_MAX_TITLE_LENGTH);
    const cases: SchemaCase[] = [
      { name: 'empty title', schema: terminal.RenameTerminalRequestSchema, value: { title: '' } },
      { name: 'whitespace-only title', schema: terminal.RenameTerminalRequestSchema, value: { title: '   ' } },
      {
        name: 'title above the maximum',
        schema: terminal.RenameTerminalRequestSchema,
        value: { title: `${maxTitle}t` },
      },
      { name: 'newline inside the title', schema: terminal.RenameTerminalRequestSchema, value: { title: 'a\nb' } },
      { name: 'tab inside the title', schema: terminal.RenameTerminalRequestSchema, value: { title: 'a\tb' } },
      {
        name: 'escape inside the title',
        schema: terminal.RenameTerminalRequestSchema,
        value: { title: 'a\u001b[0mb' },
      },
      { name: 'null inside the title', schema: terminal.RenameTerminalRequestSchema, value: { title: 'a\u0000b' } },
      {
        name: 'left-to-right mark inside the title',
        schema: terminal.RenameTerminalRequestSchema,
        value: { title: 'a\u200eb' },
      },
      {
        name: 'view with a control-character title',
        schema: terminal.TerminalViewSchema,
        value: { ...viewedTerminal, title: 'a\rb' },
      },
      { name: 'create with an empty title', schema: terminal.CreateTerminalRequestSchema, value: { title: '' } },
      { name: 'non-string title', schema: terminal.RenameTerminalRequestSchema, value: { title: 7 } },
    ];

    // Act
    const trimmed = terminal.RenameTerminalRequestSchema.parse({ title: '  build  ' });

    // Assert
    should(trimmed).deepEqual({ title: 'build' });
    should(terminal.RenameTerminalRequestSchema.parse({ title: maxTitle }).title).equal(maxTitle);
    should(terminal.RenameTerminalRequestSchema.parse({ title: 'build ✅' }).title).equal('build ✅');
    should(terminal.TerminalViewSchema.parse({ ...viewedTerminal, title: '  build  ' }).title).equal('build');
    assertRejects(cases);
  });

  it('should hold columns and rows to their bounds wherever geometry appears', () => {
    // Arrange
    const geometry = [
      { schema: terminal.TerminalSizeSchema, wrap: (patch: object) => ({ ...size, ...patch }) },
      { schema: terminal.TerminalViewSchema, wrap: (patch: object) => ({ ...viewedTerminal, ...patch }) },
      { schema: terminal.CreateTerminalRequestSchema, wrap: (patch: object) => patch },
      { schema: terminal.TerminalResizeFrameSchema, wrap: (patch: object) => ({ ...resizeFrame, ...patch }) },
    ];
    const rejectedPatches = [
      { cols: terminal.TERMINAL_MIN_COLUMNS - 1 },
      { cols: terminal.TERMINAL_MAX_COLUMNS + 1 },
      { rows: terminal.TERMINAL_MIN_ROWS - 1 },
      { rows: terminal.TERMINAL_MAX_ROWS + 1 },
      { cols: 80.5 },
      { rows: 24.5 },
    ];
    const acceptedPatches = [
      { cols: terminal.TERMINAL_MIN_COLUMNS, rows: terminal.TERMINAL_MIN_ROWS },
      { cols: terminal.TERMINAL_MAX_COLUMNS, rows: terminal.TERMINAL_MAX_ROWS },
    ];

    // Act + Assert
    for (const entry of geometry) {
      for (const patch of rejectedPatches) should(entry.schema.safeParse(entry.wrap(patch)).success).be.false();
      for (const patch of acceptedPatches) should(entry.schema.safeParse(entry.wrap(patch)).success).be.true();
    }
    should(terminal.TerminalSizeSchema.safeParse({ cols: size.cols }).success).be.false();
    should(terminal.TerminalSizeSchema.safeParse({ rows: size.rows }).success).be.false();
  });

  it('should require an idle deadline exactly when no viewer is attached', () => {
    // Arrange
    const withoutDeadline = { ...viewedTerminal, viewers: 0 };
    const withDeadline = { ...viewedTerminal, idleDeadline: LATER_INSTANT };

    // Act
    const parsed = [viewedTerminal, idleTerminal].map(value => terminal.TerminalViewSchema.parse(value));

    // Assert
    should(parsed).deepEqual([viewedTerminal, idleTerminal]);
    should(parsed[0]?.idleDeadline).be.undefined();
    should(parsed[1]?.idleDeadline).equal(LATER_INSTANT);
    should(terminal.TerminalViewSchema.safeParse(withoutDeadline).success).be.false();
    should(terminal.TerminalViewSchema.safeParse(withDeadline).success).be.false();
    should(terminal.TerminalViewSchema.safeParse({ ...idleTerminal, viewers: 1 }).success).be.false();
  });

  it('should reject a last-activity instant that precedes creation', () => {
    // Arrange
    const simultaneous = { ...viewedTerminal, lastActivityAt: INSTANT };
    const reversed = { ...viewedTerminal, createdAt: LATER_INSTANT, lastActivityAt: INSTANT };

    // Act
    const parsed = terminal.TerminalViewSchema.parse(simultaneous);

    // Assert
    should(parsed).deepEqual(simultaneous);
    should(terminal.TerminalViewSchema.safeParse(reversed).success).be.false();
    should(
      terminal.TerminalViewSchema.safeParse({ ...viewedTerminal, createdAt: '2026-07-30T12:00:00' }).success,
    ).be.false();
    should(
      terminal.TerminalViewSchema.safeParse({ ...viewedTerminal, lastActivityAt: 'yesterday' }).success,
    ).be.false();
    should(terminal.TerminalViewSchema.safeParse({ ...idleTerminal, idleDeadline: 'soon' }).success).be.false();
  });

  it('should reject views whose counts, session, or state are not representable', () => {
    // Arrange
    const cases: SchemaCase[] = [
      { name: 'negative viewers', schema: terminal.TerminalViewSchema, value: { ...viewedTerminal, viewers: -1 } },
      { name: 'fractional viewers', schema: terminal.TerminalViewSchema, value: { ...viewedTerminal, viewers: 1.5 } },
      {
        name: 'viewers omitted',
        schema: terminal.TerminalViewSchema,
        value: { ...viewedTerminal, viewers: undefined },
      },
      { name: 'empty session id', schema: terminal.TerminalViewSchema, value: { ...viewedTerminal, sessionId: '' } },
      {
        name: 'session id omitted',
        schema: terminal.TerminalViewSchema,
        value: { ...viewedTerminal, sessionId: undefined },
      },
      { name: 'exited state', schema: terminal.TerminalViewSchema, value: { ...viewedTerminal, state: 'exited' } },
      { name: 'state omitted', schema: terminal.TerminalViewSchema, value: { ...viewedTerminal, state: undefined } },
    ];

    // Act
    const parsed = terminal.TerminalViewSchema.parse({ ...idleTerminal, viewers: 0 });

    // Assert
    should(parsed.viewers).equal(0);
    should(parsed.state).equal('running');
    assertRejects(cases);
  });

  it('should carry an opener when one was recorded and stay silent when none was', () => {
    // Arrange — absence is the fourth answer: a terminal opened before this
    // daemon recorded provenance has no opener, and a reader must be told that
    // rather than shown a default. `openedBy: null` is NOT that answer; a
    // daemon that means "unrecorded" omits the field.
    const unrecorded = { ...viewedTerminal, openedBy: undefined };
    const cases: SchemaCase[] = [
      { name: 'null opener', schema: terminal.TerminalViewSchema, value: { ...viewedTerminal, openedBy: null } },
      {
        name: 'opener without a class',
        schema: terminal.TerminalViewSchema,
        value: { ...viewedTerminal, openedBy: { deviceId: 'device-7f3a' } },
      },
      {
        name: 'agent opener without a session',
        schema: terminal.TerminalViewSchema,
        value: { ...viewedTerminal, openedBy: { by: 'agent' } },
      },
    ];

    // Act
    const parsed = terminal.TerminalViewSchema.parse(viewedTerminal);
    const silent = terminal.TerminalViewSchema.parse(unrecorded);

    // Assert
    should(parsed.openedBy).deepEqual({ by: 'agent', sessionId: 'mse7wwti-2a75bd9c' });
    should(silent.openedBy).be.undefined();
    should(terminal.TerminalViewSchema.parse({ ...viewedTerminal, openedBy: { by: 'local' } }).openedBy).deepEqual({
      by: 'local',
    });
    assertRejects(cases);
  });

  it('should let a create request name the agent it is opening a terminal for', () => {
    // Arrange — the request states WHICH agent, never that the caller IS one:
    // the daemon derives the class from the credential that authenticated it.
    const forAgent = { agentSessionId: 'mse7wwti-2a75bd9c' } satisfies CreateTerminalRequest;
    const cases: SchemaCase[] = [
      { name: 'empty agent session', schema: terminal.CreateTerminalRequestSchema, value: { agentSessionId: '' } },
      { name: 'blank agent session', schema: terminal.CreateTerminalRequestSchema, value: { agentSessionId: '   ' } },
      {
        name: 'agent session beyond the maximum',
        schema: terminal.CreateTerminalRequestSchema,
        value: { agentSessionId: 'a'.repeat(129) },
      },
      // A caller may not hand the daemon a finished opener: doing so would let a
      // paired device label its own shell as an agent's.
      { name: 'a whole opener', schema: terminal.CreateTerminalRequestSchema, value: { openedBy: { by: 'local' } } },
    ];

    // Act
    const parsed = terminal.CreateTerminalRequestSchema.parse(forAgent);

    // Assert
    should(parsed).deepEqual(forAgent);
    should(terminal.CreateTerminalRequestSchema.parse({}).agentSessionId).be.undefined();
    assertRejects(cases);
  });

  it('should confirm that a listed terminal belongs to the listed session', () => {
    // Arrange
    const foreign = { ...idleTerminal, sessionId: 'session-2' };

    // Act
    const parsed = terminal.TerminalListViewSchema.parse(listView);

    // Assert
    should(parsed.terminals.map(entry => entry.sessionId)).deepEqual([SESSION_ID, SESSION_ID]);
    should(
      terminal.TerminalListViewSchema.safeParse({ ...listView, terminals: [viewedTerminal, foreign] }).success,
    ).be.false();
    should(terminal.TerminalListViewSchema.safeParse({ ...listView, sessionId: 'session-2' }).success).be.false();
    should(terminal.TerminalListViewSchema.safeParse(emptyListView).success).be.true();
  });

  it('should reconcile the listed terminals with the per-session and global counters', () => {
    // Arrange
    const limits = listView.limits;
    const cases: SchemaCase[] = [
      {
        name: 'more terminals than the per-session limit allows',
        schema: terminal.TerminalListViewSchema,
        value: { ...listView, limits: { ...limits, perSession: 1 } },
      },
      {
        name: 'running count below the listed terminals',
        schema: terminal.TerminalListViewSchema,
        value: { ...listView, limits: { ...limits, runningGlobal: 1 } },
      },
      {
        name: 'running count above the global limit',
        schema: terminal.TerminalListViewSchema,
        value: { ...listView, limits: { ...limits, runningGlobal: limits.global + 1 } },
      },
      {
        name: 'non-empty list with a zero running count',
        schema: terminal.TerminalListViewSchema,
        value: { ...listView, limits: { ...limits, runningGlobal: 0 } },
      },
      {
        name: 'zero per-session limit',
        schema: terminal.TerminalListViewSchema,
        value: { ...emptyListView, limits: { ...limits, perSession: 0, runningGlobal: 0 } },
      },
      {
        name: 'zero global limit',
        schema: terminal.TerminalListViewSchema,
        value: { ...emptyListView, limits: { ...limits, global: 0, runningGlobal: 0 } },
      },
      {
        name: 'zero idle timeout',
        schema: terminal.TerminalListViewSchema,
        value: { ...listView, limits: { ...limits, idleTimeoutSeconds: 0 } },
      },
      {
        name: 'zero scrollback',
        schema: terminal.TerminalListViewSchema,
        value: { ...listView, limits: { ...limits, scrollbackLines: 0 } },
      },
      {
        name: 'negative running count',
        schema: terminal.TerminalListViewSchema,
        value: { ...emptyListView, limits: { ...limits, runningGlobal: -1 } },
      },
      {
        name: 'fractional idle timeout',
        schema: terminal.TerminalListViewSchema,
        value: { ...listView, limits: { ...limits, idleTimeoutSeconds: 30.5 } },
      },
      {
        name: 'limits omitted',
        schema: terminal.TerminalListViewSchema,
        value: { sessionId: SESSION_ID, terminals: [] },
      },
      {
        name: 'invalid nested terminal',
        schema: terminal.TerminalListViewSchema,
        value: { ...listView, terminals: [{ ...viewedTerminal, viewers: 0 }] },
      },
    ];

    // Act + Assert
    should(
      terminal.TerminalListViewSchema.safeParse({
        ...listView,
        limits: { ...limits, perSession: 2, runningGlobal: limits.global },
      }).success,
    ).be.true();
    assertRejects(cases);
  });

  it('should reject unknown keys on the strict request and frame payloads', () => {
    // Arrange
    const cases: SchemaCase[] = [
      {
        name: 'unknown create key',
        schema: terminal.CreateTerminalRequestSchema,
        value: { ...createRequest, shell: 'zsh' },
      },
      {
        name: 'unknown rename key',
        schema: terminal.RenameTerminalRequestSchema,
        value: { ...renameRequest, id: VIEWED_ID },
      },
      { name: 'rename without a title', schema: terminal.RenameTerminalRequestSchema, value: {} },
      {
        name: 'unknown resize key',
        schema: terminal.TerminalResizeFrameSchema,
        value: { ...resizeFrame, pixels: true },
      },
      { name: 'resize without a type', schema: terminal.TerminalResizeFrameSchema, value: { cols: 80, rows: 24 } },
      {
        name: 'unknown frame type',
        schema: terminal.TerminalResizeFrameSchema,
        value: { ...resizeFrame, type: 'input' },
      },
      { name: 'resize without rows', schema: terminal.TerminalResizeFrameSchema, value: { type: 'resize', cols: 80 } },
    ];

    // Act
    const parsed = terminal.CreateTerminalRequestSchema.parse({});

    // Assert
    should(parsed).deepEqual({});
    should(terminal.CreateTerminalRequestSchema.parse({ title: 'build' })).deepEqual({ title: 'build' });
    should(terminal.CreateTerminalRequestSchema.parse(createRequest)).deepEqual(createRequest);
    assertRejects(cases);
  });

  it('should accept close acknowledgements and raw binary frames only in their exact shape', () => {
    // Arrange
    const cases: SchemaCase[] = [
      {
        name: 'close reported as false',
        schema: terminal.CloseTerminalResponseSchema,
        value: { ...closeResponse, closed: false },
      },
      { name: 'close without an id', schema: terminal.CloseTerminalResponseSchema, value: { closed: true } },
      { name: 'plain array frame', schema: terminal.TerminalBinaryFrameSchema, value: [0x1b, 0x5b] },
      { name: 'array buffer frame', schema: terminal.TerminalBinaryFrameSchema, value: new ArrayBuffer(4) },
      { name: 'wrong typed array', schema: terminal.TerminalBinaryFrameSchema, value: new Int8Array([1]) },
      { name: 'string frame', schema: terminal.TerminalBinaryFrameSchema, value: '\u001b[0m' },
      { name: 'json control frame', schema: terminal.TerminalBinaryFrameSchema, value: resizeFrame },
    ];

    // Act
    const parsed = terminal.TerminalBinaryFrameSchema.parse(binaryFrame);

    // Assert
    should(parsed).equal(binaryFrame);
    should(terminal.TerminalBinaryFrameSchema.safeParse(new Uint8Array()).success).be.true();
    should(terminal.CloseTerminalResponseSchema.parse(closeResponse)).deepEqual(closeResponse);
    assertRejects(cases);
  });
});
