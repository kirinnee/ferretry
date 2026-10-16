import { afterEach, describe, it } from 'bun:test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
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

/** A browser with real tabs and no Chrome behind it. */
class FakeBrowser {
  readonly acts: string[] = [];
  private pages = [{ id: 'page-1', url: 'https://blank.test/', title: '' }];
  private active = 'page-1';
  private minted = 1;
  private state(): BrowserPageActionSnapshot {
    const current = this.pages.find(page => page.id === this.active) ?? this.pages[0];
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
  private act(name: string): BrowserPageActionSnapshot {
    this.acts.push(`${this.active}:${name}`);
    return this.state();
  }
  readonly automation: BrowserAutomation = {
    unexpectedExit: new Promise<number>(() => undefined),
    navigate: async url => {
      this.pages = this.pages.map(page => (page.id === this.active ? { ...page, url } : page));
      return this.act('navigate');
    },
    click: async () => this.act('click'),
    type: async () => this.act('type'),
    read: async (_selector, mode) => ({ ...this.act(`read-${mode ?? 'text'}`), text: 'Sign in to continue' }),
    screenshot: async () => ({ ...this.act('screenshot'), screenshotBase64: 'iVBORw0KGgo=' }),
    back: async () => this.state(),
    forward: async () => this.state(),
    reload: async () => this.state(),
    location: async () => this.state(),
    newPage: async url => {
      this.minted += 1;
      const id = `page-${String(this.minted)}`;
      this.pages.push({ id, url: url ?? 'https://blank.test/', title: '' });
      this.active = id;
      return this.state();
    },
    activatePage: async id => {
      this.active = id;
      return this.state();
    },
    closePage: async id => {
      this.pages = this.pages.filter(page => page.id !== id);
      this.active = this.pages[0]?.id ?? id;
      return this.state();
    },
    resize: async () => this.state(),
    startScreencast: async () => undefined,
    stopScreencast: async () => undefined,
    dispatchInput: async () => undefined,
    close: async () => undefined,
  };
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
      body: JSON.stringify({ agent: WRAPPER, cwd: home, prompt: 'drive the tools', name, mode: 'auto' }),
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
        headers: {
          authorization: `Bearer ${daemon.token}`,
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
      await (await fetch(`${daemon.base}/v1/sessions/${hadi}/surfaces/control`, { headers: daemon.human })).json(),
    );
    await fetch(`${daemon.base}/v1/sessions/${hadi}/surfaces/terminals/control`, {
      method: 'POST',
      headers: daemon.human,
      body: JSON.stringify({ action: 'handback', key: 'dev' }),
    });
    const allowed = await tool(hadiCapability, { tool: 'terminal.send', name: 'dev', text: 'ls' });

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
    ).deepEqual([[hadi, 'dev', { by: 'agent', sessionId: hadi }]]);
    should(daemon.browser.acts).deepEqual(['page-1:navigate', 'page-1:type', 'page-1:read-a11y', 'page-1:screenshot']);

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
