import { describe, expect, it } from 'bun:test';
import {
  type CapabilityGrants,
  DAEMON_CAPABILITIES,
  DEFAULT_DEVICE_GRANTS,
  type DeviceGrantsPatch,
  type PairedDevice,
  type PairedDevicesView,
} from '@ferretry/protocol';
import { Command } from 'commander';
import { registerDeviceCommands } from '../../../src/lib/device/commands';
import { DeviceController } from '../../../src/lib/device/controller';
import { PAIRED_DEVICES_PATH, ProtocolDeviceGateway } from '../../../src/lib/device/gateway';
import type { IDeviceGateway, IDeviceOutput } from '../../../src/lib/device/ports';
import { renderDeviceChange, renderDeviceGrants, renderDevices } from '../../../src/lib/device/render';

const PHONE = 'fy_device_id_aaaaaaaaaaaaaaaaaaaaaa';
const TABLET = 'fy_device_id_bbbbbbbbbbbbbbbbbbbbbb';
const OTHER_TABLET = 'fy_device_id_cccccccccccccccccccccc';

const device = (id: string, name: string, grants: CapabilityGrants = DEFAULT_DEVICE_GRANTS): PairedDevice => ({
  id: id as PairedDevice['id'],
  name,
  platform: 'browser',
  createdAt: '2026-08-01T00:00:00.000Z',
  lastSeenAt: '2026-08-05T12:00:00.000Z',
  idleExpiresAt: '2026-09-04T12:00:00.000Z',
  grants,
});

const withTerminal = (): CapabilityGrants => ({
  ...DEFAULT_DEVICE_GRANTS,
  terminal: { use: true, configure: false },
});

const view = (devices: readonly PairedDevice[], overrides: Partial<PairedDevicesView> = {}): PairedDevicesView => ({
  devices,
  hostLocal: true,
  mayWiden: DEFAULT_DEVICE_GRANTS,
  ...overrides,
});

class RecordingOutput implements IDeviceOutput {
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

class FakeGateway implements IDeviceGateway {
  changed: { deviceId: string; patch: DeviceGrantsPatch } | undefined;

  constructor(
    private readonly current: PairedDevicesView,
    private readonly next: PairedDevicesView = current,
  ) {}

  async list(): Promise<PairedDevicesView> {
    return this.current;
  }

