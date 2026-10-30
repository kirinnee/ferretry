import { describe, expect, it } from 'bun:test';
import {
  instructionDocsLoader,
  sessionMcpLoader,
  sessionSkillsInventoryLoader,
  skillFileLoader,
} from '../../../../src/features/context-rail/context-rail-ports.ts';
import { daemonConnection } from '../../../../src/lib/daemon-connection.ts';
import { daemonSessionScope } from '../../../../src/lib/daemon-scope.ts';
import type { DaemonFetch } from '../../../../src/lib/runtime-models.ts';
import { type Call, factoryFor } from '../fleet/mcp-sign-in-support.ts';
import { MCP, SKILLS } from './context-rail-fixtures.ts';

const daemon = daemonConnection({ daemonId: 'studio', baseUrl: 'https://studio.example.test', deviceId: 'token' });
const scope = daemonSessionScope(daemon, 'session-a');

const json = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

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
