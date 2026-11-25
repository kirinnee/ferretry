import { describe, it } from 'bun:test';
import type { IFyHttpTransport } from '@ferretry/protocol';
import { Command } from 'commander';
import should from 'should';
import { mcpTokenController } from '../../../bin/mcp-group.ts';
import { type ConnectionWorld, createProgram, wireDaemon } from '../../../bin/wiring.ts';
import type { ICliIo } from '../../../src/adapters/terminal/console-io.ts';
import { registerMcpCommands } from '../../../src/lib/mcp/commands.ts';

/**
 * `fy mcp token` presents the ferret's own session credential and nothing else. The daemon route refuses the
 * admin token, so a ferret whose environment also carries `FY_TOKEN` must still send its own credential, and
 * one that has no session credential must stop before it sends anything.
 */
const VARIABLE = 'FY_MCP_SLACK_0123456789ABCDEF_TOKEN';
const SESSION_CREDENTIAL = 'fys_own-session-credential';
const ADMIN_TOKEN = 'admin-token-from-the-shell';

class RecordingIo implements ICliIo {
  readonly stdout: string[] = [];
  readonly stderr: string[] = [];
  exitCode: number | undefined;
  success(): void {}
  report(message: string): void {
    this.stdout.push(message);
  }
  warn(): void {}
  error(message: string): void {
    this.stderr.push(message);
  }
  diagnostic(message: string): void {
    this.stderr.push(message);
  }
  setExitCode(code: number): void {
    this.exitCode = code;
  }
  interactive(): boolean {
    return false;
  }
}

async function run(environment: Record<string, string>) {
  const io = new RecordingIo();
  const sent: { url: string; authorization: string | null }[] = [];
  const transport: IFyHttpTransport = {
    send: async (url, init) => {
      sent.push({ url, authorization: new Headers(init.headers).get('authorization') });
      return Response.json({ variable: VARIABLE, headers: { Authorization: 'Bearer fresh' } });
    },
  };
  const world: ConnectionWorld = {
    io,
    cwd: '/work',
    homeDirectory: '/home/tester',
    environment: { FY_URL: 'http://127.0.0.1:7456', FY_SESSION_ID: 's-own', ...environment },
  };
  const program = createProgram().exitOverride();
  const controller = mcpTokenController(world, wireDaemon(program, world), {
    transport,
    listeners: { tables: async () => undefined, uid: () => undefined },
  });
  registerMcpCommands(program as Command, async () => {}, {} as never, controller);
  await program.parseAsync(['node', 'fy', 'mcp', 'token', VARIABLE]);
  return { io, sent };
}

describe('fy mcp token credential', () => {
  it('should send the ferret’s session credential, not FY_TOKEN, when both are in the environment', async () => {
    // Arrange / Act
    const { io, sent } = await run({ FY_TOKEN: ADMIN_TOKEN, FY_SESSION_TOKEN: SESSION_CREDENTIAL });

    // Assert
    should(sent).have.length(1);
    should(sent[0]?.url).equal('http://127.0.0.1:7456/v1/sessions/s-own/mcp/token');
    should(sent[0]?.authorization).equal(`Bearer ${SESSION_CREDENTIAL}`);
    should(io.stdout).deepEqual(['{"Authorization":"Bearer fresh"}']);
    should(io.exitCode).be.undefined();
  });

  it('should exit 2 with a plain sentence and send nothing when only FY_TOKEN is set', async () => {
    // Arrange / Act
    const { io, sent } = await run({ FY_TOKEN: ADMIN_TOKEN });

    // Assert
    should(sent).deepEqual([]);
    should(io.stdout).deepEqual([]);
    should(io.stderr[0]).match(/needs this ferret’s own session credential/u);
    should(io.exitCode).equal(2);
  });

  it('should not send a credential from before the fys_ prefix as a bearer', async () => {
    // Arrange / Act
    const { io, sent } = await run({ FY_TOKEN: ADMIN_TOKEN, FY_SESSION_TOKEN: 'legacy-unprefixed' });

    // Assert
    should(sent).deepEqual([]);
    should(io.exitCode).equal(2);
  });
});
