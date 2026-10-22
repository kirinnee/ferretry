import { describe, expect, it } from 'bun:test';
import { TUNNEL_OFF_SENTENCE, TUNNEL_PATH, type TunnelStatusView } from '@ferretry/protocol';
import { FyHttpError, FyTransportError } from '@ferretry/protocol/client';
import { Command } from 'commander';
import { registerTunnelCommands } from '../../../src/lib/tunnel/commands';
import { TunnelController } from '../../../src/lib/tunnel/controller';
import { ProtocolTunnelGateway, ProtocolTunnelStatusReader } from '../../../src/lib/tunnel/gateway';
import type { ITunnelGateway, ITunnelOutput } from '../../../src/lib/tunnel/ports';
import { renderTunnelChange } from '../../../src/lib/tunnel/render';

const OFF: TunnelStatusView = {
  enabled: false,
  explicit: false,
  state: 'off',
  tunnelUrl: null,
  sentence: TUNNEL_OFF_SENTENCE,
};

const PROVISIONING: TunnelStatusView = {
  enabled: true,
  explicit: true,
  state: 'provisioning',
  tunnelUrl: null,
  sentence: 'Tunnel: on — asking the hosted service for a tunnel',
};

class RecordingOutput implements ITunnelOutput {
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

/** A gateway that answers from a flag, or throws what a test hands it. */
class FakeGateway implements ITunnelGateway {
  readonly changes: boolean[] = [];

  constructor(private readonly failure?: Error) {}

  async read(): Promise<TunnelStatusView> {
    if (this.failure !== undefined) throw this.failure;
    return OFF;
  }

