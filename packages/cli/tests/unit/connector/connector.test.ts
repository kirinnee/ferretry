import { describe, expect, it } from 'bun:test';
import type { ConnectorGrantView, ConnectorPendingView, ConnectorStatus } from '@ferretry/protocol';
import { FyHttpError, FyTransportError } from '@ferretry/protocol/client';
import { Command } from 'commander';
import { registerConnectorCommands } from '../../../src/lib/connector/commands';
import { ConnectorController } from '../../../src/lib/connector/controller';
import { CONNECTOR_PATH, ProtocolConnectorGateway } from '../../../src/lib/connector/gateway';
import type { IConnectorGateway, IConnectorOutput } from '../../../src/lib/connector/ports';
import { expiresIn, renderStatus } from '../../../src/lib/connector/render';

const NOW = Date.parse('2026-11-24T10:00:00.000Z');
const PENDING: ConnectorPendingView = {
  id: 'cr_k7q2mfabcd',
  matchCode: 'K7Q-2MF',
  clientName: 'Claude',
  redirectHost: 'claude.ai',
  scopes: ['fleet:read', 'fleet:write'],
  createdAt: '2026-11-24T09:59:00.000Z',
  expiresAt: '2026-11-24T10:09:00.000Z',
};
const GRANT: ConnectorGrantView = {
  id: 'cg_k7q2mfabcd',
  clientName: 'Claude',
  redirectHost: 'claude.ai',
  scopes: ['fleet:read', 'fleet:write'],
  createdAt: '2026-11-24T09:00:00.000Z',
  approvedBy: 'admin-cli',
};
const ON: ConnectorStatus = {
  enabled: true,
  publicUrl: 'https://mcp.example.test',
  mcpUrl: 'https://mcp.example.test/mcp',
  pending: [PENDING],
  grants: [GRANT],
};
const OFF: ConnectorStatus = {
  enabled: false,
  disabledReason: 'The connector is off. Set connector.enabled in config/daemon.json on this machine.',
  pending: [],
  grants: [],
};

class RecordingOutput implements IConnectorOutput {
  readonly messages: string[] = [];
  readonly errors: string[] = [];
  exitCode: number | undefined;
  success(message: string): void {
    this.messages.push(message);
  }
  error(message: string): void {
    this.errors.push(message);
  }
  setExitCode(code: number): void {
    this.exitCode = code;
  }
}

class FakeGateway implements IConnectorGateway {
  readonly calls: string[] = [];
  /** What every call fails with, if anything. */
  failure: unknown;
  constructor(private readonly current: ConnectorStatus = ON) {}
  async status() {
    return this.#answer('status', this.current);
  }
  async approve(idOrMatchCode: string) {
    return this.#answer(`approve ${idOrMatchCode}`, GRANT);
  }
  async deny(idOrMatchCode: string) {
    return this.#answer(`deny ${idOrMatchCode}`, PENDING);
  }
  async revoke(grantId: string) {
    return this.#answer(`revoke ${grantId}`, { ...GRANT, revokedAt: '2026-11-24T10:00:00.000Z' });
  }
  #answer<T>(call: string, value: T): T {
    this.calls.push(call);
    if (this.failure !== undefined) throw this.failure;
    return value;
  }
}

const controller = (gateway: IConnectorGateway) => {
  const out = new RecordingOutput();
  return { out, instance: new ConnectorController({ gateway, out, now: () => NOW, clientName: 'fy' }) };
};

