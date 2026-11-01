import { afterEach, beforeEach, describe, it } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DAEMON_FEATURES } from '@ferretry/protocol';
import should from 'should';
import { InProcessCliDriver } from '../../sit/driver.ts';

/**
 * RF-3 through the composition root: the command groups and the MCP server a harness starts present the
 * ferret's own credential, and `--as-owner` takes the admin token back. The token file is left
 * WORLD-READABLE on purpose — `readDaemonToken` refuses such a file at its first `stat`, so any path that
 * so much as looked at it fails the command loudly instead of quietly sending the admin token.
 */

const FY_ENTRY = resolve(import.meta.dir, '../../../bin/fy.ts');
const BEARER = 'fys_wiringWIRINGwiringWIRINGwiringWIRINGwiri';
const ADMIN = 'admin-token-from-the-state-home';

describe("a ferret's fy and MCP server, wired as they ship", () => {
  let root = '';
  let seen: { path: string; authorization: string }[] = [];
  let features: string[] = [];
  let server: ReturnType<typeof Bun.serve> | undefined;
  let url = '';

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'fy-rf3-wiring-'));
    seen = [];
    features = [DAEMON_FEATURES.sessionCredential];
    server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: request => {
        const path = new URL(request.url).pathname;
        if (path === '/v1/health') return Response.json({ ok: true, pid: 7, features });
        seen.push({ path, authorization: request.headers.get('authorization') ?? '' });
        return Response.json({ error: 'a ferret may not do this', code: 'owner_only' }, { status: 403 });
      },
    });
    url = `http://127.0.0.1:${String(server.port)}`;
  });

  afterEach(async () => {
    await server?.stop(true);
    await rm(root, { recursive: true, force: true });
  });

  const tokenFile = async (mode: number): Promise<void> => {
    await writeFile(join(root, 'api-token'), `${ADMIN}\n`, { mode });
  };

  it('should present the bearer from a command, report the refusal, and never look at api-token', async () => {
    // Arrange
    await tokenFile(0o644);

    // Act — no FY_SESSION_ID: the pane's credential alone decides.
    const result = await new InProcessCliDriver().run(['search', 'anything'], {
      FY_HOME: root,
      FY_URL: url,
      FY_SESSION_TOKEN: BEARER,
    });

    // Assert
    should(result.code).not.equal(0);
    should(result.err).match(/a ferret may not do this/u);
    should(result.err).not.match(/owner-only|api-token/u);
    should(seen.map(each => each.authorization)).deepEqual([`Bearer ${BEARER}`]);
  });

  it('should take the admin token for --as-owner', async () => {
    // Arrange
    await tokenFile(0o600);

    // Act
    await new InProcessCliDriver().run(['--as-owner', 'search', 'anything'], {
      FY_HOME: root,
      FY_URL: url,
      FY_SESSION_TOKEN: BEARER,
    });

    // Assert
    should(seen.map(each => each.authorization)).deepEqual([`Bearer ${ADMIN}`]);
  });

  it('should present the bearer from the MCP server too', async () => {
    // Arrange — `fy mcp serve` as a harness starts it: the pane's environment, FY_TOKEN blanked.
    await tokenFile(0o644);
    const mcp = Bun.spawn({
      cmd: [process.execPath, FY_ENTRY, 'mcp', 'serve'],
      env: {
        PATH: process.env.PATH ?? '',
        HOME: root,
        FY_HOME: root,
        FY_URL: url,
        FY_TOKEN: '',
        FY_SESSION_TOKEN: BEARER,
      },
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const answer = (async () => {
      let text = '';
      for await (const chunk of mcp.stdout) {
        text += new TextDecoder().decode(chunk);
        if (text.includes('"id":2')) return text;
      }
      return text;
    })();

    // Act
    const rpc = (message: unknown): void => {
      mcp.stdin.write(`${JSON.stringify(message)}\n`);
      mcp.stdin.flush();
    };
    rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {} } });
    rpc({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'search_work', arguments: { query: 'anything' } },
    });
    const said = await answer;
    mcp.kill();

    // Assert
    should(said).match(/a ferret may not do this/u);
    should(said).not.match(/owner-only/u);
    should(seen.map(each => each.authorization)).deepEqual([`Bearer ${BEARER}`]);
  }, 30_000);
});
