import { describe, expect, test } from 'bun:test';
import { AgentConfigCallSchema } from '@ferretry/kernel/contract';
import { fixedClock } from '@ferretry/kernel/testing';
import { agentConfig } from '../../../../core/kernel/host/config/agent.ts';
import { createConfigFiles } from '../../../../core/kernel/host/config/service.ts';
import { createMemoryHostFs } from '../../../../core/kernel/host/state/memory-fs.ts';
import { MCP_CONFIG, McpItemSchema, SessionMcpPreviewRequestSchema } from '../../contract/index.ts';
import { fakeMcp, mcpConformance } from '../../contract/testing/index.ts';
import manifest from '../../manifest.ts';

const route = (key: string) => manifest.actions.routes.find(candidate => candidate.key === key);
const demand = (key: string) => `${String(route(key)?.capability?.capability)}.${route(key)?.capability?.axis}`;

describe('mcp contract', () => {
  test('the fake passes the conformance suite', async () => {
    expect((await mcpConformance(fakeMcp)).ok).toBe(true);
  });

  test('the manifest declares 13 routes, 7 verbs and takes launch.parts', () => {
    expect(manifest.actions.routes.length).toBe(13);
    expect(manifest.actions.cli.length).toBe(7);
    expect(manifest.hooks.takes.map(take => take.hook.name)).toEqual(['launch.parts', 'runtimes.components.mcp']);
  });

  test('G176 (declaration only) each MCP-add route declares exactly one capability, as tabled', () => {
    expect(demand('POST /v1/ferrets/:ferretId/mcp/project/preview')).toBe('filesystem.use');
    expect(demand('POST /v1/ferrets/:ferretId/mcp/login/preview')).toBe('fleet.use');
    expect(demand('POST /v1/ferrets/:ferretId/mcp/project')).toBe('filesystem.configure');
    expect(demand('POST /v1/ferrets/:ferretId/mcp/login')).toBe('fleet.configure');
    expect(route('POST /v1/ferrets/:ferretId/mcp/login')?.caller).toBe('person');
  });

  test('G179 (declaration only) an add is logged as fleet.configured with a scope, a preview is not', () => {
    expect(route('POST /v1/ferrets/:ferretId/mcp/project')?.audit as unknown).toEqual({
      record: 'fleet.configured:mcp-add-project',
    });
    expect(route('POST /v1/ferrets/:ferretId/mcp/login')?.audit as unknown).toEqual({
      record: 'fleet.configured:mcp-add-login',
    });
    expect('skip' in (route('POST /v1/ferrets/:ferretId/mcp/project/preview')?.audit ?? {})).toBe(true);
  });

  test('S174 (declaration only) every sign-in act is fleet.configure by a person', () => {
    for (const key of [
      'POST /v1/mcp/auth/:component',
      'DELETE /v1/mcp/auth/:component',
      'POST /v1/mcp/auth/flows/:flowId',
      'DELETE /v1/mcp/auth/flows/:flowId',
    ]) {
      expect(demand(key)).toBe('fleet.configure');
      expect(route(key)?.caller).toBe('person');
    }
  });

  test('an item is a command or a url, never both, and a raw secret reference must be well formed', () => {
    expect(McpItemSchema.safeParse({ command: 'npx', args: ['x'] }).success).toBe(true);
    expect(McpItemSchema.safeParse({ command: 'npx', url: 'https://a.example' }).success).toBe(false);
    expect(McpItemSchema.safeParse({ command: 'x', env: { A: '${secret:lower}' } }).success).toBe(false);
    expect(McpItemSchema.safeParse({ command: 'x', env: { A: '${secret:UPPER_1}' } }).success).toBe(true);
    expect(McpItemSchema.safeParse({ url: 'http://a.example', auth: 'oauth' }).success).toBe(false);
    expect(MCP_CONFIG.axis).toBe('configure');
  });

  test('R9 M1 a failing mcp/<name>.yaml is withheld whole by config_read, its issues kept', async () => {
    const SILENT = {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      child: () => SILENT,
    };
    const home = '/mcp-test-only';
    const fs = createMemoryHostFs();
    const files = createConfigFiles({
      home,
      fs,
      clock: fixedClock(),
      log: SILENT,
      binary: 'fy',
      defs: [{ plugin: 'mcp', def: MCP_CONFIG }],
    });
    const agent = agentConfig({
      writer: () => files.writer(),
      control: () => ({ allows: async () => true }),
      status: () => files.status(),
      home,
      binary: 'fy',
      now: () => '2026-01-01T00:00:00.000Z',
    });
    fs.seed(`${home}/config/mcp/gw.yaml`, 'command: npx\n');
    await files.reload();
    const fake = 'made-up-value-9f2k';
    fs.seed(`${home}/config/mcp/gw.yaml`, `commnd: npx\nenv:\n  A: ${fake}\n`);
    await files.reload();
    const answer = await agent.run(AgentConfigCallSchema.parse({ tool: 'config.read', path: 'mcp/gw.yaml' }), {
      credential: { kind: 'authenticated', tokenClass: 'ferret', ferret: 'wren' },
    });
    expect(answer.text).toBe('');
    expect((answer.issues ?? []).length).toBeGreaterThan(0);
    expect(JSON.stringify(answer)).not.toContain(fake);
  });

  test('an add request refuses a field it does not know', () => {
    const server = { transport: 'url', url: 'https://a.example', oauth: false };
    expect(SessionMcpPreviewRequestSchema.safeParse({ name: 'a', server }).success).toBe(true);
    expect(SessionMcpPreviewRequestSchema.safeParse({ name: 'a', server, file: '.mcp.json' }).success).toBe(false);
  });
});