describe('the connector report', () => {
  it('should say it is on, give the MCP URL, and show a waiting sign-in by its match code', () => {
    // Act
    const rendered = renderStatus(ON, 'fy', NOW);

    // Assert
    expect(rendered).toContain('The Claude connector is on.');
    expect(rendered).toContain('MCP URL: https://mcp.example.test/mcp');
    expect(rendered).toContain('K7Q-2MF');
    expect(rendered).toContain('expires in 9 min');
    expect(rendered).toContain('`fy connector approve <code>`');
    expect(rendered).toContain('cg_k7q2mfabcd');
    expect(rendered).toContain('`fy connector revoke <id>`');
  });

  it('should say why it is off, in the daemon’s words, and nothing else', () => {
    // Act + Assert
    expect(renderStatus(OFF, 'fy', NOW)).toBe(`The Claude connector is off.\n${OFF.disabledReason ?? ''}`);
  });

  it('should say when nothing is waiting and nobody is approved', () => {
    // Act
    const rendered = renderStatus({ ...ON, pending: [], grants: [] }, 'fy', NOW);

    // Assert
    expect(rendered).toContain('No sign-in is waiting.');
    expect(rendered).toContain('No client has been approved yet.');
  });

  it('should mark a revoked grant, and quote a hostile client name so it cannot forge a line or move the cursor', () => {
    // Arrange
    const hostile = { ...GRANT, clientName: 'x\n  K7Q-2MF  "Claude" \u001b[2J', revokedAt: '2026-11-24T09:30:00.000Z' };

    // Act
    const rendered = renderStatus({ ...ON, grants: [hostile] }, 'fy', NOW);

    // Assert — the newline and the escape are dropped, and the quote is escaped, so the name stays one quoted token.
    expect(rendered).toContain('(revoked)');
    expect(rendered).toContain('(0 live)');
    expect(rendered).not.toContain('\u001b');
    expect(rendered).toContain('"x  K7Q-2MF  \\"Claude\\" [2J"');
  });

  it('should say how long a sign-in has left, in the unit a person reads', () => {
    // Act + Assert
    expect(expiresIn('2026-11-24T10:00:40.000Z', NOW)).toBe('in 40 s');
    expect(expiresIn('2026-11-24T10:09:00.000Z', NOW)).toBe('in 9 min');
    expect(expiresIn('2026-11-24T09:59:00.000Z', NOW)).toBe('expired');
  });
});

describe('fy connector', () => {
  it('should print the report, or the protocol document with --json', async () => {
    // Arrange
    const { instance, out } = controller(new FakeGateway());

    // Act
    await instance.status({});
    await instance.status({ json: true });

    // Assert
    expect(out.messages[0]).toContain('MCP URL');
    expect(JSON.parse(out.messages[1] ?? '{}')).toEqual(ON);
  });

  it('should approve by what was typed, and say what the client may now do and how to take it back', async () => {
    // Arrange
    const gateway = new FakeGateway();
    const { instance, out } = controller(gateway);

    // Act
    await instance.approve('k7q2mf', {});
    await instance.approve('K7Q-2MF', { json: true });

    // Assert
    expect(gateway.calls).toEqual(['approve k7q2mf', 'approve K7Q-2MF']);
    expect(out.messages[0]).toBe(
      'Approved "Claude" (cg_k7q2mfabcd). It can read and drive your ferrets until you revoke it with `fy connector revoke cg_k7q2mfabcd`.',
    );
    expect(JSON.parse(out.messages[1] ?? '{}')).toEqual(GRANT);
    expect(out.exitCode).toBeUndefined();
  });

  it('should deny and revoke, each in one sentence', async () => {
    // Arrange
    const gateway = new FakeGateway();
    const { instance, out } = controller(gateway);

    // Act
    await instance.deny(PENDING.id, {});
    await instance.revoke(GRANT.id, {});

    // Assert
    expect(gateway.calls).toEqual([`deny ${PENDING.id}`, `revoke ${GRANT.id}`]);
    expect(out.messages).toEqual([
      'Denied "Claude". Nothing was signed in.',
      'Revoked "Claude" (cg_k7q2mfabcd). It is refused on its very next call.',
    ]);
  });

  it('should print the daemon’s own sentence and exit 1 for a refusal it understands', async () => {
    // Arrange
    for (const status of [404, 409, 410]) {
      const gateway = new FakeGateway();
      gateway.failure = new FyHttpError(
        'That sign-in ran out; start it again from Claude.',
        status,
        'connector_expired',
      );
      const { instance, out } = controller(gateway);

      // Act
      await instance.approve('K7Q-2MF', {});

      // Assert
      expect(out.errors).toEqual(['That sign-in ran out; start it again from Claude.']);
      expect(out.exitCode).toBe(1);
      expect(out.messages).toEqual([]);
    }
  });

  it('should say the daemon did not answer, and what to run, when it cannot be reached', async () => {
    // Arrange
    const gateway = new FakeGateway();
    gateway.failure = new FyTransportError('connection refused', CONNECTOR_PATH, false, undefined);
    const { instance, out } = controller(gateway);

    // Act
    await instance.revoke(GRANT.id, {});

    // Assert
    expect(out.errors[0]).toContain('did not answer');
    expect(out.errors[0]).toContain('`fy daemon start`');
    expect(out.exitCode).toBe(1);
  });

  it('should rethrow what it does not recognise, for the composition root to print', async () => {
    // Arrange
    const gateway = new FakeGateway();
    gateway.failure = new FyHttpError('boom', 500, undefined);
    const { instance } = controller(gateway);

    // Act + Assert
    await expect(instance.status({})).rejects.toThrow('boom');
  });
});

