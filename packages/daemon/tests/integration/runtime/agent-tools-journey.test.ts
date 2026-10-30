import { afterEach, describe, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildFleetManifest } from '@ferretry/fleet';
import {
  AgentToolResultSchema,
  AuditViewSchema,
  type BrowserPageActionSnapshot,
  type FyEvent,
  SessionViewSchema,
  SurfaceControlViewSchema,
} from '@ferretry/protocol';
import should from 'should';
import { buildWorld, type DaemonWorld, start } from '../../../bin/fyd.ts';
import type {
  BrowserAutomation,
  BrowserSessionLauncher,
  SessionLifecycleLauncher,
  SessionLifecycleRecord,
  TerminalCapture,
  TerminalRecord,
  TerminalRuntimePort,
} from '../../../src/lib/index.ts';
import { AGENT_SESSION_CAPABILITY_HEADER } from '../../../src/lib/runtime/mounts/agent-tools.ts';
import { OS_CHOSEN_PORT, recordedPort } from '../support/os-port.ts';
import { ABSENT_USER_HOME, cleanupTempDirectories, tempDirectory } from '../support/repository.ts';
import { waitFor, waitForValue } from '../support/wait-for.ts';

/**
 * The agent tools, driven end to end through the production composition root.
 *
 * Two real sessions are started, each with the credential the daemon minted into its own environment
 * file. An agent then drives a terminal AND a browser page by name over `POST /v1/agent/tools`,
 * presenting only that credential — and everything the security review asks about is checked against
 * the real routes, the real identity resolver over real session documents, the real audit log and the
 * real session journal: own-session-only, take over then hand back, the audit naming surfaces and never
 * typed text, and the driving marker on the event feed.
 *
 * Only the three host adapters that would put processes on the machine are replaced: the agent's pane
 * launcher, the tmux terminal runtime and the browser launcher.
 */

const WRAPPER = 'claude-auto-tools';
const ACCOUNT = '00000000-0000-4000-8000-000000000a71';
const SECRET = 'correct-horse-battery-staple';

/** Records a launch instead of spawning an agent pane; the session documents stay real. */
class RecordingSessionLauncher implements SessionLifecycleLauncher {
  private readonly live = new Set<string>();
  async alive(record: SessionLifecycleRecord): Promise<boolean> {
    return this.live.has(record.config.tmuxSession);
  }
  async launch(record: SessionLifecycleRecord): Promise<undefined> {
    this.live.add(record.config.tmuxSession);
  }
  async ready(_record: SessionLifecycleRecord): Promise<void> {}
  async deliver(_record: SessionLifecycleRecord, _instruction: string, beforeWrite?: () => Promise<void>) {
    await beforeWrite?.();
  }
  async snapshot(): Promise<void> {}
  async stop(record: SessionLifecycleRecord): Promise<void> {
    this.live.delete(record.config.tmuxSession);
  }
}

/** A tmux stand-in that keeps what was typed, so a read sees it, and names its foreground program. */
class RecordingTerminals implements TerminalRuntimePort {
  readonly records = new Map<string, TerminalRecord>();
  readonly typed = new Map<string, string>();
  foregroundCommand = 'sh';
  async list(): Promise<readonly TerminalRecord[]> {
    return [...this.records.values()];
  }
  async create(input: Parameters<TerminalRuntimePort['create']>[0]): Promise<TerminalRecord> {
    const record: TerminalRecord = {
      id: input.id,
      ownerId: input.ownerId,
      title: input.title,
      root: input.cwd,
      tmuxSession: `fy-webterm-${input.ownerId}-${input.id}`,
      createdAtMs: Date.now(),
      lastActivityAtMs: Date.now(),
      ...input.size,
      ...(input.openedBy === undefined ? {} : { openedBy: input.openedBy }),
      ...(input.name === undefined ? {} : { name: input.name }),
    };
    this.records.set(record.id, record);
    return record;
  }
  async rename(record: TerminalRecord, title: string): Promise<void> {
    this.records.set(record.id, { ...record, title });
  }
  async resize(): Promise<void> {}
  async write(record: TerminalRecord, bytes: Uint8Array): Promise<void> {
    this.typed.set(record.id, `${this.typed.get(record.id) ?? ''}${new TextDecoder().decode(bytes)}`);
  }
  async capture(): Promise<TerminalCapture> {
    return { lines: ['$ '], cols: 80, rows: 1, cursorX: 2, cursorY: 0, historySize: 0 };
  }
  async text(record: TerminalRecord): Promise<string> {
    return `$ ${this.typed.get(record.id) ?? ''}`;
  }
  async foreground(): Promise<string> {
    return this.foregroundCommand;
  }
  async kill(record: TerminalRecord): Promise<void> {
    this.records.delete(record.id);
  }
}

