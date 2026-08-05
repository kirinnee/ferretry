import { describe, expect, it } from 'bun:test';
import {
  type CapabilityGrantView,
  DAEMON_CAPABILITIES,
  type GrantsPatch,
  type GrantsView,
  OPERATOR_UNLOCK_HEADER,
} from '@ferretry/protocol';
import { Command } from 'commander';
import { registerGrantCommands } from '../../../src/lib/grants/commands';
import { GrantController } from '../../../src/lib/grants/controller';
import { GRANTS_PATH, ProtocolGrantGateway } from '../../../src/lib/grants/gateway';
import type { IGrantGateway, IGrantOutput, IOperatorPasswordSource } from '../../../src/lib/grants/ports';
import { grantDifference, NO_PASSWORD_NOTE, renderGrantChange, renderGrants } from '../../../src/lib/grants/render';

const capability = (
  name: (typeof DAEMON_CAPABILITIES)[number],
  granted: { use: boolean; configure: boolean },
  overrides: Partial<CapabilityGrantView> = {},
): CapabilityGrantView => ({
  capability: name,
  use: granted.use,
  configure: granted.configure,
  granted,
  useRefusal: granted.use ? 'granted' : 'not-granted',
  configureRefusal: granted.configure ? 'ungated' : 'not-granted',
  origin: 'default',
  ...overrides,
});

const view = (overrides: Partial<GrantsView> = {}): GrantsView => ({
  capabilities: DAEMON_CAPABILITIES.map(name => capability(name, { use: true, configure: true })),
  passwordSet: false,
  unlocked: false,
  ...overrides,
});

class RecordingOutput implements IGrantOutput {
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

class FakeGateway implements IGrantGateway {
  changed: { patch: GrantsPatch; unlock: string | undefined } | undefined;
  unlocked: string | undefined;
  password: string | undefined | 'cleared';

  constructor(
    private current: GrantsView = view(),
    private readonly next: GrantsView = view(),
  ) {}

  async read(): Promise<GrantsView> {
    return this.current;
  }

  async change(patch: GrantsPatch, unlock?: string): Promise<GrantsView> {
    this.changed = { patch, unlock };
    this.current = this.next;
    return this.next;
  }

  async unlock(password: string): Promise<string> {
    this.unlocked = password;
    return 'fy_unlock_aaaaaaaaaaaaaaaaaaaaaa';
  }

