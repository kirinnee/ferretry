import { describe, expect, it } from 'bun:test';
import {
  type CapabilityGrantView,
  DAEMON_CAPABILITIES,
  type GrantAuditView,
  type GrantsPatch,
  type GrantsView,
} from '@ferretry/protocol';
import { Command } from 'commander';
import { registerGrantCommands } from '../../../src/lib/grants/commands';
import { GrantController } from '../../../src/lib/grants/controller';
import { GRANTS_PATH, ProtocolGrantGateway } from '../../../src/lib/grants/gateway';
import type { IGrantGateway, IGrantOutput } from '../../../src/lib/grants/ports';
import {
  grantDifference,
  renderGrantChange,
  renderGrantHistory,
  renderGrants,
  STEP_UP_NOTE,
} from '../../../src/lib/grants/render';

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
  configureRefusal: granted.configure ? 'granted' : 'not-granted',
  // A remote caller never widens, so the CLI's fixtures speak for the caller the grants govern.
  mayGrant: false,
  origin: 'default',
  ...overrides,
});

const view = (overrides: Partial<GrantsView> = {}): GrantsView => ({
  capabilities: DAEMON_CAPABILITIES.map(name => capability(name, { use: true, configure: true })),
  // The CLI runs on the host and authenticates with the admin token, so the caller these fixtures stand
  // for is the one that is BOTH local and ungoverned — the two facts that came apart when a local browser
  // started needing a step-up. The command line never does.
  governed: false,
  hostLocal: true,
  steppedUp: false,
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
  changed: { patch: GrantsPatch } | undefined;

  constructor(
    private current: GrantsView = view(),
    private readonly next: GrantsView = view(),
    private readonly audit: GrantAuditView = { entries: [], unreadable: 0, truncated: false },
  ) {}

  async read(): Promise<GrantsView> {
    return this.current;
  }

  async history(): Promise<GrantAuditView> {
    return this.audit;
  }

  async change(patch: GrantsPatch): Promise<GrantsView> {
    this.changed = { patch };
    this.current = this.next;
    return this.next;
  }
}

const controller = (gateway: IGrantGateway, out = new RecordingOutput()) => ({
  out,
  instance: new GrantController({ gateway, out, clientName: 'fy' }),
});

describe('the grant report', () => {
  it('should say who the rows apply to before showing any of them', () => {
    // The commonest wrong reading would be to see `configure off` and conclude your own command line
    // is blocked. THIS reader is the command line, which is ungoverned, and a report that left that
    // implicit would send somebody hunting a permission problem they do not have.
    // Act
    const rendered = renderGrants(view(), 'fy');

    // Assert
    expect(rendered.split('\n')[0]).toContain('NOT on this host');
    expect(rendered).toContain('This command line is ungoverned');
    expect(rendered).not.toMatch(/password/iu);
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

  it('should name the gap when the operator said yes and something else is still refusing', () => {
    // That gap is the interesting fact, and a report showing only the recorded answer would hide it.
    // Act
    const rendered = renderGrants(
      view({
        capabilities: [
          capability(
            'fleet',
            { use: true, configure: true },
            { configure: false, configureRefusal: 'step-up-required' },
          ),
        ],
      }),
      'fy',
    );

    // Assert — one plain sentence, not the wire word.
    expect(rendered).toContain(`configure ${STEP_UP_NOTE} right now`);
    expect(rendered).not.toContain('step-up-required');
  });

  it('should name any other refusal as the daemon words it', () => {
    // Act
    const rendered = renderGrants(
      view({
        capabilities: [
          capability('fleet', { use: true, configure: true }, { configure: false, configureRefusal: 'undetermined' }),
        ],
      }),
      'fy',
    );

    // Assert
    expect(rendered).toContain('configure undetermined right now');
  });

  it('should say nothing about a refusal when nothing is refusing', () => {
    // Act + Assert
    expect(renderGrants(view(), 'fy')).not.toContain('right now');
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

  it('should revoke in one request', async () => {
    // Arrange
    const gateway = new FakeGateway(
      view({ capabilities: [capability('fleet', { use: true, configure: true })] }),
      view({ capabilities: [capability('fleet', { use: true, configure: false })] }),
    );
    const { instance, out } = controller(gateway);

    // Act
    await instance.set('fleet', { configure: false });

    // Assert
    expect(gateway.changed?.patch).toEqual({ fleet: { configure: false } });
    expect(out.messages[0]).toContain('fleet.configure=off');
  });

  it('should widen in one request too, because this command line is ungoverned', async () => {
    // Arrange
    const gateway = new FakeGateway(
      view({ capabilities: [capability('fleet', { use: false, configure: false })] }),
      view({ capabilities: [capability('fleet', { use: true, configure: false })] }),
    );
    const { instance, out } = controller(gateway);

    // Act
    await instance.set('fleet', { use: true });

    // Assert
    expect(gateway.changed?.patch).toEqual({ fleet: { use: true } });
    expect(out.messages[0]).toContain('fleet.use=on');
  });

  it('should print the protocol document when asked for it', async () => {
    // Arrange
    const { instance, out } = controller(new FakeGateway());

    // Act
    await instance.show({ json: true });

    // Assert
    expect(JSON.parse(out.messages[0] ?? '{}')).toHaveProperty('steppedUp', false);
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

describe('the daemon grant routes as the client speaks them', () => {
  it('should send a change as a JSON body carrying no credential header', async () => {
    // Arrange
    const seen: { path: string; init: RequestInit | undefined }[] = [];
    const client = {
      request: async (path: string, _schema: unknown, init?: RequestInit) => {
        seen.push({ path, init });
        return view();
      },
    };

    // Act
    await new ProtocolGrantGateway(client as never).change({ fleet: { use: false } });

    // Assert
    expect(seen[0]?.path).toBe(GRANTS_PATH);
    expect(seen[0]?.init?.method).toBe('PATCH');
    expect(Object.keys(seen[0]?.init?.headers as Record<string, string>)).toEqual(['content-type']);
    expect(JSON.parse(String(seen[0]?.init?.body))).toEqual({ fleet: { use: false } });
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
    expect(daemon?.commands.map(command => command.name())).toEqual(['config']);
  });

  it('should name the binary it runs as in every example', async () => {
    // Arrange — not the shipped name, so an example that spells "fy" cannot pass.
    let help = '';
    const program = new Command().name('foo').exitOverride();
    program.configureOutput({
      writeOut: text => {
        help += text;
      },
      writeErr: () => {},
    });
    program.command('daemon').description('manage the daemon');
    const { instance } = controller(new FakeGateway());
    registerGrantCommands(program, () => instance);

    // Act
    await expect(program.parseAsync(['node', 'foo', 'daemon', 'config', 'set', '--help'])).rejects.toThrow();

    // Assert
    expect(help).toContain('  foo daemon config set warden --no-configure');
    expect(help).toContain('  foo daemon config set browser --no-use --no-configure');
    expect(help).toContain('  foo daemon config set fleet --configure');
    expect(help).not.toMatch(/password/iu);
    expect(help).not.toMatch(/\bfy daemon/u);
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

describe('reading who changed what', () => {
  const audit = (overrides: Partial<GrantAuditView> = {}): GrantAuditView => ({
    entries: [
      { at: '2026-08-05T11:00:00.000Z', actor: 'device:phone-1', changes: ['fleet.configure=off'] },
      { at: '2026-08-05T10:00:00.000Z', actor: 'admin-cli', changes: ['warden.use=on', 'warden.configure=on'] },
    ],
    unreadable: 0,
    truncated: false,
    ...overrides,
  });

  it('should say who, when and what — never a credential', () => {
    // A permission model whose changes leave no trace can only be understood by its effects, so
    // "when did this machine start letting a phone apply the fleet, and who said so" is the question.
    // Act
    const rendered = renderGrantHistory(audit());

    // Assert
    expect(rendered).toContain('device:phone-1');
    expect(rendered).toContain('fleet.configure=off');
    expect(rendered).toContain('warden.use=on, warden.configure=on');
    expect(rendered).not.toMatch(/Bearer|token|password/iu);
  });

  it('should report damage rather than quietly showing a shorter history', () => {
    // Silently omitting an unreadable line would let a truncated or tampered record read as a clean
    // one — and a permission history that loses entries quietly is worse than none, because people
    // trust it.
    // Act
    const rendered = renderGrantHistory(audit({ unreadable: 2 }));

    // Assert
    expect(rendered).toContain('2 lines in this window could not be read');
    expect(rendered).toContain('this history is incomplete');
  });

  it('should say when it is only showing the tail', () => {
    // Act + Assert
    expect(renderGrantHistory(audit({ truncated: true }))).toContain('older records exist');
    expect(renderGrantHistory(audit({ unreadable: 1 }))).toContain('1 line in this window');
  });

  it('should say plainly when nothing has ever been changed', () => {
    // An empty history is a real answer, not a failure, and must not read as one.
    // Act + Assert
    expect(renderGrantHistory(audit({ entries: [] }))).toBe('no grant has been changed on this machine');
  });

  it('should take nothing but the read itself', () => {
    // The caller who was refused a capability is exactly the caller asking when it was refused.
    // Arrange
    const gateway = new FakeGateway(view(), view(), audit());
    const { instance, out } = controller(gateway);

    // Act
    return instance.history({}).then(() => {
      // Assert
      expect(out.messages[0]).toContain('device:phone-1');
    });
  });

  it('should print the protocol document when asked', async () => {
    // Arrange
    const { instance, out } = controller(new FakeGateway(view(), view(), audit()));

    // Act
    await instance.history({ json: true });

    // Assert
    expect(JSON.parse(out.messages[0] ?? '{}')).toHaveProperty('unreadable', 0);
  });

  it('should be reachable as `history` and as `log`', async () => {
    // Arrange
    const program = new Command();
    program.command('daemon').description('manage the daemon');
    const { instance, out } = controller(new FakeGateway(view(), view(), audit()));
    registerGrantCommands(program, () => instance);

    // Act
    await program.parseAsync(['daemon', 'config', 'log'], { from: 'user' });

    // Assert
    expect(out.messages[0]).toContain('admin-cli');
  });

  it('should read the audit path rather than the grant path', async () => {
    // Arrange
    const seen: string[] = [];
    const client = {
      request: async (path: string) => {
        seen.push(path);
        return audit();
      },
    };

    // Act
    await new ProtocolGrantGateway(client as never).history();

    // Assert
    expect(seen).toEqual([`${GRANTS_PATH}/audit`]);
  });
});
