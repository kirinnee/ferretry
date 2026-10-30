import { describe, it } from 'bun:test';
import should from 'should';
import * as tools from '../../src/lib/agent-tools.ts';
import type { AgentToolCall, SurfaceControlView } from '../../src/lib/index.ts';
import { INSTANT, LATER_INSTANT } from '../fixtures.ts';
import { assertCoversEverySchema, assertRejects, assertRoundTrips, type SchemaCase } from './schema-cases.ts';

const driving = {
  surface: 'terminal',
  id: 'a1b2c3d4e5f6',
  name: 'dev',
  agentSessionId: 'mse7wwti-2a75bd9c',
  agentName: 'Hadi',
  since: INSTANT,
  until: LATER_INSTANT,
} as const;

const takeover = {
  surface: 'browser',
  id: 'page-1',
  name: 'app',
  by: { by: 'human', deviceId: 'device-7f3a' },
  since: INSTANT,
} as const;

const opened = {
  surface: 'terminal',
  id: 'a1b2c3d4e5f6',
  name: 'dev',
  agentSessionId: 'mse7wwti-2a75bd9c',
  agentName: 'Hadi',
  at: INSTANT,
} as const;

const asked = { ...opened, message: 'Approve the sudo prompt, then press Enter.' } as const;

const view = {
  sessionId: 's1',
  driving: [driving],
  takeovers: [takeover],
  handed: [{ surface: 'terminal', id: 'a1b2c3d4e5f6', by: { by: 'local' }, at: INSTANT }],
  opened: [opened],
  asked: [asked],
} satisfies SurfaceControlView;

const cases: SchemaCase[] = [
  { name: 'name', schema: tools.SurfaceNameSchema, value: 'dev-server' },
  { name: 'key', schema: tools.SurfaceKeySchema, value: 'a1b2c3d4e5f6' },
  { name: 'kind', schema: tools.SurfaceKindSchema, value: 'browser' },
  { name: 'key press', schema: tools.TerminalKeySchema, value: 'ctrl-c' },
  { name: 'url', schema: tools.AgentUrlSchema, value: 'https://example.test/login' },
  { name: 'history step', schema: tools.BrowserHistoryStepSchema, value: 'back' },
  { name: 'call', schema: tools.AgentToolCallSchema, value: { tool: 'terminal.send', name: 'dev', text: 'ls' } },
  { name: 'surface', schema: tools.AgentSurfaceSchema, value: { id: 'page-1', name: 'app', title: 'x', url: 'a' } },
  {
    name: 'result',
    schema: tools.AgentToolResultSchema,
    value: { summary: 'ok', output: 'x', matched: true, screenshotBase64: 'AAAA', surfaces: [] },
  },
  { name: 'driving', schema: tools.SurfaceDrivingSchema, value: driving },
  { name: 'controller', schema: tools.SurfaceControllerSchema, value: { by: 'local' } },
  { name: 'takeover', schema: tools.SurfaceTakeoverSchema, value: takeover },
  { name: 'control view', schema: tools.SurfaceControlViewSchema, value: view },
  { name: 'handed', schema: tools.SurfaceHandedSchema, value: view.handed[0] },
  { name: 'opened', schema: tools.SurfaceOpenedSchema, value: opened },
  { name: 'asked', schema: tools.SurfaceAskedSchema, value: asked },
  { name: 'ask message', schema: tools.AskOwnerMessageSchema, value: 'Log in, then say done.' },
  {
    name: 'control request',
    schema: tools.SurfaceControlRequestSchema,
    value: { action: 'handover', key: '%terminal:dev' },
  },
  {
    name: 'handback',
    schema: tools.SurfaceHandbackSchema,
    value: { surface: 'terminal', id: 'a1b2c3d4e5f6', at: INSTANT },
  },
];

