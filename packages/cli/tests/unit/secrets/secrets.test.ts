import { describe, expect, it } from 'bun:test';
import { Command } from 'commander';
import {
  SECRET_SCHEMA_VERSION,
  type SecretList,
  type SecretSummary,
  type SecretUseRequest,
  type SecretUseResult,
} from '@ferretry/protocol';
import { registerSecretCommands } from '../../../src/lib/secrets/commands';
import { SECRET_USE_UNFINISHED_EXIT, SecretController } from '../../../src/lib/secrets/controller';
import { ProtocolSecretGateway, SECRETS_PATH } from '../../../src/lib/secrets/gateway';
import type { ISecretGateway, ISecretOutput, ISecretValueSource } from '../../../src/lib/secrets/ports';
import { SECRET_HONESTY, renderSecretList } from '../../../src/lib/secrets/render';

const AT = '2026-08-05T10:00:00.000Z';
const LATER = '2026-08-06T10:00:00.000Z';

class RecordingOutput implements ISecretOutput {
  readonly messages: string[] = [];
  readonly errors: string[] = [];
  readonly streams: [string, string][] = [];
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

  raw(stream: 'stdout' | 'stderr', text: string): void {
    this.streams.push([stream, text]);
  }
}

class FakeGateway implements ISecretGateway {
  used: SecretUseRequest | undefined;
  stored: [string, string] | undefined;
  removed: string | undefined;

  constructor(
    private readonly listing: SecretList = {
      v: SECRET_SCHEMA_VERSION,
      health: 'ready',
      secrets: [],
      references: [],
    },
    private readonly result: SecretUseResult = {
      outcome: 'exited',
      exitCode: 0,
      stdout: '',
      stderr: '',
      truncated: false,
      used: [],
    },
  ) {}

  async list(): Promise<SecretList> {
    return this.listing;
  }

  async put(name: string, value: string): Promise<SecretSummary> {
    this.stored = [name, value];
    return { name, createdAt: AT, updatedAt: AT };
  }

  async remove(name: string): Promise<void> {
    this.removed = name;
  }

  async use(request: SecretUseRequest): Promise<SecretUseResult> {
    this.used = request;
    return this.result;
  }
}

const valueSource = (value: string): ISecretValueSource => ({ read: async () => value });

function controller(gateway: ISecretGateway, out: RecordingOutput, value = 'sk-live-0123456789'): SecretController {
  return new SecretController(gateway, out, valueSource(value), '/work/here');
}

describe('fy secret set', () => {
  it('should store a value read from stdin and echo only the name and the instant', async () => {
    // Arrange
    const gateway = new FakeGateway();
    const out = new RecordingOutput();

    // Act
    await controller(gateway, out).set('ANTHROPIC_KEY');

    // Assert
    expect(gateway.stored).toEqual(['ANTHROPIC_KEY', 'sk-live-0123456789']);
    expect(out.messages[0]).toContain('ANTHROPIC_KEY stored');
    expect(out.messages.join('\n')).not.toContain('sk-live-0123456789');
  });

  it('should refuse a name a shell could not export', async () => {
    await expect(controller(new FakeGateway(), new RecordingOutput()).set('not-a-name')).rejects.toThrow(/usable/u);
  });

  it('should refuse a value too short to mask safely, saying why', async () => {
    await expect(
      new SecretController(new FakeGateway(), new RecordingOutput(), valueSource('short'), '/work').set('TOKEN'),
    ).rejects.toThrow(/masked out of output/u);
  });
});