  async setPassword(password: string | undefined): Promise<boolean> {
    this.password = password ?? 'cleared';
    return password !== undefined;
  }
}

const passwords = (value = 'operator-secret'): IOperatorPasswordSource => ({ read: async () => value });

const controller = (gateway: IGrantGateway, out = new RecordingOutput()) => ({
  out,
  instance: new GrantController({ gateway, passwords: passwords(), out, clientName: 'fy' }),
});

describe('the grant report', () => {
  it('should say who the rows apply to before showing any of them', () => {
    // The commonest wrong reading would be to see `configure off` and conclude your own command line
    // is blocked. Loopback is ungoverned, and a report that left that implicit would send somebody
    // hunting a permission problem they do not have.
    // Act
    const rendered = renderGrants(view(), 'fy');

    // Assert
    expect(rendered.split('\n')[0]).toContain('NOT on this host');
    expect(rendered).toContain('loopback caller is ungoverned');
  });

  it('should show where each value came from', () => {
    // `--print-config` set this precedent and it is the reason a report is diagnosable: a person
    // reading it is asking which of these they chose and which something chose for them.
    // Act
    const rendered = renderGrants(
      view({
        capabilities: [
          capability('fleet', { use: true, configure: false }, { origin: 'config file' }),
          capability('warden', { use: true, configure: true }),
        ],
      }),
      'fy',
    );

    // Assert
    expect(rendered).toMatch(/fleet.*use=on.*configure=off.*\(config file\)/u);
    expect(rendered).toMatch(/warden.*\(default\)/u);
  });

  it('should state the no-password fact once, plainly, and only when it is true', () => {
    // One sentence, where the decision is visible. Not a modal, not repeated, and never a question
    // somebody has to answer to use their own machine.
    // Act
    const without = renderGrants(view(), 'fy');
    const with_ = renderGrants(view({ passwordSet: true }), 'fy');

    // Assert
    expect(without).toContain(NO_PASSWORD_NOTE);
    expect(without.match(/any paired device/gu)).toHaveLength(1);
    expect(with_).not.toContain(NO_PASSWORD_NOTE);
    expect(with_).toContain('an operator password is set');
  });

  it('should name the gap when the operator said yes and something else is still refusing', () => {
    // That gap is the interesting fact, and a report showing only the recorded answer would hide it.
    // Act
    const rendered = renderGrants(
      view({
        passwordSet: true,
        capabilities: [
          capability('fleet', { use: true, configure: true }, { configure: false, configureRefusal: 'locked' }),
        ],
      }),
      'fy',
    );

    // Assert
    expect(rendered).toContain('configure locked right now');
  });

  it('should report when a rate-limited daemon resumes checking passwords', () => {
    // A limiter a person cannot see looks like a broken daemon.
    // Act
    const rendered = renderGrants(view({ passwordSet: true, lockedUntil: '2026-08-05T11:00:00.000Z' }), 'fy');

    // Assert
    expect(rendered).toContain('resumes checking at 2026-08-05T11:00:00.000Z');
  });
});

describe('what a change reports about itself', () => {
  it('should answer the restart question at the moment of the change', () => {
    // Not in documentation nobody reads at the moment they need it. And it names the case that DOES
    // need a restart, because hand-editing the document is the tempting alternative to this command.
    // Act
    const rendered = renderGrantChange(['warden.configure=off'], 'fy');

    // Assert
    expect(rendered).toContain('in effect now, no restart needed');
    expect(rendered).toContain('fy daemon restart');
  });

  it('should say plainly when a change moved nothing', () => {
    // Act + Assert
    expect(renderGrantChange([], 'fy')).toContain('nothing changed');
  });

  it('should report only the axes that actually moved', () => {
    // Arrange
    const before = view({ capabilities: [capability('fleet', { use: true, configure: true })] });
    const after = view({ capabilities: [capability('fleet', { use: true, configure: false })] });

    // Act + Assert
    expect(grantDifference(before, after)).toEqual(['fleet.configure=off']);
    expect(grantDifference(before, before)).toEqual([]);
  });
});

describe('changing a grant from the command line', () => {
  it('should refuse a capability this daemon does not have', async () => {
    // Arrange
    const { instance, out } = controller(new FakeGateway());

    // Act
    await instance.set('kubernetes', { use: false });

    // Assert
    expect(out.errors[0]).toContain('is not a capability this daemon has');
    expect(out.exitCode).toBe(1);
  });

  it('should refuse a change that names neither axis rather than reporting success for nothing', async () => {
    // Somebody who typed `fy daemon config set warden` meant something, and answering "done" for a
    // command that did nothing is how a person comes to believe they configured something.
    // Arrange
    const { instance, out } = controller(new FakeGateway());

    // Act
    await instance.set('warden', {});

    // Assert
    expect(out.errors[0]).toContain('name at least one axis');
    expect(out.exitCode).toBe(1);
  });

  it('should revoke without ever reading the operator password', async () => {
    // Revoking must never be harder than granting: in an incident the fastest possible path to "the
    // UI can no longer do that" matters more than the confirmation.
    // Arrange
    const gateway = new FakeGateway(
      view({ passwordSet: true, capabilities: [capability('fleet', { use: true, configure: true })] }),
      view({ passwordSet: true, capabilities: [capability('fleet', { use: true, configure: false })] }),
    );
    const { instance, out } = controller(gateway);

    // Act
    await instance.set('fleet', { configure: false });

    // Assert
    expect(gateway.unlocked).toBeUndefined();
    expect(gateway.changed?.unlock).toBeUndefined();
    expect(out.messages[0]).toContain('fleet.configure=off');
  });

  it('should trade the password for an unlock before widening anything', async () => {
    // Arrange
    const gateway = new FakeGateway(
      view({ passwordSet: true, capabilities: [capability('fleet', { use: true, configure: false })] }),
      view({ passwordSet: true, capabilities: [capability('fleet', { use: true, configure: true })] }),
    );
    const { instance } = controller(gateway);

    // Act
    await instance.set('fleet', { configure: true });

    // Assert
    expect(gateway.unlocked).toBe('operator-secret');
    expect(gateway.changed?.unlock).toBe('fy_unlock_aaaaaaaaaaaaaaaaaaaaaa');
  });

  it('should not ask for a password a machine does not have', async () => {
    // Arrange
    const gateway = new FakeGateway(
      view({ capabilities: [capability('fleet', { use: false, configure: false })] }),
      view({ capabilities: [capability('fleet', { use: true, configure: false })] }),
    );
    const { instance } = controller(gateway);

    // Act
    await instance.set('fleet', { use: true });

    // Assert
    expect(gateway.unlocked).toBeUndefined();
  });

  it('should print the protocol document when asked for it', async () => {
    // Arrange
    const { instance, out } = controller(new FakeGateway());

    // Act
    await instance.show({ json: true });

    // Assert
    expect(JSON.parse(out.messages[0] ?? '{}')).toHaveProperty('passwordSet', false);
  });

  it('should print the human report by default', async () => {
    // Arrange
    const { instance, out } = controller(new FakeGateway());

    // Act
    await instance.show({});

    // Assert
    expect(out.messages[0]).toContain('NOT on this host');
  });
});

describe('the operator password commands', () => {
  it('should read the password from stdin and say what it now gates', async () => {
    // Arrange
    const gateway = new FakeGateway();
    const { instance, out } = controller(gateway);

    // Act
    await instance.setPassword();

    // Assert
    expect(gateway.password).toBe('operator-secret');
    expect(out.messages[0]).toContain('now needs it');
  });

  it('should say exactly what clearing the password means, rather than letting it be discovered', async () => {
    // Arrange
    const gateway = new FakeGateway();
    const { instance, out } = controller(gateway);

    // Act
    await instance.clearPassword();

    // Assert
    expect(gateway.password).toBe('cleared');
    expect(out.messages[0]).toContain('any paired device can now change');
  });

  it('should report a cleared password when the daemon says none is set', async () => {
    // Arrange
    const gateway = new FakeGateway();
    const out = new RecordingOutput();
    const instance = new GrantController({
      gateway,
      passwords: { read: async () => 'ignored' },
      out,
      clientName: 'fy',
    });
    gateway.setPassword = async () => false;

    // Act
    await instance.setPassword();

    // Assert
    expect(out.messages[0]).toBe('operator password cleared');
  });
});

describe('the daemon grant routes as the client speaks them', () => {
  it('should send the unlock in a header and never in a URL', async () => {
    // A URL reaches every proxy's access log, and an unlock in a log outlives its five minutes.
    // Arrange
    const seen: { path: string; init: RequestInit | undefined }[] = [];
    const client = {
      request: async (path: string, _schema: unknown, init?: RequestInit) => {
        seen.push({ path, init });
        return view();
      },
    };

    // Act
    await new ProtocolGrantGateway(client as never).change({ fleet: { use: false } }, 'fy_unlock_token');

    // Assert
    expect(seen[0]?.path).toBe(GRANTS_PATH);
    expect((seen[0]?.init?.headers as Record<string, string>)[OPERATOR_UNLOCK_HEADER]).toBe('fy_unlock_token');
    expect(seen[0]?.path).not.toContain('unlock=');
  });

  it('should omit the header entirely when there is no unlock to send', async () => {
    // Arrange
    const seen: RequestInit[] = [];
    const client = {
      request: async (_path: string, _schema: unknown, init?: RequestInit) => {
        if (init !== undefined) seen.push(init);
        return view();
      },
    };

    // Act
    await new ProtocolGrantGateway(client as never).change({ fleet: { use: false } });

    // Assert
    expect(Object.keys(seen[0]?.headers as Record<string, string>)).toEqual(['content-type']);
  });

  it('should post the password to unlock and put it to set, never in a path', async () => {
    // Arrange
    const seen: { path: string; method: string | undefined; body: string }[] = [];
    const client = {
      request: async (path: string, _schema: unknown, init?: RequestInit) => {
        seen.push({ path, method: init?.method, body: String(init?.body ?? '') });
        return path.endsWith('/unlock')
          ? { token: 'fy_unlock_aaaaaaaaaaaaaaaaaaaaaa', expiresAt: '2026-08-05T10:05:00.000Z', ttlSeconds: 300 }
          : { passwordSet: true };
      },
    };
    const gateway = new ProtocolGrantGateway(client as never);

    // Act
    await gateway.unlock('operator-secret');
    await gateway.setPassword('operator-secret');
    await gateway.setPassword(undefined);

    // Assert — the password is in a body every time, and never a path segment.
    expect(seen.map(entry => `${String(entry.method)} ${entry.path}`)).toEqual([
      'POST /v1/grants/unlock',
      'PUT /v1/grants/password',
      'PUT /v1/grants/password',
    ]);
    for (const entry of seen) expect(entry.path).not.toContain('operator-secret');
    expect(seen[2]?.body).toBe('{}');
  });

  it('should read the report with no request options at all', async () => {
    // Arrange
    let init: RequestInit | undefined = { method: 'POST' };
    const client = {
      request: async (_path: string, _schema: unknown, options?: RequestInit) => {
        init = options;
        return view();
      },
    };

    // Act
    await new ProtocolGrantGateway(client as never).read();

    // Assert
    expect(init).toBeUndefined();
  });
});

describe('the command surface', () => {
  it('should mount onto the existing daemon group rather than inventing a second one', () => {
    // `fy daemon` already reads install|uninstall|start|stop|restart|status|logs, and inventing a
    // second grammar for the same subject is how a command line stops being learnable.
    // Arrange
    const program = new Command();
    program.command('daemon').description('manage the daemon');
    const { instance } = controller(new FakeGateway());

    // Act
    registerGrantCommands(program, () => instance);
    const daemon = program.commands.find(command => command.name() === 'daemon');

    // Assert
    expect(program.commands.filter(command => command.name() === 'daemon')).toHaveLength(1);
    expect(daemon?.commands.map(command => command.name())).toEqual(['config', 'password']);
  });

  it('should accept `list` wherever `ls` works', () => {
    // `fy fleet list` failing confusingly is a mistake this repository has already made once.
    // Arrange
    const program = new Command();
    program.command('daemon').description('manage the daemon');
    const { instance } = controller(new FakeGateway());

    // Act
    registerGrantCommands(program, () => instance);
    const config = program.commands
      .find(command => command.name() === 'daemon')
      ?.commands.find(command => command.name() === 'config');

    // Assert
    expect(config?.commands.find(command => command.name() === 'ls')?.aliases()).toEqual(['list']);
  });

  it('should refuse to register before the group it mounts onto exists', () => {
    // A second `daemon` command would give commander two with one name and silently lose half the
    // verbs. A startup failure beats a command that quietly does not exist.
    // Arrange
    const program = new Command();
    const { instance } = controller(new FakeGateway());

    // Act + Assert
    expect(() => registerGrantCommands(program, () => instance)).toThrow(/must be registered before/u);
  });

  it('should drive the controller from the parsed command line, non-interactively', async () => {
    // Arrange
    const program = new Command();
    program.command('daemon').description('manage the daemon');
    const gateway = new FakeGateway(
      view({ capabilities: [capability('warden', { use: true, configure: true })] }),
      view({ capabilities: [capability('warden', { use: true, configure: false })] }),
    );
    const { instance } = controller(gateway);
    registerGrantCommands(program, () => instance);

    // Act
    await program.parseAsync(['daemon', 'config', 'set', 'warden', '--no-configure'], { from: 'user' });

    // Assert
    expect(gateway.changed?.patch).toEqual({ warden: { configure: false } });
  });

  it('should drive the password verbs from the command line too', async () => {
    // Arrange
    const program = new Command();
    program.command('daemon').description('manage the daemon');
    const gateway = new FakeGateway();
    const { instance } = controller(gateway);
    registerGrantCommands(program, () => instance);

    // Act
    await program.parseAsync(['daemon', 'password', 'set'], { from: 'user' });
    const afterSet = gateway.password;
    await program.parseAsync(['daemon', 'password', 'clear'], { from: 'user' });

    // Assert
    expect(afterSet).toBe('operator-secret');
    expect(gateway.password).toBe('cleared');
  });

  it('should read the report through the default subcommand', async () => {
    // Arrange
    const program = new Command();
    program.command('daemon').description('manage the daemon');
    const { instance, out } = controller(new FakeGateway());
    registerGrantCommands(program, () => instance);

    // Act
    await program.parseAsync(['daemon', 'config'], { from: 'user' });

    // Assert
    expect(out.messages[0]).toContain('NOT on this host');
  });
});
