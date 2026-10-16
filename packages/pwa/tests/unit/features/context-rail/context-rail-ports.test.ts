import { describe, expect, it } from 'bun:test';
import { MCP_OAUTH_PATH } from '@ferretry/protocol';
import {
  attentionSignalsPort,
  fleetMcpLoader,
  instructionDocsLoader,
  sessionSkillsLoader,
} from '../../../../src/features/context-rail/context-rail-ports.ts';
import { DaemonAttentionClient } from '../../../../src/lib/attention-client.ts';
import { daemonConnection } from '../../../../src/lib/daemon-connection.ts';
import { daemonSessionScope } from '../../../../src/lib/daemon-scope.ts';
import type { DaemonFetch } from '../../../../src/lib/runtime-models.ts';
import { component } from '../fleet/components/catalog-fixture.ts';
import { type Call, factoryFor } from '../fleet/mcp-sign-in-support.ts';
import { answeredItem, openItem, SKILLS, snapshot } from './context-rail-fixtures.ts';

const daemon = daemonConnection({ daemonId: 'studio', baseUrl: 'https://studio.example.test', deviceId: 'token' });
const scope = daemonSessionScope(daemon, 'session-a');

const json = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

describe('attentionSignalsPort', () => {
  it('reads, answers and resolves through the shared attention client and store', async () => {
    const requests: { url: string; method: string; body: unknown }[] = [];
    let answers: Response[] = [json({ error: 'down' }, 503)];
    const fetcher: DaemonFetch = async (url, init) => {
      requests.push({
        url: String(url),
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      });
      const next = answers.shift();
      if (next === undefined) throw new Error('no answer scripted');
      return next;
    };
    const client = new DaemonAttentionClient(undefined, fetcher);
    const port = attentionSignalsPort(client, daemon, scope);
    let notified = 0;
    const stop = port.subscribe(() => {
      notified += 1;
    });

    expect(port.status()).toBe('idle');
    await expect(port.load()).rejects.toThrow('down');
    expect(port.status()).toBe('error');
    expect(port.snapshot()).toBeUndefined();

    // A retry after a failure reads again rather than trusting the failed board.
    answers = [json(snapshot([openItem({ ask: { kind: 'permission' } })], []))];
    await port.load();
    expect(port.status()).toBe('ready');
    expect(port.snapshot()?.count).toBe(1);

    const answered = snapshot(
      [],
      [answeredItem({ id: 'A1', ask: { kind: 'permission' }, response: { kind: 'permission', decision: 'approve' } })],
    );
    answers = [json(answered), json(answered)];
    await port.respond('A1', { kind: 'permission', decision: 'approve' });
    await port.resolve('A1');
    expect(requests.slice(-2).map(request => request.body)).toEqual([
      { action: 'resolve', id: 'A1', response: { kind: 'permission', decision: 'approve' } },
      { action: 'resolve', id: 'A1' },
    ]);
    expect(port.snapshot()?.count).toBe(0);
    expect(notified).toBeGreaterThan(0);
    stop();
  });
});

describe('fleetMcpLoader', () => {
  const catalog = {
    format: 'version-2',
    kinds: [
      {
        kind: 'mcp',
        label: 'MCP servers',
        description: 'Tools.',
        components: [
          component({
            reference: 'mcp/notion',
            kind: 'mcp',
            name: 'notion',
            detail: { kind: 'mcp', url: 'https://mcp.notion.example', auth: 'oauth', env: [] },
            usedBy: { profiles: ['Default'], runtimes: ['claude-default'] },
          }),
          component({
            reference: 'mcp/github',
            kind: 'mcp',
            name: 'github',
            detail: { kind: 'mcp', command: 'npx', env: [] },
          }),
        ],
      },
    ],
  };

  it('reads the catalogue and the sign-ins from the agent’s machine, narrowed to its runtime', async () => {
    const calls: Call[] = [];
    const answers = { 'GET /v1/fleet/components': catalog, [`GET ${MCP_OAUTH_PATH}`]: { connections: [] } };
    const servers = await fleetMcpLoader(
      daemon,
      factoryFor(answers, calls),
      'claude-default',
    )(new AbortController().signal);
    expect(servers).toEqual([{ name: 'notion', transport: 'url', signsIn: true }]);
    expect(calls.map(call => call.path).sort()).toEqual(['/v1/fleet/components', MCP_OAUTH_PATH]);

    const every = await fleetMcpLoader(daemon, factoryFor(answers))(new AbortController().signal);
    expect(every.map(server => server.name)).toEqual(['github', 'notion']);
  });
});

describe('sessionSkillsLoader', () => {
  it('reads the skills of exactly the agent’s session', async () => {
    const seen: unknown[] = [];
    const signal = new AbortController().signal;
    const loader = sessionSkillsLoader(async (target, given) => {
      seen.push([target, given]);
      return SKILLS;
    }, scope);
    expect(await loader(signal)).toBe(SKILLS);
    expect(seen).toEqual([[scope, signal]]);
  });
});

describe('instructionDocsLoader', () => {
  it('lists the root of the agent’s folder and keeps its instruction files', async () => {
    const urls: string[] = [];
    const fetcher: DaemonFetch = async url => {
      urls.push(String(url));
      return json({
        root: '/work/app',
        path: '',
        entries: [
          { name: 'src', type: 'dir' },
          { name: 'AGENTS.md', type: 'file', size: 1434 },
          { name: 'CLAUDE.md', type: 'file', size: 12_800 },
        ],
      });
    };
    const docs = await instructionDocsLoader(daemon, scope, fetcher)(new AbortController().signal);
    expect(docs).toEqual([
      { path: 'CLAUDE.md', name: 'CLAUDE.md', size: 12_800 },
      { path: 'AGENTS.md', name: 'AGENTS.md', size: 1434 },
    ]);
    expect(urls).toEqual(['https://studio.example.test/v1/sessions/session-a/fs']);
  });
});