describe('agent tool schemas', () => {
  it('should read a control view from an older daemon as having nothing opened or asked', () => {
    // Arrange
    const { opened: _opened, asked: _asked, ...older } = view;

    // Act
    const parsed = tools.SurfaceControlViewSchema.parse(older);

    // Assert
    should(parsed.opened).deepEqual([]);
    should(parsed.asked).deepEqual([]);
  });

  it('should round-trip every public agent-tool schema', () => {
    assertRoundTrips(cases);
    assertCoversEverySchema(tools, cases);
  });

  it('should accept every tool the agent is shown, each in its smallest valid form', () => {
    // Arrange
    const calls: AgentToolCall[] = [
      { tool: 'terminal.list' },
      { tool: 'terminal.open', name: 'dev', folder: 'web', command: 'bun dev', askOwner: true },
      { tool: 'terminal.send', name: 'dev', keys: ['ctrl-c', 'enter'] },
      { tool: 'terminal.read', name: 'dev', lines: 50 },
      { tool: 'terminal.wait', name: 'dev', text: 'ready', timeoutMs: 5_000 },
      { tool: 'terminal.wait', name: 'dev', exit: true },
      { tool: 'terminal.close', name: 'dev' },
      { tool: 'terminal.ask_owner', name: 'dev', message: 'Type your password.' },
      { tool: 'browser.list' },
      { tool: 'browser.open', name: 'app', url: 'http://localhost:5173/', incognito: true, askOwner: 'Sign in.' },
      { tool: 'browser.navigate', name: 'app', url: 'https://example.test/' },
      { tool: 'browser.click', name: 'app', selector: 'button' },
      { tool: 'browser.type', name: 'app', selector: '#email', text: '' },
      { tool: 'browser.read', name: 'app', mode: 'a11y' },
      { tool: 'browser.screenshot', name: 'app' },
      { tool: 'browser.close', name: 'app' },
      { tool: 'browser.ask_owner', name: 'app' },
    ];

    // Act
    const parsed = calls.map(call => tools.AgentToolCallSchema.parse(call).tool);

    // Assert
    should(parsed).deepEqual([
      ...tools.AGENT_TOOL_NAMES.slice(0, 5),
      'terminal.wait',
      ...tools.AGENT_TOOL_NAMES.slice(5),
    ]);
  });

  it('should accept the ref, point and history forms of the browser acts', () => {
    // Arrange
    const calls: AgentToolCall[] = [
      { tool: 'browser.navigate', name: 'app', history: 'back' },
      { tool: 'browser.click', name: 'app', ref: 'e12', double: true, button: 'right', modifiers: ['Shift'] },
      { tool: 'browser.click', name: 'app', ref: 'f1e3' },
      { tool: 'browser.click', name: 'app', x: 120, y: 340.5 },
      { tool: 'browser.type', name: 'app', ref: 'e5', text: 'hadi', submit: true, slowly: true },
      { tool: 'browser.read', name: 'app', mode: 'snapshot', ref: 'e3', depth: 4, boxes: true },
      { tool: 'browser.read', name: 'app', find: 'Sign in' },
      { tool: 'browser.screenshot', name: 'app', fullPage: true, format: 'jpeg' },
      { tool: 'browser.screenshot', name: 'app', ref: 'e4' },
    ];

    // Act
    const parsed = calls.map(call => tools.AgentToolCallSchema.safeParse(call).success);

    // Assert
    should(parsed.every(Boolean)).be.true();
  });

  it('should refuse a browser act that names no target, two targets, or the wrong kind', () => {
    const call = (value: Record<string, unknown>): SchemaCase => ({
      name: JSON.stringify(value).slice(0, 60),
      schema: tools.AgentToolCallSchema,
      value,
    });
    assertRejects([
      call({ tool: 'browser.click', name: 'app' }),
      call({ tool: 'browser.click', name: 'app', ref: 'e1', selector: 'a' }),
      call({ tool: 'browser.click', name: 'app', ref: 'e1', x: 1, y: 2 }),
      call({ tool: 'browser.click', name: 'app', x: 1 }),
      call({ tool: 'browser.click', name: 'app', x: -1, y: 2 }),
      call({ tool: 'browser.click', name: 'app', x: 10_001, y: 2 }),
      call({ tool: 'browser.click', name: 'app', ref: 'button' }),
      call({ tool: 'browser.click', name: 'app', ref: 'e1', double: false }),
      call({ tool: 'browser.click', name: 'app', ref: 'e1', modifiers: ['Hyper'] }),
      call({ tool: 'browser.type', name: 'app', text: 'x' }),
      call({ tool: 'browser.type', name: 'app', x: 1, y: 2, text: 'x' }),
      call({ tool: 'browser.read', name: 'app', mode: 'text', find: 'x' }),
      call({ tool: 'browser.read', name: 'app', mode: 'a11y', depth: 2 }),
      call({ tool: 'browser.read', name: 'app', find: 'x'.repeat(257) }),
      call({ tool: 'browser.read', name: 'app', mode: 'snapshot', depth: 65 }),
      call({ tool: 'browser.screenshot', name: 'app', ref: 'e2', fullPage: true }),
      call({ tool: 'browser.screenshot', name: 'app', format: 'webp' }),
      call({ tool: 'browser.navigate', name: 'app' }),
      call({ tool: 'browser.navigate', name: 'app', url: 'https://example.test/', history: 'back' }),
      call({ tool: 'browser.navigate', name: 'app', history: 'home' }),
    ]);
  });

  it('should take a reference exactly as a person wrote it, and keep the old id form working', () => {
    should(tools.SurfaceKeySchema.parse('%terminal:dev')).equal('dev');
    should(tools.SurfaceKeySchema.parse('%browser:app')).equal('app');
    should(tools.SurfaceKeySchema.parse(' a1b2c3d4e5f6 ')).equal('a1b2c3d4e5f6');
  });

  it('should refuse a name that is not lowercase, too long, or shaped like a terminal id', () => {
    assertRejects([
      { name: 'upper', schema: tools.SurfaceNameSchema, value: 'Dev' },
      { name: 'digit first', schema: tools.SurfaceNameSchema, value: '1dev' },
      { name: 'too long', schema: tools.SurfaceNameSchema, value: `a${'b'.repeat(32)}` },
      { name: 'space', schema: tools.SurfaceNameSchema, value: 'my dev' },
      { name: 'terminal id', schema: tools.SurfaceNameSchema, value: 'deadbeefcafe' },
      { name: 'key with a dot', schema: tools.SurfaceKeySchema, value: 'dev.' },
    ]);
  });

  it('should bound every input an agent controls', () => {
    const call = (value: Record<string, unknown>): SchemaCase => ({
      name: JSON.stringify(value).slice(0, 40),
      schema: tools.AgentToolCallSchema,
      value,
    });
    assertRejects([
      call({ tool: 'terminal.send', name: 'dev', text: 'x'.repeat(tools.AGENT_TOOL_MAX_TEXT_CHARS + 1) }),
      call({ tool: 'terminal.send', name: 'dev' }),
      call({ tool: 'terminal.send', name: 'dev', keys: ['f13'] }),
      call({ tool: 'terminal.send', name: 'dev', keys: Array(tools.AGENT_TOOL_MAX_KEYS + 1).fill('enter') }),
      call({ tool: 'terminal.read', name: 'dev', lines: tools.AGENT_TOOL_MAX_READ_LINES + 1 }),
      call({ tool: 'terminal.wait', name: 'dev', text: 'x', timeoutMs: tools.AGENT_TOOL_MAX_WAIT_MS + 1 }),
      call({ tool: 'terminal.wait', name: 'dev' }),
      call({ tool: 'terminal.wait', name: 'dev', text: 'x', exit: true }),
      call({ tool: 'browser.type', name: 'app', selector: 'x', text: 'y'.repeat(tools.AGENT_TOOL_MAX_TEXT_CHARS + 1) }),
      call({ tool: 'browser.click', name: 'app', selector: 's'.repeat(tools.AGENT_TOOL_MAX_SELECTOR_CHARS + 1) }),
      call({ tool: 'terminal.list', sessionId: 'someone-else' }),
      call({ tool: 'terminal.open', name: 'dev', askOwner: false }),
      call({ tool: 'terminal.open', name: 'dev', askOwner: 'x'.repeat(tools.AGENT_TOOL_MAX_ASK_CHARS + 1) }),
      call({ tool: 'browser.ask_owner', name: 'app', message: '   ' }),
    ]);
  });

  it('should open only web pages', () => {
    assertRejects([
      { name: 'file', schema: tools.AgentUrlSchema, value: 'file:///etc/passwd' },
      { name: 'script', schema: tools.AgentUrlSchema, value: 'javascript:alert(1)' },
      { name: 'not a url', schema: tools.AgentUrlSchema, value: 'localhost:3000' },
      { name: 'not even a scheme', schema: tools.AgentUrlSchema, value: '::nonsense' },
      { name: 'too long', schema: tools.AgentUrlSchema, value: `https://e.test/${'a'.repeat(2_048)}` },
    ]);
    should(tools.AgentUrlSchema.parse('http://127.0.0.1:3000/')).equal('http://127.0.0.1:3000/');
  });
});

describe('isRepeatableAgentTool', () => {
  it('should repeat only the tools that change nothing, after a request the daemon dropped', () => {
    // Arrange
    const reads = ['terminal.list', 'terminal.read', 'terminal.wait', 'browser.list', 'browser.read'];
    const looks = ['browser.screenshot', 'config.read', 'config.validate'];
    const acts = ['terminal.open', 'terminal.send', 'terminal.close', 'browser.click', 'config.write'];

    // Act
    const repeatable = [...reads, ...looks].map(tools.isRepeatableAgentTool);
    const notRepeatable = [...acts, undefined, 42].map(tools.isRepeatableAgentTool);

    // Assert
    should(repeatable.every(Boolean)).be.true();
    should(notRepeatable.some(Boolean)).be.false();
  });
});
