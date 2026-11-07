import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { extract } from './extract.ts';

const FILES: Readonly<Record<string, string>> = {
  'packages/daemon/src/lib/runtime/mounts/shared.ts': `
    export const FLEET_USE = { capability: 'fleet', axis: 'use' } as const;
    export const API = '/v1';
  `,
  'packages/daemon/src/lib/runtime/mounts/things.ts': `
    import { API, FLEET_USE } from './shared.ts';
    const READ = { minimum: 'operator', caller: 'any', capability: FLEET_USE, noStore: true } as const;
    export function thingRoutes() {
      const privileged = true;
      return [
        // { method: 'GET', path: '/v1/in-a-comment', minimum: 'none', caller: 'any' }
        { ...READ, method: 'GET', path: \`\${API}/things/:thingId\`, handle: async () => 1 },
        { method: 'POST', path: '/v1/things', minimum: 'admin-token', caller: 'person', privilegedOnly: privileged,
          capability: { ...FLEET_USE, narrowing: true }, ferretDoor: 'use the tool', available: () => true },
        { method: 'GET', path: '/v1/things/:thingId/stream', minimum: 'operator', caller: 'any', accept: async () => 1 },
        { method: 'GET', path: '/v1/audited', event: 'x' },
        { method: 'GET', path: makePath(), minimum: 'none', caller: 'any' },
      ];
    }
  `,
  'packages/daemon/src/lib/catalog-members/shared-routes.ts': `
    export const routes = [{ method: 'GET', path: '/v1/shared/me', needs: 'unlocked', handle: async () => 1 }];
  `,
  'packages/cli/src/lib/mcp/tools.ts': `
    export const MCP_TOOLS = [
      { name: 'terminal_read', tool: 'terminal.read', description: 'Read.', inputSchema: {} },
    ];
    export const shape = ({ name, description, inputSchema }) => ({ name, description, inputSchema });
  `,
};

describe('today route extractor', () => {
  let root = '';
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'extract-today-'));
    for (const [path, text] of Object.entries(FILES)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    }
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const result = () => extract(root, 'testsha');
  const row = (table: string, key: string) => result().fixture.rows.find(r => r.table === table && r.key === key);

  test('a route resolves spreads, imported constants and template paths', () => {
    expect(row('route', 'GET /v1/things/:thingId')).toEqual({
      table: 'route',
      key: 'GET /v1/things/:thingId',
      minimum: 'operator',
      caller: 'any',
      capability: { capability: 'fleet', axis: 'use' },
      noStore: true,
      from: 'packages/daemon/src/lib/runtime/mounts/things.ts:8',
    });
  });

  test('flags, a narrowing capability, a free-text door and an available fn are kept as presence', () => {
    expect(row('route', 'POST /v1/things')).toMatchObject({
      minimum: 'admin-token',
      caller: 'person',
      privilegedOnly: true,
      capability: { capability: 'fleet', axis: 'use', narrowing: true },
      ferretDoor: true,
      available: true,
    });
  });

  test('a socket is a route with accept; a member route has needs and no minimum', () => {
    expect(row('socket', 'GET /v1/things/:thingId/stream')).toMatchObject({ minimum: 'operator', caller: 'any' });
    expect(row('member', 'GET /v1/shared/me')).toEqual({
      table: 'member',
      key: 'GET /v1/shared/me',
      member: 'unlocked',
      from: 'packages/daemon/src/lib/catalog-members/shared-routes.ts:2',
    });
  });

  test('a tool is keyed by its MCP name and carries its wire name; a re-shaping object is not a tool', () => {
    const tools = result().fixture.rows.filter(r => r.table === 'tool');
    expect(tools).toEqual([
      { table: 'tool', key: 'terminal_read', wire: 'terminal.read', from: 'packages/cli/src/lib/mcp/tools.ts:3' },
    ]);
  });

  test('a comment is not a route, a method+path object with no minimum is skipped, and an unreadable path is loud', () => {
    const { fixture, unresolved, skipped } = result();
    expect(fixture.rows.some(r => r.key.includes('in-a-comment'))).toBe(false);
    expect(fixture.rows.some(r => r.key.includes('/v1/audited'))).toBe(false);
    expect(skipped).toEqual(['packages/daemon/src/lib/runtime/mounts/things.ts:12']);
    expect(row('route', 'GET unresolved:makePath()')).toBeDefined();
    expect(unresolved).toHaveLength(1);
    expect(unresolved[0]).toContain('makePath()');
  });

  test('rows are sorted by table then key and the source is recorded', () => {
    const { fixture } = result();
    expect(fixture.format).toBe(1);
    expect(fixture.source).toBe('testsha');
    const order = fixture.rows.map(r => `${r.table} ${r.key}`);
    expect(order).toEqual([...order].sort());
  });
});
