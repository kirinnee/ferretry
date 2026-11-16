import { describe, expect, it } from 'bun:test';
import { CAPABILITY_NAMES } from '@ferretry/core-gate/contract';
import type { Instant } from '@ferretry/std';
import type { CapabilityGrantView, GrantAuditView, GrantsPatch, GrantsView } from '../../../../contract/index.ts';
import { grantsHelp, grantsSetHelp, grantVerbs } from '../../../../cli/lib/grants/commands.ts';
import { GrantController } from '../../../../cli/lib/grants/controller.ts';
import { GRANT_ROUTES, GRANTS_PATH, ProtocolGrantGateway } from '../../../../cli/lib/grants/gateway.ts';
import type { IGrantGateway, IGrantOutput } from '../../../../cli/lib/grants/ports.ts';
import {
  grantDifference,
  renderGrantChange,
  renderGrantHistory,
  renderGrants,
  STEP_UP_NOTE,
} from '../../../../cli/lib/grants/render.ts';
import { type DaemonCallInit, ExitStatus } from '../../../../cli/shell.ts';

/** A client that records each call and answers `answer`. */
const recording = (answer: unknown) => {
  const seen: { route: string; init: DaemonCallInit | undefined }[] = [];
  const client = {
    call: async <Answer>(route: string, init?: DaemonCallInit): Promise<Answer> => {
      seen.push({ route, init });
      return answer as Answer;
    },
  };
  return { seen, client };
};

/** The three grant verbs over a controller, answering their exit codes. */
const verbsOver = (instance: GrantController) => {
  const errors: string[] = [];
  return { errors, verbs: grantVerbs(() => instance, { err: text => errors.push(text) }, new ExitStatus()) };
};

const capability = (
  name: (typeof CAPABILITY_NAMES)[number],
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
  capabilities: CAPABILITY_NAMES.map(name => capability(name, { use: true, configure: true })),
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
  it('should send a change as a PATCH carrying only the patch', async () => {
    // Arrange
    const { seen, client } = recording(view());

    // Act
    await new ProtocolGrantGateway(client).change({ fleet: { use: false } });

    // Assert — no credential travels here: the shell's client chooses it.
    expect(GRANT_ROUTES.change).toBe(`PATCH ${GRANTS_PATH}`);
    expect(seen[0]?.route).toBe('PATCH /v1/grants');
    expect(seen[0]?.init).toEqual({ body: { fleet: { use: false } } });
  });

  it('should read the report with no request options at all', async () => {
    // Arrange
    const { seen, client } = recording(view());

    // Act
    await new ProtocolGrantGateway(client).read();

    // Assert
    expect(seen[0]?.route).toBe('GET /v1/grants');
    expect(seen[0]?.init).toBeUndefined();
  });
});

describe('the command surface', () => {
  it('should name the binary it runs as in every example', () => {
    // Arrange — not the shipped name, so an example that spells "fy" cannot pass.
    const help = `${grantsHelp()}\n${grantsSetHelp('foo')}`;

    // Assert
    expect(help).toContain('  foo daemon config set warden --no-configure');
    expect(help).toContain('  foo daemon config set browser --no-use --no-configure');
    expect(help).toContain('  foo daemon config set fleet --configure');
    expect(help).toContain(CAPABILITY_NAMES.join(', '));
    expect(help).not.toMatch(/password/iu);
    expect(help).not.toMatch(/\bfy daemon/u);
  });

  it('should drive the controller from the parsed command line, non-interactively', async () => {
    // Arrange
    const gateway = new FakeGateway(
      view({ capabilities: [capability('warden', { use: true, configure: true })] }),
      view({ capabilities: [capability('warden', { use: true, configure: false })] }),
    );
    const { verbs } = verbsOver(controller(gateway).instance);

    // Act
    const code = await verbs['daemon config set']({ args: ['warden'], options: { configure: false } });

    // Assert
    expect(code).toBe(0);
    expect(gateway.changed?.patch).toEqual({ warden: { configure: false } });
  });

  it('should read the report through `ls`', async () => {
    // Arrange
    const { instance, out } = controller(new FakeGateway());

    // Act
    const code = await verbsOver(instance).verbs['daemon config ls']({ args: [], options: {} });

    // Assert
    expect(code).toBe(0);
    expect(out.messages[0]).toContain('NOT on this host');
  });
});

describe('reading who changed what', () => {
  const audit = (overrides: Partial<GrantAuditView> = {}): GrantAuditView => ({
    entries: [
      { at: '2026-08-05T11:00:00.000Z' as Instant, actor: 'device:phone-1', changes: ['fleet.configure=off'] },
      {
        at: '2026-08-05T10:00:00.000Z' as Instant,
        actor: 'admin-cli',
        changes: ['warden.use=on', 'warden.configure=on'],
      },
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

  it('should be reachable as `history`', async () => {
    // Arrange
    const { instance, out } = controller(new FakeGateway(view(), view(), audit()));

    // Act
    await verbsOver(instance).verbs['daemon config history']({ args: [], options: {} });

    // Assert
    expect(out.messages[0]).toContain('admin-cli');
  });

  it('should read the audit path rather than the grant path', async () => {
    // Arrange
    const { seen, client } = recording(audit());

    // Act
    await new ProtocolGrantGateway(client).history();

    // Assert
    expect(seen.map(call => call.route)).toEqual(['GET /v1/grants/audit']);
  });
});