  async change(enabled: boolean): Promise<TunnelStatusView> {
    if (this.failure !== undefined) throw this.failure;
    this.changes.push(enabled);
    return enabled ? PROVISIONING : { ...OFF, explicit: true };
  }
}

const controller = (gateway: ITunnelGateway) => {
  const out = new RecordingOutput();
  return { out, instance: new TunnelController({ gateway, out, clientName: 'fy' }) };
};

const DOWN = new FyTransportError('could not reach fyd at http://daemon.test', TUNNEL_PATH, false, {});
const OLDER = new FyHttpError('not found', 404, 'not_found');

describe('switching the tunnel', () => {
  it('should switch on through the daemon and say it applied without a restart', async () => {
    // Arrange
    const gateway = new FakeGateway();
    const { instance, out } = controller(gateway);

    // Act
    await instance.on();

    // Assert
    expect(gateway.changes).toEqual([true]);
    expect(out.messages).toEqual(['Tunnel: on — asking the hosted service for a tunnel\nApplied without a restart.']);
    expect(out.exitCode).toBeUndefined();
  });

  it('should switch off through the daemon', async () => {
    // Arrange
    const gateway = new FakeGateway();
    const { instance, out } = controller(gateway);

    // Act
    await instance.off();

    // Assert
    expect(gateway.changes).toEqual([false]);
    expect(out.messages).toEqual([renderTunnelChange({ ...OFF, explicit: true })]);
  });

  it('should refuse when the daemon is not running, naming the remedy and changing nothing', async () => {
    // Arrange
    const { instance, out } = controller(new FakeGateway(DOWN));

    // Act
    await instance.on();

    // Assert
    expect(out.errors).toEqual([
      'The daemon is not running, so nothing was changed — start it with `fy daemon start`, then run `fy daemon tunnel on` again.',
    ]);
    expect(out.exitCode).toBe(1);
  });

  it('should tell an owner whose daemon predates the switch to restart it', async () => {
    // Arrange
    const { instance, out } = controller(new FakeGateway(OLDER));

    // Act
    await instance.off();

    // Assert
    expect(out.errors).toEqual([
      'The running daemon is older than the tunnel switch — restart it on the installed version with `fy daemon restart`, then run this again.',
    ]);
    expect(out.exitCode).toBe(1);
  });

  it('should let any other refusal through untouched', async () => {
    // Arrange
    const refused = new FyHttpError('the configuration document could not be written', 500, 'internal');
    const { instance } = controller(new FakeGateway(refused));

    // Act + Assert
    await expect(instance.on()).rejects.toBe(refused);
  });
});

describe('the tunnel status', () => {
  it('should print the daemon’s sentence, or the protocol document with --json', async () => {
    // Arrange
    const { instance, out } = controller(new FakeGateway());

    // Act
    await instance.status({});
    await instance.status({ json: true });

    // Assert
    expect(out.messages).toEqual([TUNNEL_OFF_SENTENCE, JSON.stringify(OFF)]);
  });

  it('should say the daemon is not running and exit non-zero', async () => {
    // Arrange
    const { instance, out } = controller(new FakeGateway(DOWN));

    // Act
    await instance.status({});

    // Assert
    expect(out.errors[0]).toContain('`fy daemon start`');
    expect(out.errors[0]).toContain('`fy daemon tunnel status`');
    expect(out.exitCode).toBe(1);
  });
});

describe('the tunnel commands', () => {
  const mounted = (gateway: ITunnelGateway) => {
    const program = new Command();
    program.command('daemon').description('manage the daemon');
    const { instance, out } = controller(gateway);
    registerTunnelCommands(program, () => instance);
    return { program, out };
  };

  it('should refuse to mount before the daemon group exists', () => {
    // Act + Assert
    expect(() => registerTunnelCommands(new Command(), () => controller(new FakeGateway()).instance)).toThrow(
      'daemon command group must be registered',
    );
  });

  it('should show the status by default and switch with on and off', async () => {
    // Arrange
    const gateway = new FakeGateway();
    const { program, out } = mounted(gateway);

    // Act
    await program.parseAsync(['daemon', 'tunnel'], { from: 'user' });
    await program.parseAsync(['daemon', 'tunnel', 'status', '--json'], { from: 'user' });
    await program.parseAsync(['daemon', 'tunnel', 'on'], { from: 'user' });
    await program.parseAsync(['daemon', 'tunnel', 'off'], { from: 'user' });

    // Assert
    expect(out.messages[0]).toBe(TUNNEL_OFF_SENTENCE);
    expect(JSON.parse(out.messages[1] ?? '{}')).toEqual(OFF);
    expect(gateway.changes).toEqual([true, false]);
  });
});

describe('the gateway', () => {
  const recording = (answer: unknown) => {
    const calls: { path: string; init: RequestInit | undefined; timeout: number | undefined }[] = [];
    const client = {
      request: async (path: string, _schema: unknown, init?: RequestInit, timeout?: number) => {
        calls.push({ path, init, timeout });
        return answer;
      },
    };
    return { calls, client: client as never };
  };

  it('should read and PUT the tunnel path', async () => {
    // Arrange
    const { calls, client } = recording(OFF);
    const gateway = new ProtocolTunnelGateway(client);

    // Act
    await gateway.read();
    await gateway.change(true);

    // Assert
    expect(calls[0]).toEqual({ path: '/v1/tunnel', init: undefined, timeout: undefined });
    expect(calls[1]?.path).toBe('/v1/tunnel');
    expect(calls[1]?.init?.method).toBe('PUT');
    expect(calls[1]?.init?.body).toBe(JSON.stringify({ enabled: true }));
  });

  it('should read the status line with a short timeout, and answer nothing when the read fails', async () => {
    // Arrange
    const { calls, client } = recording(OFF);
    const failing = {
      request: async () => {
        throw OLDER;
      },
    };

    // Act
    const read = await new ProtocolTunnelStatusReader(client).read();
    const missing = await new ProtocolTunnelStatusReader(failing as never).read();

    // Assert
    expect(read).toEqual(OFF);
    expect(calls[0]?.timeout).toBe(3_000);
    expect(missing).toBeUndefined();
  });
});