describe('the connector commands', () => {
  async function run(args: readonly string[]) {
    const gateway = new FakeGateway();
    const { instance, out } = controller(gateway);
    const program = new Command('fy').exitOverride();
    registerConnectorCommands(program, () => instance);
    await program.parseAsync(['node', 'fy', ...args]);
    return { gateway, out };
  }

  it('should make the status the default, so a bare `fy connector` answers what is on', async () => {
    // Act
    const { gateway } = await run(['connector']);

    // Assert
    expect(gateway.calls).toEqual(['status']);
  });

  it('should route each verb, with --json, to its controller method', async () => {
    // Act
    const approved = await run(['connector', 'approve', 'K7Q-2MF', '--json']);
    const denied = await run(['connector', 'deny', 'K7Q-2MF']);
    const revoked = await run(['connector', 'revoke', 'cg_k7q2mfabcd']);
    const listed = await run(['connector', 'status', '--json']);

    // Assert
    expect(approved.gateway.calls).toEqual(['approve K7Q-2MF']);
    expect(JSON.parse(approved.out.messages[0] ?? '{}')).toEqual(GRANT);
    expect(denied.gateway.calls).toEqual(['deny K7Q-2MF']);
    expect(revoked.gateway.calls).toEqual(['revoke cg_k7q2mfabcd']);
    expect(JSON.parse(listed.out.messages[0] ?? '{}')).toEqual(ON);
  });
});

describe('the connector gateway', () => {
  function recording(answer: unknown) {
    const seen: { path: string; init: RequestInit | undefined }[] = [];
    const client = {
      request: async (path: string, _schema: unknown, init?: RequestInit) => {
        seen.push({ path, init });
        return answer;
      },
    };
    return { seen, gateway: new ProtocolConnectorGateway(client as never) };
  }

  it('should read the status with no request options at all', async () => {
    // Arrange
    const { seen, gateway } = recording(ON);

    // Act
    await gateway.status();

    // Assert
    expect(seen[0]?.path).toBe(CONNECTOR_PATH);
    expect(seen[0]?.init).toBeUndefined();
  });

  it('should send each act as a POST with an empty JSON body to the one request or grant, encoded', async () => {
    // Arrange
    const { seen, gateway } = recording(GRANT);

    // Act
    await gateway.approve('K7Q-2MF');
    await gateway.deny('a/b?c');
    await gateway.revoke('cg_k7q2mfabcd');

    // Assert
    expect(seen.map(call => call.path)).toEqual([
      '/v1/connector/requests/K7Q-2MF/approve',
      '/v1/connector/requests/a%2Fb%3Fc/deny',
      '/v1/connector/grants/cg_k7q2mfabcd/revoke',
    ]);
    for (const call of seen) {
      expect(call.init?.method).toBe('POST');
      expect(call.init?.body).toBe('{}');
      expect(Object.keys(call.init?.headers as Record<string, string>)).toEqual(['content-type']);
    }
  });
});