describe('fy secret use', () => {
  it('should send the NAME and never a value', async () => {
    // Arrange
    const gateway = new FakeGateway();

    // Act
    await controller(gateway, new RecordingOutput()).use(['curl', 'https://example.test'], { with: ['TOKEN'] });

    // Assert
    expect(gateway.used?.secrets).toEqual(['TOKEN']);
    expect(JSON.stringify(gateway.used)).not.toContain('sk-live');
  });

  it('should default the working directory to where the CLI was invoked', async () => {
    // Arrange
    const gateway = new FakeGateway();

    // Act
    await controller(gateway, new RecordingOutput()).use(['env'], {});

    // Assert
    expect(gateway.used?.cwd).toBe('/work/here');
  });

  it('should refuse when there is no working directory to run in', async () => {
    // Arrange / Act / Assert — the daemon's own state home is not a defensible guess.
    const bare = new SecretController(new FakeGateway(), new RecordingOutput(), valueSource('x'));
    await expect(bare.use(['env'], {})).rejects.toThrow(/working directory/u);
  });

  it('should refuse an empty command', async () => {
    await expect(controller(new FakeGateway(), new RecordingOutput()).use([], {})).rejects.toThrow(/nothing to run/u);
  });

  it('should relay the child streams verbatim and adopt its exit code', async () => {
    // Arrange
    const gateway = new FakeGateway(undefined, {
      outcome: 'exited',
      exitCode: 3,
      stdout: '{"ok":false}',
      stderr: 'a warning\n',
      truncated: false,
      used: ['TOKEN'],
    });
    const out = new RecordingOutput();

    // Act
    await controller(gateway, out).use(['curl'], { with: ['TOKEN'] });

    // Assert — a drop-in for the command it wraps.
    expect(out.streams).toEqual([
      ['stdout', '{"ok":false}'],
      ['stderr', 'a warning\n'],
    ]);
    expect(out.exitCode).toBe(3);
  });

  it('should distinguish a timeout from any status the program could have chosen', async () => {
    // Arrange
    const gateway = new FakeGateway(undefined, {
      outcome: 'timeout',
      stdout: '',
      stderr: '',
      truncated: true,
      used: [],
    });
    const out = new RecordingOutput();

    // Act
    await controller(gateway, out).use(['sleep', '99'], {});

    // Assert
    expect(out.exitCode).toBe(SECRET_USE_UNFINISHED_EXIT);
    expect(out.errors.join('\n')).toContain('did not finish');
  });

  it('should report a spawn failure as its own outcome', async () => {
    // Arrange
    const gateway = new FakeGateway(undefined, {
      outcome: 'spawn_failed',
      stdout: '',
      stderr: '',
      truncated: false,
      used: [],
    });
    const out = new RecordingOutput();

    // Act
    await controller(gateway, out).use(['/nope'], {});

    // Assert
    expect(out.exitCode).toBe(SECRET_USE_UNFINISHED_EXIT);
    expect(out.errors.join('\n')).toContain('could not be started');
  });

  it('should print the protocol result under --json instead of relaying', async () => {
    // Arrange
    const out = new RecordingOutput();

    // Act
    await controller(new FakeGateway(), out).use(['env'], { json: true });

    // Assert
    expect(out.streams).toEqual([]);
    expect(JSON.parse(out.messages[0] ?? '{}')).toHaveProperty('outcome', 'exited');
  });

  it('should refuse a timeout that is not a positive whole millisecond', async () => {
    await expect(
      controller(new FakeGateway(), new RecordingOutput()).use(['env'], { timeout: 'soon' }),
    ).rejects.toThrow(/--timeout/u);
  });
});

describe('fy secret rm', () => {
  it('should remove by name', async () => {
    // Arrange
    const gateway = new FakeGateway();
    const out = new RecordingOutput();

    // Act
    await controller(gateway, out).remove('TOKEN');

    // Assert
    expect(gateway.removed).toBe('TOKEN');
    expect(out.messages[0]).toContain('TOKEN removed');
  });
});

