import { afterEach, describe, it } from 'bun:test';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
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
  TerminalRecord,
  TerminalRuntimePort,
} from '../../../src/lib/index.ts';
import { AGENT_SESSION_CAPABILITY_HEADER } from '../../../src/lib/runtime/mounts/agent-tools.ts';
import { ABSENT_USER_HOME, cleanupTempDirectories, tempDirectory } from '../support/repository.ts';

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

function boundPort(server: { readonly port?: number }): number {
  if (server.port === undefined) throw new Error('the fixture server reported no port');
  return server.port;
}

async function freeLoopbackPort(): Promise<number> {
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('probe') });
  const port = boundPort(server);
  await server.stop(true);
  return port;
}

/** Records a launch instead of spawning an agent pane; the session documents stay real. */
class RecordingSessionLauncher implements SessionLifecycleLauncher {
  private readonly live = new Set<string>();
  async alive(record: SessionLifecycleRecord): Promise<boolean> {
    return this.live.has(record.config.tmuxSession);
  }
  async launch(record: SessionLifecycleRecord): Promise<void> {
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
  async capture(): Promise<Uint8Array> {
    return new TextEncoder().encode('$ ');
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
    read: async (pageId, _selector, mode) => ({
      ...this.act(`read-${mode ?? 'text'}`, pageId),
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

async function untilListening(port: number): Promise<void> {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    if ((await fetch(`http://127.0.0.1:${port}/healthz`).catch(() => undefined)) !== undefined) return;
    await Bun.sleep(50);
  }
  throw new Error('the daemon never started listening');
}

/** The world under test, with the session credentials each session was delivered. */
async function bootAgentToolsDaemon(home: string) {
  const port = await freeLoopbackPort();
  const cleanups: Array<() => void | Promise<void>> = [];
  const terminals = new RecordingTerminals();
  const browser = new FakeBrowser();
  const launcher: BrowserSessionLauncher = { launch: async () => browser.automation };
  let release = (): void => {};
  await seedHome(home, port);
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

    // The machine's switch, turned off in its real configuration document, refuses the agent on the very
    // next call — on the tools and on the ordinary terminal route alike — and never the person.
    await mkdir(join(daemon.home, 'fleet'), { recursive: true });
    await writeFile(
      join(daemon.home, 'fleet', 'config.yaml'),
      'version: 2\nmachine:\n  agentControl:\n    terminals: false\n',
    );
    const switchedOff = await tool(hadiCapability, { tool: 'terminal.list' });
    const browserStillOn = await tool(hadiCapability, { tool: 'browser.list' });
    const peerRoute = await fetch(`${daemon.base}/v1/sessions/${hadi}/terminals`, {
      headers: { ...daemon.human, 'x-ferretry-session-id': hadi },
    });
    const personRoute = await fetch(`${daemon.base}/v1/sessions/${hadi}/terminals`, { headers: daemon.human });
    await rm(join(daemon.home, 'fleet', 'config.yaml'));
    const switchedOn = await tool(hadiCapability, { tool: 'terminal.list' });

    // Marin's session ends: its credential proves nothing any more, and its pages close.
    await tool(marinCapability, { tool: 'browser.open', name: 'scratch', incognito: true });
    await fetch(`${daemon.base}/v1/sessions/${marin}/stop`, {
      method: 'POST',
      headers: daemon.human,
      body: JSON.stringify({}),
    });
    await Bun.sleep(100);
    const stoppedCredential = await tool(marinCapability, { tool: 'terminal.list' });

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
});
