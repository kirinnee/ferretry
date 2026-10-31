import { describe, it } from 'bun:test';
import should from 'should';
import * as tools from '../../src/lib/agent-tools.ts';
import type { AgentToolCall, SurfaceControlView } from '../../src/lib/index.ts';
import { INSTANT, LATER_INSTANT } from '../fixtures.ts';
import { assertCoversEverySchema, assertRejects, assertRoundTrips, type SchemaCase } from './schema-cases.ts';

const ATTACHMENT = `att_${'ab'.repeat(32)}`;

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
  { name: 'upload file by path', schema: tools.AgentUploadFileSchema, value: 'reports/q3.pdf' },
  { name: 'upload file by attachment', schema: tools.AgentUploadFileSchema, value: { attachment: ATTACHMENT } },
  { name: 'upload mode', schema: tools.BrowserUploadModeSchema, value: 'drop' },
  { name: 'call', schema: tools.AgentToolCallSchema, value: { tool: 'terminal.send', name: 'dev', text: 'ls' } },
  { name: 'surface', schema: tools.AgentSurfaceSchema, value: { id: 'page-1', name: 'app', title: 'x', url: 'a' } },
  {
    name: 'popup surface',
    schema: tools.AgentSurfaceSchema,
    value: { id: 'popup-1', title: 'x', url: 'a', openerId: 'page-1' },
  },
  {
    name: 'result',
    schema: tools.AgentToolResultSchema,
    value: { summary: 'ok', output: 'x', matched: true, screenshotBase64: 'AAAA', surfaces: [] },
  },
  {
    name: 'browser input field',
    schema: tools.BrowserInputFieldSchema,
    value: { id: 'email', label: 'Email', sensitivity: 'plain', selector: '#email' },
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
      { tool: 'terminal.request_input', name: 'dev', prompt: 'sudo password for deploy', sensitivity: 'secret' },
      { tool: 'input.wait', id: '!A7', timeoutMs: 5_000 },
      { tool: 'login.hint', site: 'vercel.com' },
      { tool: 'browser.list' },
      { tool: 'browser.open', name: 'app', url: 'http://localhost:5173/', incognito: true, askOwner: 'Sign in.' },
      { tool: 'browser.navigate', name: 'app', url: 'https://example.test/' },
      { tool: 'browser.click', name: 'app', selector: 'button' },
      { tool: 'browser.type', name: 'app', selector: '#email', text: '' },
      { tool: 'browser.read', name: 'app', mode: 'a11y' },
      { tool: 'browser.screenshot', name: 'app' },
      { tool: 'browser.dialog', name: 'app', action: 'accept' },
      { tool: 'browser.tabs', action: 'list' },
      { tool: 'browser.wait_for', name: 'app', time: 500 },
      { tool: 'browser.console', name: 'app' },
      { tool: 'browser.network', name: 'app', action: 'list' },
      { tool: 'browser.emulate', name: 'app', reset: true },
      { tool: 'browser.upload', name: 'app', selector: '#file', files: ['a.txt'] },
      { tool: 'browser.download', name: 'app' },
      { tool: 'browser.pdf', name: 'app' },
      { tool: 'browser.hover', name: 'app', ref: 'e2' },
      { tool: 'browser.drag', name: 'app', fromRef: 'e2', toRef: 'e3' },
      { tool: 'browser.mouse', name: 'app', action: 'move', x: 1, y: 2 },
      { tool: 'browser.press', name: 'app', keys: ['Enter'] },
      { tool: 'browser.scroll', name: 'app', pages: 1 },
      { tool: 'browser.select', name: 'app', ref: 'e4', values: ['uk'] },
      { tool: 'browser.check', name: 'app', ref: 'e5', checked: false },
      { tool: 'browser.fill_form', name: 'app', fields: [{ ref: 'e4', text: 'hadi' }] },
      { tool: 'browser.highlight', name: 'app', clear: true },
      { tool: 'browser.eval', name: 'app', function: '() => document.title' },
      { tool: 'browser.close', name: 'app' },
      { tool: 'browser.ask_owner', name: 'app' },
      {
        tool: 'browser.request_input',
        name: 'app',
        prompt: 'GitHub login',
        fields: [{ id: 'password', sensitivity: 'secret', ref: 'e7' }],
      },
      { tool: 'secure.copy', name: 'token', source: { kind: 'command', argv: ['gh'] } },
      { tool: 'secure.list' },
      { tool: 'secure.discard', handle: 'sealed:token' },
      { tool: 'secure.paste', handle: 'sealed:token', to: { kind: 'terminal', name: 'dev' }, prompt: 'the token' },
      {
        tool: 'secure.preapprove',
        items: [
          { from: { kind: 'command', program: 'gh' }, to: { kind: 'terminal', program: 'vercel' }, why: 'token' },
        ],
      },
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

  it('should paste into a terminal by its name, one page field by ref or selector, or the secret store by name', () => {
    const paste = (to: unknown) => ({ tool: 'secure.paste', handle: 'sealed:token', to, prompt: 'the token' });

    should(tools.AgentToolCallSchema.safeParse(paste({ kind: 'secret', name: 'VERCEL_TOKEN' })).success).be.true();
    should(tools.AgentToolCallSchema.safeParse(paste({ kind: 'browser', name: 'app', ref: 'e3' })).success).be.true();
    should(
      tools.AgentToolCallSchema.safeParse(paste({ kind: 'browser', name: 'app', selector: '#t' })).success,
    ).be.true();
    for (const to of [
      { kind: 'browser', name: 'app' },
      { kind: 'browser', name: 'app', ref: 'e3', selector: '#t' },
      { kind: 'browser', name: 'app', x: 1, y: 2 },
      { kind: 'secret', name: 'vercel_token' },
      { kind: 'secret', name: 'VERCEL_TOKEN', exists: true },
      { kind: 'vault', name: 'VERCEL_TOKEN' },
    ])
      should(tools.AgentToolCallSchema.safeParse(paste(to)).success).be.false();
  });

  it('should take a page script as a bounded function, with at most one element, and refuse everything else', () => {
    // Arrange
    const accepted: AgentToolCall[] = [
      { tool: 'browser.eval', name: 'app', function: '() => document.title' },
      { tool: 'browser.eval', name: 'app', function: '(el) => el.value', ref: 'e2', timeoutMs: 10_000 },
      { tool: 'browser.eval', name: 'app', function: '(el) => el.value', selector: '#q', timeoutMs: 100 },
    ];
    const call = (value: Record<string, unknown>): SchemaCase => ({
      name: JSON.stringify(value).slice(0, 60),
      schema: tools.AgentToolCallSchema,
      value: { tool: 'browser.eval', name: 'app', ...value },
    });

    // Act + Assert
    should(accepted.every(entry => tools.AgentToolCallSchema.safeParse(entry).success)).be.true();
    assertRejects([
      call({}),
      call({ function: '   ' }),
      call({ function: 'x'.repeat(tools.AGENT_TOOL_MAX_SCRIPT_CHARS + 1) }),
      call({ function: '() => 1', ref: 'e1', selector: '#a' }),
      call({ function: '() => 1', x: 1, y: 2 }),
      call({ function: '() => 1', timeoutMs: 99 }),
      call({ function: '() => 1', timeoutMs: tools.AGENT_TOOL_MAX_SCRIPT_MS + 1 }),
      call({ function: '() => 1', expression: '1' }),
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
      { tool: 'browser.dialog', name: 'app', action: 'dismiss' },
      { tool: 'browser.dialog', name: 'app', action: 'accept', promptText: 'hadi' },
      { tool: 'browser.tabs', action: 'list' },
      { tool: 'browser.tabs', action: 'adopt', id: 'popup-1', as: 'checkout' },
      { tool: 'browser.wait_for', name: 'app', ref: 'e3', state: 'hidden', timeoutMs: 5_000 },
      { tool: 'browser.wait_for', name: 'app', selector: '#done' },
      { tool: 'browser.wait_for', name: 'app', text: 'Welcome' },
      { tool: 'browser.wait_for', name: 'app', textGone: 'Loading' },
      { tool: 'browser.wait_for', name: 'app', url: '/dashboard' },
      { tool: 'browser.wait_for', name: 'app', load: 'networkidle' },
      { tool: 'browser.wait_for', name: 'app', time: 2_000 },
      { tool: 'browser.console', name: 'app' },
      { tool: 'browser.console', name: 'app', level: 'warning', since: 12, limit: 20 },
      { tool: 'browser.network', name: 'app', action: 'list', filter: '/api', types: ['xhr', 'fetch'] },
      { tool: 'browser.network', name: 'app', action: 'get', id: 'r12' },
      { tool: 'browser.emulate', name: 'app', reset: true },
      {
        tool: 'browser.emulate',
        name: 'app',
        viewport: { width: 390, height: 844 },
        media: { colorScheme: 'dark' },
        geolocation: { latitude: 52.5, longitude: 13.4 },
        locale: 'de-DE',
        timezone: 'Europe/Berlin',
        cpuThrottle: 4,
        network: { latency: 200, throughput: 400 },
        permissions: ['geolocation'],
      },
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

  it('should refuse a dialog, tab, wait, console, network or emulate call that is not well formed', () => {
    const call = (value: Record<string, unknown>): SchemaCase => ({
      name: JSON.stringify(value).slice(0, 60),
      schema: tools.AgentToolCallSchema,
      value,
    });
    assertRejects([
      call({ tool: 'browser.dialog', name: 'app' }),
      call({ tool: 'browser.dialog', name: 'app', action: 'ignore' }),
      call({ tool: 'browser.dialog', name: 'app', action: 'dismiss', promptText: 'x' }),
      call({ tool: 'browser.dialog', name: 'app', action: 'accept', promptText: 'x'.repeat(1_025) }),
      call({ tool: 'browser.tabs', action: 'adopt' }),
      call({ tool: 'browser.tabs', action: 'adopt', id: 'popup-1' }),
      call({ tool: 'browser.tabs', action: 'adopt', as: 'checkout' }),
      call({ tool: 'browser.tabs', action: 'list', id: 'popup-1' }),
      call({ tool: 'browser.tabs', action: 'list', as: 'checkout' }),
      call({ tool: 'browser.wait_for', name: 'app' }),
      call({ tool: 'browser.wait_for', name: 'app', text: 'a', textGone: 'b' }),
      call({ tool: 'browser.wait_for', name: 'app', ref: 'e1', text: 'a' }),
      call({ tool: 'browser.wait_for', name: 'app', ref: 'e1', selector: '#a' }),
      call({ tool: 'browser.wait_for', name: 'app', x: 1, y: 2 }),
      call({ tool: 'browser.wait_for', name: 'app', text: 'a', state: 'visible' }),
      call({ tool: 'browser.wait_for', name: 'app', time: 25_001 }),
      call({ tool: 'browser.wait_for', name: 'app', text: 'a', timeoutMs: 25_001 }),
      call({ tool: 'browser.wait_for', name: 'app', text: 'a', timeoutMs: 10 }),
      call({ tool: 'browser.wait_for', name: 'app', load: 'idle' }),
      call({ tool: 'browser.wait_for', name: 'app', text: '' }),
      call({ tool: 'browser.console', name: 'app', level: 'trace' }),
      call({ tool: 'browser.console', name: 'app', limit: 501 }),
      call({ tool: 'browser.console', name: 'app', since: -1 }),
      call({ tool: 'browser.network', name: 'app', action: 'get' }),
      call({ tool: 'browser.network', name: 'app', action: 'get', id: 'r1', filter: 'x' }),
      call({ tool: 'browser.network', name: 'app', action: 'get', id: 'r1', types: ['xhr'] }),
      call({ tool: 'browser.network', name: 'app', action: 'list', id: 'r1' }),
      call({ tool: 'browser.network', name: 'app', action: 'get', id: 'request-1' }),
      call({ tool: 'browser.network', name: 'app', action: 'list', types: [] }),
      call({ tool: 'browser.network', name: 'app', action: 'list', types: ['video'] }),
      call({ tool: 'browser.emulate', name: 'app' }),
      call({ tool: 'browser.emulate', name: 'app', media: {} }),
      call({ tool: 'browser.emulate', name: 'app', network: {} }),
      call({ tool: 'browser.emulate', name: 'app', reset: false }),
      call({ tool: 'browser.emulate', name: 'app', viewport: { width: 10, height: 10 } }),
      call({ tool: 'browser.emulate', name: 'app', viewport: { width: 5_000, height: 800 } }),
      call({ tool: 'browser.emulate', name: 'app', geolocation: { latitude: 91, longitude: 0 } }),
      call({ tool: 'browser.emulate', name: 'app', locale: 'not a locale' }),
      call({ tool: 'browser.emulate', name: 'app', timezone: 'Mars time' }),
      call({ tool: 'browser.emulate', name: 'app', cpuThrottle: 0.5 }),
      call({ tool: 'browser.emulate', name: 'app', cpuThrottle: 21 }),
      call({ tool: 'browser.emulate', name: 'app', permissions: [] }),
      call({ tool: 'browser.emulate', name: 'app', permissions: ['clipboard-read'] }),
      call({ tool: 'browser.emulate', name: 'app', permissions: ['camera'] }),
      call({ tool: 'browser.emulate', name: 'app', userAgent: 'curl/8' }),
      call({ tool: 'browser.emulate', name: 'app', headers: { 'sec-ch-ua': 'x' } }),
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

describe('the file tools', () => {
  const upload = { tool: 'browser.upload', name: 'app', selector: '#file', files: ['a.txt'] };
  const accepts = (call: unknown): boolean => tools.AgentToolCallSchema.safeParse(call).success;

  it('should accept each file tool in the forms an agent uses', () => {
    should(
      [
        upload,
        { ...upload, selector: undefined, ref: 'e5', mode: 'drop' },
        { ...upload, files: ['a.txt', { attachment: ATTACHMENT }], mode: 'input' },
        { tool: 'browser.download', name: 'app', id: 'dl-3', saveAs: 'data/out.csv', overwrite: true },
        { tool: 'browser.pdf', name: 'app', saveAs: 'page.pdf', overwrite: true },
      ].map(accepts),
    ).deepEqual([true, true, true, true, true]);
  });

  it('should refuse an upload with no target, both targets, no files, too many files, or a bad mode', () => {
    const refused = [
      { ...upload, selector: undefined },
      { ...upload, ref: 'e5' },
      { ...upload, files: [] },
      { ...upload, files: Array.from({ length: tools.AGENT_TOOL_MAX_UPLOAD_FILES + 1 }, () => 'a.txt') },
      { ...upload, mode: 'paste' },
      { ...upload, files: [''] },
      { ...upload, files: ['x'.repeat(tools.AGENT_TOOL_MAX_PATH_CHARS + 1)] },
    ];
    should(refused.map(accepts)).deepEqual(refused.map(() => false));
  });

  it('should refuse an attachment id that is not att_ and 64 hex digits, or carries more keys', () => {
    const refused = [
      { ...upload, files: [{ attachment: 'att_123' }] },
      { ...upload, files: [{ attachment: '../etc/passwd' }] },
      { ...upload, files: [{ attachment: ATTACHMENT, path: '/etc/passwd' }] },
    ];
    should(refused.map(accepts)).deepEqual(refused.map(() => false));
  });

  it('should refuse a download id that is not dl-…, an overwrite that is not true, and unknown keys', () => {
    const refused = [
      { tool: 'browser.download', name: 'app', id: '../x' },
      { tool: 'browser.download', name: 'app', overwrite: false },
      { tool: 'browser.download', name: 'app', saveAs: '' },
      { tool: 'browser.download', name: 'app', url: 'https://e.test/' },
      { tool: 'browser.pdf', name: 'app', id: 'dl-1' },
      { tool: 'browser.pdf', name: 'app', saveAs: 'x'.repeat(tools.AGENT_TOOL_MAX_PATH_CHARS + 1) },
    ];
    should(refused.map(accepts)).deepEqual(refused.map(() => false));
  });

  it('should keep the caps in the order an upload is checked: file, then call', () => {
    should(tools.AGENT_TOOL_MAX_UPLOAD_FILE_BYTES).be.below(tools.AGENT_TOOL_MAX_UPLOAD_CALL_BYTES);
    should(tools.AGENT_TOOL_MAX_UPLOAD_FILE_BYTES * tools.AGENT_TOOL_MAX_UPLOAD_FILES).be.above(
      tools.AGENT_TOOL_MAX_UPLOAD_CALL_BYTES,
    );
  });

  it('should list the file tools as acts to run once, never to repeat after a dropped request', () => {
    should(['browser.upload', 'browser.download', 'browser.pdf'].map(tools.isRepeatableAgentTool)).deepEqual([
      false,
      false,
      false,
    ]);
  });
});

describe('isRepeatableAgentTool', () => {
  it('should repeat only the tools that change nothing, after a request the daemon dropped', () => {
    // Arrange
    const reads = [
      'terminal.list',
      'terminal.read',
      'terminal.wait',
      'browser.list',
      'browser.read',
      'browser.tabs',
      'browser.wait_for',
      'browser.console',
    ];
    const looks = ['browser.screenshot', 'config.read', 'config.validate'];
    const acts = [
      'terminal.open',
      'terminal.send',
      'terminal.close',
      'browser.click',
      'browser.dialog',
      'browser.network',
      'browser.emulate',
      'config.write',
    ];

    // Act
    const repeatable = [...reads, ...looks].map(tools.isRepeatableAgentTool);
    const notRepeatable = [...acts, undefined, 42].map(tools.isRepeatableAgentTool);

    // Assert
    should(repeatable.every(Boolean)).be.true();
    should(notRepeatable.some(Boolean)).be.false();
  });
});

describe('the login hint tool', () => {
  it('should take a page of the agent or a site, never both and never neither', () => {
    should(tools.AgentToolCallSchema.safeParse({ tool: 'login.hint', name: 'app' }).success).be.true();
    should(
      tools.AgentToolCallSchema.safeParse({ tool: 'login.hint', site: 'https://vercel.com/login' }).success,
    ).be.true();
    should(
      tools.AgentToolCallSchema.safeParse({ tool: 'login.hint', name: 'app', site: 'vercel.com' }).success,
    ).be.false();
    should(tools.AgentToolCallSchema.safeParse({ tool: 'login.hint' }).success).be.false();
  });

  it('should answer metadata only: a hint carrying a password is not a result', () => {
    const logins = {
      v: 1,
      site: 'github.com',
      passkeys: 'off',
      hints: [{ id: 'GITHUB', label: 'GitHub', role: 'site', method: { kind: 'password' }, domains: ['github.com'] }],
    };
    should(tools.AgentToolResultSchema.safeParse({ summary: 'ok', logins }).success).be.true();
    should(
      tools.AgentToolResultSchema.safeParse({
        summary: 'ok',
        logins: { ...logins, hints: [{ ...logins.hints[0], password: 'hunter2-UNIQUE' }] },
      }).success,
    ).be.false();
  });

  it('should be repeatable after a dropped request: it changes nothing', () => {
    should(tools.isRepeatableAgentTool('login.hint')).be.true();
  });
});