/**
 * The machine's agent browser with real tabs and no Chrome behind it: every act names its page, every
 * input lands on the page it names, and there is no active tab to fall back on.
 */
class FakeBrowser {
  readonly acts: string[] = [];
  readonly inputs: string[] = [];
  private pages: { id: string; url: string; title: string; incognito?: true }[] = [
    { id: 'chrome-first', url: 'https://blank.test/', title: '' },
  ];
  private minted = 0;
  private state(pageId?: string): BrowserPageActionSnapshot {
    const current = this.pages.find(page => page.id === pageId) ?? this.pages[0];
    if (current === undefined) throw new Error('no pages');
    return {
      url: current.url,
      title: current.title,
      pages: this.pages.map(page => ({ ...page })),
      activePageId: current.id,
      pageState: 'ready',
      canGoBack: false,
      canGoForward: false,
      actedPageId: current.id,
    };
  }
  private act(name: string, pageId: string): BrowserPageActionSnapshot {
    this.acts.push(`${pageId}:${name}`);
    return this.state(pageId);
  }
  readonly automation: BrowserAutomation = {
    unexpectedExit: new Promise<number>(() => undefined),
    navigate: async (pageId, url) => {
      this.pages = this.pages.map(page => (page.id === pageId ? { ...page, url } : page));
      return this.act('navigate', pageId);
    },
    click: async pageId => this.act('click', pageId),
    type: async pageId => this.act('type', pageId),
    read: async (pageId, options) => ({
      ...this.act(`read-${options?.mode ?? 'text'}`, pageId),
      text: 'Sign in to continue',
    }),
    screenshot: async pageId => ({ ...this.act('screenshot', pageId), screenshotBase64: 'iVBORw0KGgo=' }),
    back: async pageId => this.state(pageId),
    forward: async pageId => this.state(pageId),
    reload: async pageId => this.state(pageId),
    location: async pageId => this.state(pageId),
    newPage: async options => {
      this.minted += 1;
      const id = `page-${String(this.minted)}`;
      this.pages.push({
        id,
        url: options.url ?? 'https://blank.test/',
        title: '',
        ...(options.incognito === true ? { incognito: true as const } : {}),
      });
      return this.state(id);
    },
    closePage: async pageId => {
      this.pages = this.pages.filter(page => page.id !== pageId);
      return { ...this.state(), actedPageId: pageId };
    },
    resize: async pageId => this.state(pageId),
    lifecycle: async pageId => ({ ...this.state(pageId), lifecycle: { text: 'ok' } }),
    startScreencast: async () => undefined,
    stopScreencast: async () => undefined,
    dispatchInput: async pageId => {
      this.inputs.push(pageId);
    },
    close: async () => undefined,
  };
  /** Whether a page is still open. */
  has(pageId: string): boolean {
    return this.pages.some(page => page.id === pageId);
  }
}

async function seedHome(home: string, port: number): Promise<void> {
  process.env.FY_HOME = home;
  const opened = await buildWorld({}, { userHome: ABSENT_USER_HOME }).storage.open();
  await opened.storage.close();
  await writeFile(
    join(home, 'config', 'daemon.json'),
    JSON.stringify({ host: '127.0.0.1', port, relay: { enabled: false, url: 'wss://relay.invalid' } }),
    { mode: 0o600 },
  );
}