  async changeGrants(deviceId: string, patch: DeviceGrantsPatch): Promise<PairedDevicesView> {
    this.changed = { deviceId, patch };
    return this.next;
  }
}

const controller = (gateway: IDeviceGateway, out = new RecordingOutput()) => ({
  out,
  instance: new DeviceController({ gateway, out, clientName: 'fy' }),
});

describe('the paired-device report', () => {
  it('should show name, id, last seen and both axes of every capability', () => {
    // Act
    const rendered = renderDevices([device(PHONE, 'Pixel 9', withTerminal())], undefined, 'fy');

    // Assert
    expect(rendered).toContain('"Pixel 9"');
    expect(rendered).toContain(PHONE);
    expect(rendered).toContain('2026-08-05T12:00:00.000Z');
    expect(rendered).toMatch(/fleet\s+use=on\s+configure=off/u);
    expect(rendered).toMatch(/terminal\s+use=on\s+configure=off/u);
    expect(rendered).toMatch(/secrets\s+use=off\s+configure=off/u);
    for (const capability of DAEMON_CAPABILITIES) expect(rendered).toContain(capability);
  });

  it('should say the command line is ungoverned and name the verb that changes things', () => {
    // Act
    const rendered = renderDevices([device(PHONE, 'Pixel 9')], undefined, 'foo');

    // Assert
    expect(rendered).toContain('This command line is ungoverned');
    expect(rendered).toContain('`foo device grant <device> <capability>');
  });

  it('should mark the device the caller is, when the caller is a paired device', () => {
    // Act
    const rendered = renderDevices([device(PHONE, 'Pixel 9'), device(TABLET, 'Tab')], TABLET, 'fy');

    // Assert
    expect(rendered.match(/\(this device\)/gu)).toHaveLength(1);
    expect(rendered).toMatch(/"Tab" {2}\(this device\)/u);
  });

  it('should quote a hostile name so it cannot forge the structure around it', () => {
    // Act
    const rendered = renderDevices([device(PHONE, 'x\n  terminal  use=on  configure=on')], undefined, 'fy');

    // Assert — the newline is escaped, so the forged row is not a row.
    expect(rendered).toContain('"x\\n  terminal  use=on  configure=on"');
  });

  it('should say plainly when nothing is paired, and how to pair', () => {
    // Act + Assert
    expect(renderDevices([], undefined, 'foo')).toBe('no device is paired with this host; pair one with `foo pair`');
  });

  it('should render the same grants the change report shows', () => {
    // Act
    const change = renderDeviceChange(device(PHONE, 'Pixel 9', withTerminal()));

    // Assert
    expect(change).toContain(`"Pixel 9" (${PHONE}) now holds:`);
    expect(change).toContain(renderDeviceGrants(withTerminal()));
  });
});

describe('listing devices from the command line', () => {
  it('should print the human report by default', async () => {
    // Arrange
    const { instance, out } = controller(new FakeGateway(view([device(PHONE, 'Pixel 9')])));

    // Act
    await instance.list({});

    // Assert
    expect(out.messages[0]).toContain('"Pixel 9"');
  });

  it('should print the protocol document when asked', async () => {
    // Arrange
    const { instance, out } = controller(new FakeGateway(view([device(PHONE, 'Pixel 9')], { thisDeviceId: PHONE })));

    // Act
    await instance.list({ json: true });

    // Assert
    const parsed = JSON.parse(out.messages[0] ?? '{}') as PairedDevicesView;
    expect(parsed.devices[0]?.grants.fleet).toEqual({ use: true, configure: false });
    expect(parsed.thisDeviceId).toBe(PHONE);
  });
});

describe('granting from the command line', () => {
  const changedView = view([device(PHONE, 'Pixel 9', withTerminal()), device(TABLET, 'Tab')]);
  const startView = view([device(PHONE, 'Pixel 9'), device(TABLET, 'Tab')]);

  it('should refuse a capability this daemon does not have, listing the real ones', async () => {
    // Arrange
    const gateway = new FakeGateway(startView);
    const { instance, out } = controller(gateway);

    // Act
    await instance.grant(PHONE, 'kubernetes', { use: true });

    // Assert
    expect(out.errors[0]).toContain('is not a capability this daemon has');
    expect(out.errors[0]).toContain(DAEMON_CAPABILITIES.join(', '));
    expect(out.exitCode).toBe(1);
    expect(gateway.changed).toBeUndefined();
  });

  it('should refuse a change that names neither axis rather than reporting success for nothing', async () => {
    // Arrange
    const gateway = new FakeGateway(startView);
    const { instance, out } = controller(gateway);

    // Act
    await instance.grant(PHONE, 'terminal', {});

    // Assert
    expect(out.errors[0]).toContain('name at least one axis');
    expect(out.exitCode).toBe(1);
    expect(gateway.changed).toBeUndefined();
  });

  it('should find a device by exact id and send only the axis named', async () => {
    // Arrange
    const gateway = new FakeGateway(startView, changedView);
    const { instance, out } = controller(gateway);

    // Act
    await instance.grant(PHONE, 'terminal', { use: true });

    // Assert
    expect(gateway.changed).toEqual({ deviceId: PHONE, patch: { terminal: { use: true } } });
    expect(out.messages[0]).toContain('now holds:');
    expect(out.messages[0]).toMatch(/terminal\s+use=on/u);
    expect(out.exitCode).toBeUndefined();
  });

  it('should find a device by exact, case-sensitive name when exactly one has it', async () => {
    // Arrange
    const gateway = new FakeGateway(startView, changedView);
    const { instance } = controller(gateway);

    // Act
    await instance.grant('Pixel 9', 'terminal', { use: true, configure: false });

    // Assert
    expect(gateway.changed?.deviceId).toBe(PHONE);
    expect(gateway.changed?.patch).toEqual({ terminal: { use: true, configure: false } });
  });

  it('should not match a name by case', async () => {
    // Arrange
    const gateway = new FakeGateway(startView);
    const { instance, out } = controller(gateway);

    // Act
    await instance.grant('pixel 9', 'terminal', { use: true });

    // Assert
    expect(out.errors[0]).toContain('is neither a device id nor a device name');
    expect(gateway.changed).toBeUndefined();
  });

  it('should prefer an id over a device whose NAME happens to equal it', async () => {
    // Arrange — a device named after another device's id must not capture the command.
    const gateway = new FakeGateway(view([device(PHONE, 'Pixel 9'), device(TABLET, PHONE)]), changedView);
    const { instance } = controller(gateway);

    // Act
    await instance.grant(PHONE, 'terminal', { use: true });

    // Assert
    expect(gateway.changed?.deviceId).toBe(PHONE);
  });

  it('should list the candidates when several devices share a name', async () => {
    // Arrange
    const gateway = new FakeGateway(view([device(TABLET, 'Tab'), device(OTHER_TABLET, 'Tab')]));
    const { instance, out } = controller(gateway);

    // Act
    await instance.grant('Tab', 'terminal', { use: true });

    // Assert
    expect(out.errors[0]).toContain('names 2 devices');
    expect(out.errors[0]).toContain(TABLET);
    expect(out.errors[0]).toContain(OTHER_TABLET);
    expect(out.exitCode).toBe(1);
    expect(gateway.changed).toBeUndefined();
  });

  it('should list every device id when nothing matches', async () => {
    // Arrange
    const gateway = new FakeGateway(startView);
    const { instance, out } = controller(gateway);

    // Act
    await instance.grant('nope', 'terminal', { use: true });

    // Assert
    expect(out.errors[0]).toContain(PHONE);
    expect(out.errors[0]).toContain(TABLET);
    expect(out.exitCode).toBe(1);
  });

  it('should say how to pair when there is no device at all', async () => {
    // Arrange
    const { instance, out } = controller(new FakeGateway(view([])));

    // Act
    await instance.grant('nope', 'terminal', { use: true });

    // Assert
    expect(out.errors[0]).toContain('no device is paired with this host');
    expect(out.errors[0]).toContain('`fy pair`');
    expect(out.exitCode).toBe(1);
  });

  it('should say so when the device vanished between the change and the answer', async () => {
    // Arrange — revoked from another place while this command was in flight.
    const gateway = new FakeGateway(startView, view([device(TABLET, 'Tab')]));
    const { instance, out } = controller(gateway);

    // Act
    await instance.grant(PHONE, 'terminal', { use: true });

    // Assert
    expect(out.errors[0]).toContain('no longer lists');
    expect(out.exitCode).toBe(1);
  });
});

describe('the daemon device routes as the client speaks them', () => {
  it('should read the list with no request options at all', async () => {
    // Arrange
    let init: RequestInit | undefined = { method: 'POST' };
    let seenPath = '';
    const client = {
      request: async (path: string, _schema: unknown, options?: RequestInit) => {
        seenPath = path;
        init = options;
        return view([]);
      },
    };

    // Act
    await new ProtocolDeviceGateway(client as never).list();

    // Assert
    expect(seenPath).toBe(PAIRED_DEVICES_PATH);
    expect(init).toBeUndefined();
  });

  it('should send a change as a JSON PATCH to the one device, carrying no credential header', async () => {
    // Arrange
    const seen: { path: string; init: RequestInit | undefined }[] = [];
    const client = {
      request: async (path: string, _schema: unknown, init?: RequestInit) => {
        seen.push({ path, init });
        return view([]);
      },
    };

    // Act
    await new ProtocolDeviceGateway(client as never).changeGrants(PHONE, { terminal: { use: true } });

    // Assert
    expect(seen[0]?.path).toBe(`/v1/pair/devices/${PHONE}/grants`);
    expect(seen[0]?.init?.method).toBe('PATCH');
    expect(Object.keys(seen[0]?.init?.headers as Record<string, string>)).toEqual(['content-type']);
    expect(JSON.parse(String(seen[0]?.init?.body))).toEqual({ terminal: { use: true } });
  });

  it('should refuse to send an empty patch', async () => {
    // Arrange
    const client = { request: async () => view([]) };

    // Act + Assert
    await expect(new ProtocolDeviceGateway(client as never).changeGrants(PHONE, {})).rejects.toThrow();
  });
});

describe('the command surface', () => {
  const build = (name = 'fy') => {
    const program = new Command().name(name).exitOverride();
    let help = '';
    program.configureOutput({
      writeOut: text => {
        help += text;
      },
      writeErr: () => {},
    });
    return { program, help: () => help };
  };

  it('should name the binary it runs as in every example and in the ungoverned note', async () => {
    // Arrange — not the shipped name, so an example that spells "fy" cannot pass.
    const { program, help } = build('foo');
    registerDeviceCommands(program, () => controller(new FakeGateway(view([]))).instance);

    // Act
    await expect(program.parseAsync(['node', 'foo', 'device', 'grant', '--help'])).rejects.toThrow();
    const grantHelp = help();
    await expect(program.parseAsync(['node', 'foo', 'device', '--help'])).rejects.toThrow();

    // Assert
    expect(grantHelp).toContain('  foo device grant "Pixel 9" terminal --use');
    expect(help()).toContain('`foo daemon config`');
    expect(`${grantHelp}${help()}`).not.toMatch(/\bfy (device|daemon)/u);
  });

  it('should explain the model in the group help', async () => {
    // Arrange
    const { program, help } = build();
    registerDeviceCommands(program, () => controller(new FakeGateway(view([]))).instance);

    // Act
    await expect(program.parseAsync(['node', 'fy', 'device', '--help'])).rejects.toThrow();

    // Assert
    expect(help()).toContain('ungoverned');
    expect(help()).toContain('admin token');
    expect(help()).toContain('fleet.use only');
    expect(help()).toContain('AND the daemon-wide ones');
    expect(help()).toContain('pairing.configure');
    expect(help()).toContain('passkey step-up');
    expect(help()).toContain(DAEMON_CAPABILITIES.join(', '));
  });

  it('should accept `list` wherever `ls` works', () => {
    // Arrange
    const { program } = build();

    // Act
    registerDeviceCommands(program, () => controller(new FakeGateway(view([]))).instance);
    const group = program.commands.find(command => command.name() === 'device');

    // Assert
    expect(group?.commands.find(command => command.name() === 'ls')?.aliases()).toEqual(['list']);
  });

  it('should list through the default subcommand and through `list --json`', async () => {
    // Arrange
    const { program } = build();
    const { instance, out } = controller(new FakeGateway(view([device(PHONE, 'Pixel 9')])));
    registerDeviceCommands(program, () => instance);

    // Act
    await program.parseAsync(['device'], { from: 'user' });
    await program.parseAsync(['device', 'list', '--json'], { from: 'user' });

    // Assert
    expect(out.messages[0]).toContain('"Pixel 9"');
    expect(JSON.parse(out.messages[1] ?? '{}')).toHaveProperty('hostLocal', true);
  });

  it('should drive the controller from the parsed command line, non-interactively', async () => {
    // Arrange
    const { program } = build();
    const gateway = new FakeGateway(view([device(PHONE, 'Pixel 9')]), view([device(PHONE, 'Pixel 9', withTerminal())]));
    registerDeviceCommands(program, () => controller(gateway).instance);

    // Act
    await program.parseAsync(['device', 'grant', 'Pixel 9', 'terminal', '--use', '--no-configure'], { from: 'user' });

    // Assert
    expect(gateway.changed).toEqual({ deviceId: PHONE, patch: { terminal: { use: true, configure: false } } });
  });
});
