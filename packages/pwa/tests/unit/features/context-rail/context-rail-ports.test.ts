import { describe, expect, it } from 'bun:test';
import {
  attentionSignalsPort,
  instructionDocsLoader,
  sessionMcpLoader,
  sessionSkillsInventoryLoader,
  skillFileLoader,
} from '../../../../src/features/context-rail/context-rail-ports.ts';
import { DaemonAttentionClient } from '../../../../src/lib/attention-client.ts';
import { daemonConnection } from '../../../../src/lib/daemon-connection.ts';
import { daemonSessionScope } from '../../../../src/lib/daemon-scope.ts';
import type { DaemonFetch } from '../../../../src/lib/runtime-models.ts';
import { type Call, factoryFor } from '../fleet/mcp-sign-in-support.ts';
import { answeredItem, MCP, openItem, SKILLS, snapshot } from './context-rail-fixtures.ts';

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

describe('the MCP and skills inventory loaders', () => {
  it('read exactly this ferret’s servers, skills and one SKILL.md from its machine', async () => {
    const calls: Call[] = [];
    const path = '/fy/fleet/homes/claude-work/skills/floop/SKILL.md';
    const answers = {
      'GET /v1/sessions/session%20a/mcp/servers': MCP,
      'GET /v1/sessions/session%20a/skills/inventory': SKILLS,
      [`GET /v1/skills/file?path=${encodeURIComponent(path)}&sessionId=session%20a`]: { path, content: '# Floop' },
    };
    const signal = new AbortController().signal;

    expect(await sessionMcpLoader(daemon, factoryFor(answers, calls), 'session a')(signal)).toEqual(MCP);
    expect(await sessionSkillsInventoryLoader(daemon, factoryFor(answers, calls), 'session a')(signal)).toEqual(SKILLS);
    expect(await skillFileLoader(daemon, factoryFor(answers, calls), 'session a')(path, signal)).toEqual({
      path,
      content: '# Floop',
    });
    expect(calls.map(call => call.path)).toEqual(Object.keys(answers).map(key => key.slice('GET '.length)));
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