async function seedFleet(home: string): Promise<void> {
  const binary = join(home, 'bin');
  await mkdir(binary, { recursive: true });
  const executable = join(binary, WRAPPER);
  await writeFile(executable, `#!/bin/sh\nexport CLAUDE_CONFIG_DIR="${join(home, 'harness')}"\nexit 0\n`, {
    mode: 0o755,
  });
  await mkdir(join(home, 'fleet'), { recursive: true });
  await writeFile(
    join(home, 'fleet', 'manifest.json'),
    JSON.stringify(
      buildFleetManifest({
        generatedAt: '2027-01-15T08:00:00.000Z',
        accounts: [
          {
            id: ACCOUNT,
            kind: 'claude',
            mode: 'auto',
            wrapper: executable,
            home: join(home, 'harness'),
            displayName: 'Tools',
            defaultModel: 'claude-opus-5',
            models: [{ id: 'claude-opus-5', available: true }],
            available: true,
            unavailableReason: null,
          },
        ],
      }),
    ),
    { mode: 0o600 },
  );
}

const untilListening = (port: number): Promise<void> =>
  waitFor(
    async () => (await fetch(`http://127.0.0.1:${port}/healthz`).catch(() => undefined))?.ok === true,
    'the daemon to start listening',
  );

/** The world under test, with the session credentials each session was delivered. */
async function bootAgentToolsDaemon(home: string) {
  const cleanups: Array<() => void | Promise<void>> = [];
  const terminals = new RecordingTerminals();
  const browser = new FakeBrowser();
  const launcher: BrowserSessionLauncher = { launch: async () => browser.automation };
  let release = (): void => {};
  await seedHome(home, OS_CHOSEN_PORT);
  const shutdown = new Promise<void>(resolve => {
    release = resolve;
  });
  const world: DaemonWorld = {
    ...buildWorld({}, { userHome: ABSENT_USER_HOME }),
    untilShutdown: async () => await shutdown,
    sessionLauncher: new RecordingSessionLauncher(),
    terminalRuntime: terminals,
    browserLauncher: launcher,
  };
  await seedFleet(home);
  const exit = start(world, cleanups);
  const port = await recordedPort(home);
  await untilListening(port);
  const token = (await readFile(join(home, 'api-token'), 'utf8')).trim();
  const base = `http://127.0.0.1:${port}`;
  const human = { authorization: `Bearer ${token}`, 'x-ferretry-client': 'cli', 'content-type': 'application/json' };
  const startSession = async (requestId: string, name: string): Promise<string> => {
    const response = await fetch(`${base}/v1/sessions`, {
      method: 'POST',
      headers: { ...human, 'x-fy-request-id': requestId },
      body: JSON.stringify({
        agent: WRAPPER,
        cwd: home,
        prompt: 'drive the tools',
        name: `${name}'s task`,
        teammate: name.toLowerCase(),
        mode: 'auto',
      }),
    });
    const body: unknown = await response.json();
    if (!response.ok) throw new Error(`the session did not start: ${JSON.stringify(body)}`);
    return SessionViewSchema.parse(body).config.id;
  };
  const capabilityOf = async (sessionId: string): Promise<string> => {
    const environment = JSON.parse(
      await readFile(join(home, 'state', 'sessions', sessionId, 'environment.json'), 'utf8'),
    ) as Readonly<Record<string, string>>;
    return environment.FY_SESSION_BOARD_CAPABILITY ?? '';
  };
  return {
    base,
    home,
    token,
    human,
    terminals,
    browser,
    startSession,
    capabilityOf,
    stop: async (): Promise<number> => {
      release();
      const code = await exit;
      for (const cleanup of cleanups) await cleanup();
      return code;
    },
  };
}

