import { describe, it } from 'bun:test';
import type { McpTokenAnswer } from '@ferretry/protocol';
import { FyHttpError } from '@ferretry/protocol/client';
import { Command } from 'commander';
import should from 'should';
import { registerMcpCommands } from '../../../src/lib/mcp/commands';
import {
  type IMcpTokenGateway,
  type IMcpTokenOutput,
  McpTokenController,
  ProtocolMcpTokenGateway,
} from '../../../src/lib/mcp/token';

const VARIABLE = 'FY_MCP_SLACK_0123456789ABCDEF_TOKEN';
const ANSWER: McpTokenAnswer = { variable: VARIABLE, headers: { Authorization: 'Bearer fresh-token' } };

class FakeGateway implements IMcpTokenGateway {
  readonly asked: [string, string][] = [];
  constructor(private readonly outcome: McpTokenAnswer | Error = ANSWER) {}

  async token(sessionId: string, variable: string): Promise<McpTokenAnswer> {
    this.asked.push([sessionId, variable]);
    if (this.outcome instanceof Error) throw this.outcome;
    return this.outcome;
  }
}

class RecordingOutput implements IMcpTokenOutput {
  readonly stdout: string[] = [];
  readonly stderr: string[] = [];
  exitCode: number | undefined;
  report(message: string): void {
    this.stdout.push(message);
  }
  diagnostic(message: string): void {
    this.stderr.push(message);
  }
  setExitCode(code: number): void {
    this.exitCode = code;
  }
}

function cli(gateway: IMcpTokenGateway, own: string | null = 's-own') {
  const out = new RecordingOutput();
  const program = new Command().exitOverride().configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerMcpCommands(
    program,
    async () => {},
    {} as never,
    new McpTokenController(gateway, out, own ?? undefined, true),
  );
  const run = async (...argv: string[]) => await program.parseAsync(['node', 'fy', 'mcp', ...argv]);
  return { out, run, program };
}

describe('fy mcp token', () => {
  it('should print exactly the headers object, as this ferret, and nothing else', async () => {
    // Arrange
    const gateway = new FakeGateway();
    const { out, run } = cli(gateway);

    // Act
    await run('token', VARIABLE);

    // Assert — one stdout line that parses to the headers; nothing on stderr; exit untouched.
    should(gateway.asked).deepEqual([['s-own', VARIABLE]]);
    should(out.stdout).deepEqual(['{"Authorization":"Bearer fresh-token"}']);
    should(JSON.parse(out.stdout[0] ?? '')).deepEqual({ Authorization: 'Bearer fresh-token' });
    should(out.stderr).deepEqual([]);
    should(out.exitCode).be.undefined();
  });

  it('should refuse with exit 2 outside a ferret, and never ask the daemon', async () => {
    // Arrange
    const gateway = new FakeGateway();
    const { out, run } = cli(gateway, null);

    // Act
    await run('token', VARIABLE);

    // Assert
    should(gateway.asked).deepEqual([]);
    should(out.stdout).deepEqual([]);
    should(out.stderr[0]).match(/only works inside a ferret/u);
    should(out.exitCode).equal(2);
  });

  it('should refuse with exit 2, never asking the daemon, when the ferret has no session credential', async () => {
    // Arrange
    const gateway = new FakeGateway();
    const out = new RecordingOutput();
    const program = new Command().exitOverride().configureOutput({ writeOut: () => {}, writeErr: () => {} });
    registerMcpCommands(program, async () => {}, {} as never, new McpTokenController(gateway, out, 's-own', false));

    // Act
    await program.parseAsync(['node', 'fy', 'mcp', 'token', VARIABLE]);

    // Assert
    should(gateway.asked).deepEqual([]);
    should(out.stdout).deepEqual([]);
    should(out.stderr[0]).match(/needs this ferret’s own session credential/u);
    should(out.exitCode).equal(2);
  });

  it('should refuse a name that is not a sign-in variable with exit 2', async () => {
    // Arrange
    const gateway = new FakeGateway();
    const { out, run } = cli(gateway);

    // Act
    await run('token', 'PATH');

    // Assert
    should(gateway.asked).deepEqual([]);
    should(out.stdout).deepEqual([]);
    should(out.exitCode).equal(2);
  });

  it('should print the daemon’s own sentence to stderr and exit 1 when it refuses', async () => {
    // Arrange
    const sentence = 'The sign-in to “slack” can no longer be renewed. Ask the owner to sign in again.';
    const { out, run } = cli(new FakeGateway(new FyHttpError(sentence, 409, 'mcp_needs_sign_in')));

    // Act
    await run('token', VARIABLE);

    // Assert — nothing on stdout, which Claude would parse as headers.
    should(out.stdout).deepEqual([]);
    should(out.stderr).deepEqual([sentence]);
    should(out.exitCode).equal(1);
  });

  it('should say it could not reach the daemon, exit 1, for any other failure', async () => {
    // Arrange
    const { out, run } = cli(new FakeGateway(new Error('connection refused')));

    // Act
    await run('token', VARIABLE);

    // Assert
    should(out.stdout).deepEqual([]);
    should(out.stderr).deepEqual(['could not reach the daemon: connection refused']);
    should(out.exitCode).equal(1);
  });

  it('should be described as the headersHelper', () => {
    // Arrange
    const { program } = cli(new FakeGateway());

    // Act
    const description = program.commands.find(c => c.name() === 'mcp')?.commands.find(c => c.name() === 'token');

    // Assert
    should(description?.description()).equal(
      "print fresh MCP sign-in headers for this ferret (Claude's headersHelper runs this)",
    );
  });
});

describe('ProtocolMcpTokenGateway', () => {
  it('should POST the variable to this session’s token route and parse the answer', async () => {
    // Arrange
    const calls: { path: string; init: { method?: string; body?: string } | undefined }[] = [];
    const gateway = new ProtocolMcpTokenGateway({
      request: (async (path: string, schema: { parse(value: unknown): unknown }, init?: unknown) => {
        calls.push({ path, init: init as { method?: string; body?: string } });
        return schema.parse(ANSWER);
      }) as never,
    });

    // Act
    const answer = await gateway.token('s/1', VARIABLE);

    // Assert
    should(answer).deepEqual(ANSWER);
    should(calls[0]?.path).equal('/v1/sessions/s%2F1/mcp/token');
    should(calls[0]?.init?.method).equal('POST');
    should(JSON.parse(calls[0]?.init?.body ?? '')).deepEqual({ variable: VARIABLE });
  });
});