describe('the listing', () => {
  it('should show names, when each changed, and the honest sentence', () => {
    // Arrange / Act
    const text = renderSecretList({
      v: SECRET_SCHEMA_VERSION,
      health: 'ready',
      secrets: [
        { name: 'FRESH', createdAt: AT, updatedAt: AT },
        { name: 'ROTATED', createdAt: AT, updatedAt: LATER },
      ],
      references: [],
    });

    // Assert
    expect(text).toContain('FRESH  set');
    expect(text).toContain('ROTATED  changed');
    expect(text).toContain(SECRET_HONESTY);
  });

  it('should never contain a value, because the daemon never sends one', async () => {
    // Arrange
    const out = new RecordingOutput();

    // Act
    await controller(
      new FakeGateway({
        v: SECRET_SCHEMA_VERSION,
        health: 'ready',
        secrets: [{ name: 'TOKEN', createdAt: AT, updatedAt: AT }],
        references: [],
      }),
      out,
    ).list({});

    // Assert
    expect(out.messages[0]).toContain('TOKEN');
  });

  it('should say a damaged store is damaged and warn against writing over it', () => {
    // Arrange / Act
    const text = renderSecretList({
      v: SECRET_SCHEMA_VERSION,
      health: 'damaged',
      diagnosis: 'the vault key is gone',
      secrets: [],
      references: [],
    });

    // Assert — the failure mode this project has shipped three times.
    expect(text).toContain('It is NOT empty');
    expect(text).toContain('the vault key is gone');
  });

  it('should fall back to a stated absence when a damaged store gives no diagnosis', () => {
    expect(renderSecretList({ v: SECRET_SCHEMA_VERSION, health: 'damaged', secrets: [], references: [] })).toContain(
      'no diagnosis was given',
    );
  });

  it('should name an empty store as empty', () => {
    expect(renderSecretList({ v: SECRET_SCHEMA_VERSION, health: 'ready', secrets: [], references: [] })).toContain(
      'No secrets on this daemon',
    );
  });

  it('should call out a configured reference the store cannot resolve', () => {
    // Arrange / Act
    const text = renderSecretList({
      v: SECRET_SCHEMA_VERSION,
      health: 'ready',
      secrets: [{ name: 'HELD', createdAt: AT, updatedAt: AT }],
      references: [
        { name: 'HELD', origin: 'config/daemon.json → secretEnvironment.A', resolved: true },
        { name: 'ABSENT', origin: 'config/daemon.json → secretEnvironment.B', resolved: false },
      ],
    });

    // Assert — a resolved reference is not noise worth printing; a broken one is the whole point.
    expect(text).toContain('ABSENT  ← config/daemon.json → secretEnvironment.B');
    expect(text).not.toContain('HELD  ← ');
    expect(text).toContain('refused rather than run with a blank value');
  });

  it('should print the protocol document under --json', async () => {
    // Arrange
    const out = new RecordingOutput();

    // Act
    await controller(new FakeGateway(), out).list({ json: true });

    // Assert
    expect(JSON.parse(out.messages[0] ?? '{}')).toHaveProperty('health', 'ready');
  });
});

describe('the gateway', () => {
  it('should speak the four routes and parse every answer', async () => {
    // Arrange
    const calls: [string, string][] = [];
    const gateway = new ProtocolSecretGateway({
      request: async (path, schema, init) => {
        calls.push([String(init?.method ?? 'GET'), path]);
        if (path === SECRETS_PATH && init?.method === undefined)
          return schema.parse({ v: SECRET_SCHEMA_VERSION, health: 'ready', secrets: [], references: [] });
        if (path === SECRETS_PATH) return schema.parse({ name: 'TOKEN', createdAt: AT, updatedAt: AT });
        if (path.endsWith('/use'))
          return schema.parse({ outcome: 'exited', exitCode: 0, stdout: '', stderr: '', truncated: false, used: [] });
        return schema.parse({ name: 'TOKEN', removed: true });
      },
    });

    // Act
    await gateway.list();
    await gateway.put('TOKEN', 'sk-live-0123456789');
    await gateway.use({ command: ['env'], cwd: '/tmp' });
    await gateway.remove('TOKEN');

    // Assert
    expect(calls).toEqual([
      ['GET', '/v1/secrets'],
      ['POST', '/v1/secrets'],
      ['POST', '/v1/secrets/use'],
      ['DELETE', '/v1/secrets/TOKEN'],
    ]);
  });
});

describe('the command surface', () => {
  it('should offer no verb that prints a secret', () => {
    // Arrange
    const program = new Command();
    const out = new RecordingOutput();
    registerSecretCommands(program, controller(new FakeGateway(), out));

    // Act
    const secret = program.commands.find(command => command.name() === 'secret');
    const verbs = (secret?.commands ?? []).map(command => command.name()).sort();

    // Assert — `get`, `show`, `cat`, `reveal`: none of them, and none of them can be added, because
    // the daemon serves no route that could answer one.
    expect(verbs).toEqual(['ls', 'rm', 'set', 'use']);
  });

  it('should take NO value argument on set', () => {
    // Arrange
    const program = new Command();
    registerSecretCommands(program, controller(new FakeGateway(), new RecordingOutput()));

    // Act
    const set = program.commands.find(command => command.name() === 'secret')?.commands.find(c => c.name() === 'set');

    // Assert — a credential on a command line is in shell history and in /proc for every account.
    expect(set?.registeredArguments.map(argument => argument.name())).toEqual(['name']);
  });
});