/** The CLI's own entry, run the way a harness runs a stdio MCP server. */
const FY_ENTRY = resolve(import.meta.dir, '../../../../cli/bin/fy.ts');

/**
 * An MCP client over a real `fy mcp serve` child: newline-delimited JSON-RPC on its stdin and stdout,
 * exactly what Claude Code and Codex speak to a stdio server.
 */
function mcpClient(environment: Readonly<Record<string, string>>) {
  const child = Bun.spawn({
    cmd: [process.execPath, FY_ENTRY, 'mcp', 'serve'],
    env: environment,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const waiting = new Map<number, (message: unknown) => void>();
  void (async () => {
    let buffer = '';
    for await (const chunk of child.stdout) {
      buffer += new TextDecoder().decode(chunk);
      for (let newline = buffer.indexOf('\n'); newline !== -1; newline = buffer.indexOf('\n')) {
        const message = JSON.parse(buffer.slice(0, newline)) as { id: number };
        buffer = buffer.slice(newline + 1);
        waiting.get(message.id)?.(message);
      }
    }
  })();
  let next = 0;
  const send = (message: unknown): void => {
    void child.stdin.write(`${JSON.stringify(message)}\n`);
    void child.stdin.flush();
  };
  return {
    request: async (method: string, params?: unknown): Promise<any> => {
      next += 1;
      const id = next;
      const answer = new Promise<unknown>(done => waiting.set(id, done));
      send({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
      return await answer;
    },
    notify: (method: string): void => send({ jsonrpc: '2.0', method }),
    call: async (name: string, args: Record<string, unknown>): Promise<any> => {
      next += 1;
      const id = next;
      const answer = new Promise<unknown>(done => waiting.set(id, done));
      send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
      return ((await answer) as { result: unknown }).result;
    },
    close: async (): Promise<number> => {
      void child.stdin.end();
      return await child.exited;
    },
  };
}

describe('the agent tools, through the production composition root', () => {
  const previousHome = process.env.FY_HOME;

  afterEach(async () => {
    if (previousHome === undefined) delete process.env.FY_HOME;
    else process.env.FY_HOME = previousHome;
    await cleanupTempDirectories();
  });

  it('should let an agent drive its own terminal and browser by name, and nothing of another session', async () => {
    // Arrange
    const daemon = await bootAgentToolsDaemon(await tempDirectory('fyd-agent-tools'));
    const hadi = await daemon.startSession('req-tools-hadi', 'Hadi');
    const marin = await daemon.startSession('req-tools-marin', 'Marin');
    const hadiCapability = await daemon.capabilityOf(hadi);
    const marinCapability = await daemon.capabilityOf(marin);
    const tool = async (capability: string, body: unknown, extra: Readonly<Record<string, string>> = {}) =>
      await fetch(`${daemon.base}/v1/agent/tools`, {
        method: 'POST',
        // NO host token: the session credential is the whole of an agent's authority here.
        headers: {
          'content-type': 'application/json',
          ...(capability === '' ? {} : { [AGENT_SESSION_CAPABILITY_HEADER]: capability }),
          ...extra,
        },
        body: JSON.stringify(body),
      });
    const result = async (response: Response) => AgentToolResultSchema.parse(await response.json());

    // Act — Hadi drives a terminal and a page by name.
    const opened = await result(await tool(hadiCapability, { tool: 'terminal.open', name: 'dev', command: 'bun dev' }));
    await tool(hadiCapability, {
      tool: 'terminal.send',
      name: '%terminal:dev',
      text: `export TOKEN=${SECRET}`,
      keys: ['enter'],
    });
    const read = await result(await tool(hadiCapability, { tool: 'terminal.read', name: 'dev', lines: 10 }));
    const waited = await result(await tool(hadiCapability, { tool: 'terminal.wait', name: 'dev', exit: true }));
    const page = await result(
      await tool(hadiCapability, { tool: 'browser.open', name: 'app', url: 'http://localhost:5173/login' }),
    );
    await tool(hadiCapability, { tool: 'browser.type', name: 'app', selector: '#password', text: SECRET });
    const text = await result(await tool(hadiCapability, { tool: 'browser.read', name: 'app', mode: 'a11y' }));
    const shot = await result(await tool(hadiCapability, { tool: 'browser.screenshot', name: 'app' }));

    // Marin, holding its own credential and claiming Hadi's session id, reaches nothing of Hadi's.
    const crossTerminal = await tool(
      marinCapability,
      { tool: 'terminal.send', name: 'dev', text: 'rm -rf ~' },
      {
        'x-ferretry-session-id': hadi,
      },
    );
    const crossPage = await tool(marinCapability, { tool: 'browser.read', name: 'app' });
    const marinList = await result(await tool(marinCapability, { tool: 'terminal.list' }));
    const noCredential = await tool('', { tool: 'terminal.list' });
    const forged = await tool('not-a-session-credential', { tool: 'terminal.list' });
    const asBody = await tool(marinCapability, { tool: 'terminal.list', sessionId: hadi });

    // A person takes the terminal over; the agent is refused until it is handed back.
    const takeover = await fetch(`${daemon.base}/v1/sessions/${hadi}/surfaces/terminals/control`, {
      method: 'POST',
      headers: daemon.human,
      body: JSON.stringify({ action: 'takeover', key: 'dev' }),
    });
    const refused = await tool(hadiCapability, { tool: 'terminal.send', name: 'dev', text: 'ls' });
    const agentHandback = await fetch(`${daemon.base}/v1/sessions/${hadi}/surfaces/terminals/control`, {
      method: 'POST',
      headers: { ...daemon.human, 'x-ferretry-session-id': hadi },
      body: JSON.stringify({ action: 'handback', key: 'dev' }),
    });
    const control = SurfaceControlViewSchema.parse(
      await (
        await fetch(`${daemon.base}/v1/sessions/${hadi}/surfaces/terminals/control`, { headers: daemon.human })
      ).json(),
    );
    await fetch(`${daemon.base}/v1/sessions/${hadi}/surfaces/terminals/control`, {
      method: 'POST',
      headers: daemon.human,
      body: JSON.stringify({ action: 'handback', key: 'dev' }),
    });
    const allowed = await tool(hadiCapability, { tool: 'terminal.send', name: 'dev', text: 'ls' });

    // A person's own terminal and page in Hadi's session are not Hadi's to touch — until handed over.
    const person = async (path: string, body: unknown, extra: Readonly<Record<string, string>> = {}) =>
      await fetch(`${daemon.base}/v1/sessions/${hadi}/surfaces/${path}`, {
        method: 'POST',
        headers: { ...daemon.human, ...extra },
        body: JSON.stringify(body),
      });
    await person('terminals/tools', { tool: 'terminal.open', name: 'mine' });
    await person('browser/tools', { tool: 'browser.open', name: 'bank', url: 'https://bank.test/' });
    const notYours = await tool(hadiCapability, { tool: 'terminal.read', name: 'mine' });
    const notYourPage = await tool(hadiCapability, { tool: 'browser.screenshot', name: 'bank' });
    await person('terminals/control', { action: 'handover', key: 'mine' });
    const handed = await tool(hadiCapability, { tool: 'terminal.send', name: 'mine', text: 'whoami' });

    // A takeover holds ONE tab: the agent keeps working on its other page meanwhile.
    await tool(hadiCapability, { tool: 'browser.open', name: 'login', url: 'https://login.test/' });
    await person('browser/control', { action: 'takeover', key: 'login' });
    const heldTab = await tool(hadiCapability, { tool: 'browser.click', name: 'login', selector: 'button' });
    const otherTab = await tool(hadiCapability, { tool: 'browser.click', name: 'app', selector: 'a' });
    const incognito = await result(
      await tool(hadiCapability, { tool: 'browser.open', name: 'private', url: 'https://bank.test/', incognito: true }),
    );
    const pages = await result(await tool(hadiCapability, { tool: 'browser.list' }));

    // The machine's switch, turned off in its real configuration file, refuses the agent on the very
    // next call — on the tools and on the ordinary terminal route alike — and never the person. Turning
    // it off tightens, so it is in effect the moment it is saved.
    await mkdir(join(daemon.home, 'config'), { recursive: true });
    await writeFile(join(daemon.home, 'config', 'machine.yaml'), 'agentControl:\n  terminals: false\n');
    const switchedOff = await tool(hadiCapability, { tool: 'terminal.list' });
    const browserStillOn = await tool(hadiCapability, { tool: 'browser.list' });
    const peerRoute = await fetch(`${daemon.base}/v1/sessions/${hadi}/terminals`, {
      headers: { ...daemon.human, 'x-ferretry-session-id': hadi },
    });
    const personRoute = await fetch(`${daemon.base}/v1/sessions/${hadi}/terminals`, { headers: daemon.human });
    // Deleting the file turns it back ON, which loosens: held until the owner confirms it from this machine.
    await rm(join(daemon.home, 'config', 'machine.yaml'));
    const stillOff = await tool(hadiCapability, { tool: 'terminal.list' });
    const confirmed = await fetch(`${daemon.base}/v1/config/confirm`, {
      method: 'POST',
      headers: daemon.human,
      body: JSON.stringify({ path: 'machine.yaml', etag: 'absent' }),
    });
    const switchedOn = await tool(hadiCapability, { tool: 'terminal.list' });

    // Marin's session ends: its credential proves nothing any more, and its pages close.
    await tool(marinCapability, { tool: 'browser.open', name: 'scratch', incognito: true });
    await fetch(`${daemon.base}/v1/sessions/${marin}/stop`, {
      method: 'POST',
      headers: daemon.human,
      body: JSON.stringify({}),
    });
    await waitFor(() => !daemon.browser.has('page-5'), "the stopped session's pages to close");
    const stoppedCredential = await waitForValue(async () => {
      const refused = await tool(marinCapability, { tool: 'terminal.list' });
      return refused.status === 403 ? refused : undefined;
    }, "the stopped session's credential to be refused");

    const audit = AuditViewSchema.parse(
      await (await fetch(`${daemon.base}/v1/audit?limit=200`, { headers: daemon.human })).json(),
    );
    const events = (await (
      await fetch(`${daemon.base}/v1/sessions/${hadi}/events?after=0`, { headers: daemon.human })
    ).json()) as FyEvent[];
    const code = await daemon.stop();

    // Assert — what Hadi did, it did in Hadi's session.
    should(code).equal(0);
    should(opened.summary).equal('Opened %terminal:dev and started the command.');
    should(read.output).equal(`$ bun dev\rexport TOKEN=${SECRET}\r`);
    should(waited).match({ matched: true, summary: 'The command ended in %terminal:dev.' });
    should(page.summary).equal('Opened %browser:app at http://localhost:5173/login.');
    should(text.output).equal('Sign in to continue');
    should(shot.screenshotBase64).equal('iVBORw0KGgo=');
    should(
      [...daemon.terminals.records.values()].map(record => [record.ownerId, record.name, record.openedBy]),
    ).deepEqual([
      [hadi, 'dev', { by: 'agent', sessionId: hadi }],
      [hadi, 'mine', { by: 'local' }],
    ]);
    should(daemon.browser.acts.slice(0, 3)).deepEqual(['page-1:type', 'page-1:read-a11y', 'page-1:screenshot']);
    should(daemon.browser.acts).containEql('page-1:click');
    should(daemon.browser.acts.some(act => act.startsWith('page-3:click'))).be.false();

    // Nothing of Hadi's was reachable with Marin's credential, whatever else Marin claimed.
    should(crossTerminal.status).equal(404);
    should(crossPage.status).equal(404);
    should(marinList.surfaces).deepEqual([]);
    should([noCredential.status, forged.status, asBody.status]).deepEqual([401, 403, 400]);
    should(daemon.terminals.typed.get([...daemon.terminals.records.keys()][0] ?? '')).not.containEql('rm -rf');

    // Take over, then hand back — and an agent cannot hand a surface back to itself.
    should(takeover.status).equal(200);
    should(refused.status).equal(409);
    should(await refused.json()).match({
      code: 'taken_over',
      error: 'A person has taken over %terminal:dev; wait or ask them.',
    });
    should(agentHandback.status).equal(403);
    should(control.takeovers).match([{ surface: 'terminal', name: 'dev', by: { by: 'local' } }]);
    should(allowed.status).equal(200);

    // Ownership: the person's surfaces were refused until the terminal was handed over.
    should([notYours.status, notYourPage.status]).deepEqual([403, 403]);
    should(await notYours.json()).match({ code: 'forbidden', error: /is a person's, not yours/u });
    should(handed.status).equal(200);

    // Per-tab takeover, and an incognito page marked as one.
    should(heldTab.status).equal(409);
    should(otherTab.status).equal(200);
    should(incognito.summary).startWith('Opened an incognito page, %browser:private');
    should(pages.surfaces?.find(surface => surface.name === 'private')).match({ incognito: true, available: true });
    // The person's page is not in the agent's list at all — not its name, URL or title.
    should(pages.surfaces?.map(surface => surface.name)).not.containEql('bank');

    // The switch, read fresh per call through the real configuration.
    should(switchedOff.status).equal(403);
    should(await switchedOff.json()).match({ error: /"What agents may control › Terminals" is off/u });
    should(browserStillOn.status).equal(200);
    should(peerRoute.status).equal(403);
    should(personRoute.status).equal(200);
    should(stillOff.status).equal(403);
    should(await confirmed.json()).deepEqual({ path: 'machine.yaml', confirmed: true });
    should(switchedOn.status).equal(200);

    // A stopped session.
    should(stoppedCredential.status).equal(403);
    should(daemon.browser.has('page-5')).be.false();

    // The audit names every act by tool and surface, and never holds what was typed.
    const tools = audit.records.filter(record => record.event === 'agent.tool');
    should(JSON.stringify(audit)).not.containEql(SECRET);
    should(
      tools.some(record => record.detail?.tool === 'terminal.send' && record.detail.surface === '%terminal:dev'),
    ).be.true();
    should(
      tools.some(record => record.detail?.tool === 'browser.type' && record.detail.textLength === SECRET.length),
    ).be.true();
    should(tools.some(record => record.outcome === 'refused' && record.detail?.tool === 'terminal.send')).be.true();
    should(
      audit.records.some(record => record.event === 'surface.control' && record.detail?.action === 'takeover'),
    ).be.true();

    // The driving marker and the takeover reached the session's own event feed.
    const types = events.map(event => event.type);
    should(types).containEql('surface.driving');
    should(types).containEql('surface.takeover');
    should(types).containEql('surface.handback');
    should(events.find(event => event.type === 'surface.driving')?.data).match({
      surface: 'terminal',
      name: 'dev',
      agentSessionId: hadi,
      agentName: 'Hadi',
    });
  }, 60_000);

  it('should let an agent drive a terminal and a browser through `fy mcp serve`, as itself and only itself', async () => {
    // Arrange — the agent's environment as the fixed layer hands it to the tools server: the session's
    // credential and where the daemon is, and NO admin token. FY_HOME points at an empty folder, so
    // there is no token file to fall back on either: the session credential is all it has.
    const home = await tempDirectory('fyd-agent-mcp');
    const daemon = await bootAgentToolsDaemon(home);
    const hadi = await daemon.startSession('req-mcp-hadi', 'Hadi');
    const empty = await mkdtemp(join(tmpdir(), 'fy-no-token-'));
    const environment: Record<string, string> = {
      PATH: process.env.PATH ?? '',
      HOME: empty,
      FY_HOME: empty,
      FY_URL: daemon.base,
      FY_SESSION_ID: hadi,
      FY_SESSION_BOARD_CAPABILITY: await daemon.capabilityOf(hadi),
    };
    const mcp = mcpClient(environment);

    // Act
    const initialized = await mcp.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'fake-harness', version: '1' },
    });
    mcp.notify('notifications/initialized');
    const listed = await mcp.request('tools/list');
    const opened = await mcp.call('terminal_open', { name: 'dev', command: 'bun dev' });
    const sent = await mcp.call('terminal_send', { name: '%terminal:dev', text: `echo ${SECRET}`, keys: ['enter'] });
    const read = await mcp.call('terminal_read', { name: 'dev' });
    const waited = await mcp.call('terminal_wait', { name: 'dev', exit: true, timeoutMs: 5_000 });
    const page = await mcp.call('browser_open', { name: 'app', url: 'http://localhost:5173/' });
    const typed = await mcp.call('browser_type', { name: 'app', selector: '#q', text: SECRET });
    const tree = await mcp.call('browser_read', { name: 'app', mode: 'a11y' });
    const shot = await mcp.call('browser_screenshot', { name: 'app' });
    await fetch(`${daemon.base}/v1/sessions/${hadi}/surfaces/browser/control`, {
      method: 'POST',
      headers: daemon.human,
      body: JSON.stringify({ action: 'takeover', key: 'app' }),
    });
    const refused = await mcp.call('browser_click', { name: 'app', selector: 'button' });
    const elsewhere = await mcp.call('terminal_list', { sessionId: 'someone-else' });
    const exit = await mcp.close();
    const audit = JSON.stringify(
      await (await fetch(`${daemon.base}/v1/audit?limit=200`, { headers: daemon.human })).json(),
    );
    const code = await daemon.stop();

    // Assert
    should(code).equal(0);
    should(exit).equal(0);
    should(initialized.result).match({ protocolVersion: '2025-06-18', capabilities: { tools: {} } });
    should(listed.result.tools.map((tool: { name: string }) => tool.name)).containDeep([
      'terminal_open',
      'terminal_send',
      'terminal_read',
      'terminal_wait',
      'browser_open',
      'browser_screenshot',
    ]);
    should(opened).deepEqual({ content: [{ type: 'text', text: 'Opened %terminal:dev and started the command.' }] });
    should(sent.content[0].text).equal(
      `Sent ${String(`echo ${SECRET}`.length)} characters and 1 key to %terminal:dev.`,
    );
    should(read.content[0].text).containEql(`echo ${SECRET}`);
    should(waited.content[0].text).startWith('The command ended in %terminal:dev.');
    should(page.content[0].text).equal('Opened %browser:app at http://localhost:5173/.');
    should(typed.isError).be.undefined();
    should(tree.content[0].text).containEql('Sign in to continue');
    should(shot.content).containDeep([{ type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' }]);
    should(refused).deepEqual({
      content: [{ type: 'text', text: 'A person has taken over %browser:app; wait or ask them.' }],
      isError: true,
    });
    should(elsewhere.isError).be.true();
    // It acted as Hadi, in Hadi's session, and the audit never saw what it typed.
    should([...daemon.terminals.records.values()].map(record => [record.ownerId, record.openedBy])).deepEqual([
      [hadi, { by: 'agent', sessionId: hadi }],
    ]);
    should(daemon.browser.acts).deepEqual(['page-1:type', 'page-1:read-a11y', 'page-1:screenshot']);
    // The server never held host authority.
    should(Object.keys(environment)).not.containEql('FY_TOKEN');
    should(Object.values(environment)).not.containEql(daemon.token);
    await rm(empty, { recursive: true, force: true });
    should(audit).containEql('"tool":"browser.type"');
    should(audit).not.containEql(SECRET);
  }, 60_000);
});
