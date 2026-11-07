import { describe, expect, it } from 'bun:test';
import { CAPABILITY_NAMES, type CapabilityGrants, LIMITED_DEVICE_GRANTS } from '@ferretry/core-gate/contract';
import type { Instant } from '@ferretry/std';
import manifest from '../../../../manifest.ts';
import type { DeviceGrantsPatch, PairedDevice, PairedDevicesView } from '../../../../contract/index.ts';
import { deviceHelp, deviceGrantHelp, deviceRevokeHelp, deviceVerbs } from '../../../../cli/lib/device/commands.ts';
import { DeviceController } from '../../../../cli/lib/device/controller.ts';
import { DEVICE_ROUTES, PAIRED_DEVICES_PATH, ProtocolDeviceGateway } from '../../../../cli/lib/device/gateway.ts';
import type { IDeviceGateway, IDeviceOutput, IDevicePrompt } from '../../../../cli/lib/device/ports.ts';
import { renderDeviceChange, renderDeviceGrants, renderDevices } from '../../../../cli/lib/device/render.ts';
import { type DaemonCallInit, ExitStatus, FyHttpError, FyTransportError } from '../../../../cli/shell.ts';

const PHONE = 'fy_device_id_aaaaaaaaaaaaaaaaaaaaaa';
const TABLET = 'fy_device_id_bbbbbbbbbbbbbbbbbbbbbb';
const OTHER_TABLET = 'fy_device_id_cccccccccccccccccccccc';

const device = (id: string, name: string, grants: CapabilityGrants = LIMITED_DEVICE_GRANTS): PairedDevice => ({
  id: id as PairedDevice['id'],
  name,
  platform: 'browser',
  createdAt: '2026-08-01T00:00:00.000Z' as Instant,
  lastSeenAt: '2026-08-05T12:00:00.000Z' as Instant,
  idleExpiresAt: '2026-09-04T12:00:00.000Z' as Instant,
  grants,
});

const withTerminal = (): CapabilityGrants => ({
  ...LIMITED_DEVICE_GRANTS,
  terminal: { use: true, configure: false },
});

const view = (devices: readonly PairedDevice[], overrides: Partial<PairedDevicesView> = {}): PairedDevicesView => ({
  devices,
  hostLocal: true,
  mayWiden: LIMITED_DEVICE_GRANTS,
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
  readonly revoked: string[] = [];
  /** What the next revoke fails with, if anything. */
  revokeFailure: unknown;

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

  async revoke(deviceId: string): Promise<PairedDevicesView> {
    if (this.revokeFailure !== undefined) throw this.revokeFailure;
    this.revoked.push(deviceId);
    return this.next;
  }
}

class ScriptedPrompt implements IDevicePrompt {
  readonly asked: string[] = [];

  constructor(private readonly answer = '') {}

  async ask(message: string): Promise<string> {
    this.asked.push(message);
    return this.answer;
  }
}

const controller = (
  gateway: IDeviceGateway,
  out = new RecordingOutput(),
  prompt = new ScriptedPrompt(),
  interactive = false,
) => ({
  out,
  prompt,
  instance: new DeviceController({ gateway, out, prompt, interactive, clientName: 'fy' }),
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
    for (const capability of CAPABILITY_NAMES) expect(rendered).toContain(capability);
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
    expect(out.errors[0]).toContain(CAPABILITY_NAMES.join(', '));
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

  it('P40 should find a device by exact id and send only the axis named', async () => {
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

describe('revoking from the command line', () => {
  const listed = view([device(PHONE, 'Pixel 8'), device(TABLET, 'Chrome'), device(OTHER_TABLET, 'Chrome')]);

  it('P121 should revoke a device named by id under --yes, in one plain sentence', async () => {
    // Arrange
    const gateway = new FakeGateway(listed);
    const { instance, out, prompt } = controller(gateway);

    // Act
    await instance.revoke(PHONE, { yes: true });

    // Assert
    expect(gateway.revoked).toEqual([PHONE]);
    expect(out.messages).toEqual([
      'Pixel 8 can no longer reach this machine; its open sessions were closed and its passkeys forgotten.',
    ]);
    expect(out.errors).toEqual([]);
    expect(out.exitCode).toBeUndefined();
    expect(prompt.asked).toEqual([]);
  });

  it('should find a device by the one name it carries, and resolve exactly as passkey window does', async () => {
    // Arrange
    const gateway = new FakeGateway(listed);
    const { instance } = controller(gateway);

    // Act
    await instance.revoke('Pixel 8', { yes: true });

    // Assert
    expect(gateway.revoked).toEqual([PHONE]);
  });

  it('P121 should refuse an ambiguous name with the ids to choose from, and revoke nothing', async () => {
    // Arrange
    const gateway = new FakeGateway(listed);
    const { instance, out } = controller(gateway);

    // Act
    await instance.revoke('Chrome', { yes: true });

    // Assert
    expect(out.errors).toHaveLength(1);
    expect(out.errors[0]).toContain(TABLET);
    expect(out.errors[0]).toContain(OTHER_TABLET);
    expect(out.exitCode).toBe(1);
    expect(gateway.revoked).toEqual([]);
  });

  it('P121 should name the paired devices for an unknown device, and revoke nothing', async () => {
    // Arrange
    const gateway = new FakeGateway(listed);
    const { instance, out } = controller(gateway);

    // Act
    await instance.revoke('Nokia', { yes: true });

    // Assert
    expect(out.errors).toEqual([
      'No paired device is named or numbered "Nokia". The paired devices are "Pixel 8", "Chrome", "Chrome".',
    ]);
    expect(out.exitCode).toBe(1);
    expect(gateway.revoked).toEqual([]);
  });

  it('should say how to pair when nothing is paired at all', async () => {
    // Arrange
    const { instance, out } = controller(new FakeGateway(view([])));

    // Act
    await instance.revoke('Nokia', { yes: true });

    // Assert
    expect(out.errors[0]).toContain('no device is paired with this machine yet — run `fy pair` first.');
    expect(out.exitCode).toBe(1);
  });

  it('P120 should refuse off a terminal without --yes, in one sentence, and revoke nothing', async () => {
    // Arrange
    const gateway = new FakeGateway(listed);
    const { instance, out, prompt } = controller(gateway, new RecordingOutput(), new ScriptedPrompt(), false);

    // Act
    await instance.revoke(PHONE, {});

    // Assert
    expect(out.errors).toEqual([
      'Refusing to revoke Pixel 8 without a confirmation: pass --yes to revoke it from a script, or run `fy device revoke` at a terminal.',
    ]);
    expect(out.exitCode).toBe(1);
    expect(gateway.revoked).toEqual([]);
    expect(prompt.asked).toEqual([]);
  });

  it('P120 should revoke on a terminal once the owner types the confirmation word', async () => {
    // Arrange
    const gateway = new FakeGateway(listed);
    const { instance, out, prompt } = controller(gateway, new RecordingOutput(), new ScriptedPrompt(' revoke '), true);

    // Act
    await instance.revoke(PHONE, {});

    // Assert
    expect(prompt.asked).toHaveLength(1);
    expect(prompt.asked[0]).toContain('"Pixel 8"');
    expect(prompt.asked[0]).toContain(PHONE);
    expect(gateway.revoked).toEqual([PHONE]);
    expect(out.exitCode).toBeUndefined();
  });

  it('P120 should cancel, exit 1 and revoke nothing on any other answer', async () => {
    // Arrange
    const gateway = new FakeGateway(listed);
    const { instance, out } = controller(gateway, new RecordingOutput(), new ScriptedPrompt('no'), true);

    // Act
    await instance.revoke(PHONE, {});

    // Assert
    expect(out.errors).toEqual(['Revoke cancelled: Pixel 8 can still reach this machine.']);
    expect(out.exitCode).toBe(1);
    expect(gateway.revoked).toEqual([]);
  });

  it('P121 should say the daemon is not running when it cannot be reached', async () => {
    // Arrange
    const gateway = new FakeGateway(listed);
    gateway.revokeFailure = new FyTransportError(
      'could not reach fyd',
      '/v1/pair/devices',
      false,
      new Error('ECONNREFUSED'),
    );
    const { instance, out } = controller(gateway);

    // Act
    await instance.revoke(PHONE, { yes: true });

    // Assert
    expect(out.errors).toEqual([
      'The daemon did not answer, so nothing was revoked — start it with `fy daemon start` and run this again.',
    ]);
    expect(out.exitCode).toBe(1);
    expect(out.messages).toEqual([]);
  });

  it('P121 should say the device is already gone on a 404 from the daemon', async () => {
    // Arrange
    const gateway = new FakeGateway(listed);
    gateway.revokeFailure = new FyHttpError('device not found', 404, 'pairing_device_not_found');
    const { instance, out } = controller(gateway);

    // Act
    await instance.revoke(PHONE, { yes: true });

    // Assert
    expect(out.errors).toEqual([
      'The daemon no longer knows that device, so it may already have been revoked — run `fy device ls` to see who is paired.',
    ]);
    expect(out.exitCode).toBe(1);
    expect(out.messages).toEqual([]);
  });

  it('should rethrow a failure it does not recognise rather than invent a sentence for it', async () => {
    // Arrange
    const gateway = new FakeGateway(listed);
    gateway.revokeFailure = new FyHttpError('boom', 500, 'internal_error');
    const { instance } = controller(gateway);

    // Act + Assert
    await expect(instance.revoke(PHONE, { yes: true })).rejects.toThrow('boom');
  });

  it('should print a hostile device name with its control characters dropped', async () => {
    // Arrange
    const gateway = new FakeGateway(view([device(PHONE, 'Pix\u001b[31mel')]));
    const { instance, out } = controller(gateway);

    // Act
    await instance.revoke(PHONE, { yes: true });

    // Assert
    expect(out.messages[0]).toStartWith('Pix[31mel can no longer');
    expect(out.messages[0]).not.toContain('\u001b');
  });
});

describe('the daemon device routes as the client speaks them', () => {
  /** A client that records each call and answers `answer`. */
  const recording = (answer: unknown = view([])) => {
    const seen: { route: string; init: DaemonCallInit | undefined }[] = [];
    const client = {
      call: async <Answer>(route: string, init?: DaemonCallInit): Promise<Answer> => {
        seen.push({ route, init });
        return answer as Answer;
      },
    };
    return { seen, client };
  };

  it('should call only route keys the manifest declares', () => {
    const declared = (manifest.actions.routes as readonly { readonly key: string }[]).map(route => route.key);
    for (const key of Object.values(DEVICE_ROUTES)) expect(declared).toContain(key);
    expect(DEVICE_ROUTES.list).toBe(`GET ${PAIRED_DEVICES_PATH}`);
  });

  it('P117 should delete the one device by id with no body, answering the remaining list', async () => {
    // Arrange
    const { seen, client } = recording();

    // Act
    const after = await new ProtocolDeviceGateway(client).revoke(PHONE);

    // Assert
    expect(seen[0]?.route).toBe('DELETE /v1/pair/devices/:deviceId');
    expect(seen[0]?.init).toEqual({ params: { deviceId: PHONE } });
    expect(after.devices).toEqual([]);
  });

  it('should read the list with no request options at all', async () => {
    // Arrange
    const { seen, client } = recording();

    // Act
    await new ProtocolDeviceGateway(client).list();

    // Assert
    expect(seen[0]?.route).toBe('GET /v1/pair/devices');
    expect(seen[0]?.init).toBeUndefined();
  });

  it('P40 should send a change as a PATCH to the one device, carrying only the patch', async () => {
    // Arrange
    const { seen, client } = recording();

    // Act
    await new ProtocolDeviceGateway(client).changeGrants(PHONE, { terminal: { use: true } });

    // Assert — no credential travels here: the shell's client chooses it.
    expect(seen[0]?.route).toBe('PATCH /v1/pair/devices/:deviceId/grants');
    expect(seen[0]?.init).toEqual({ params: { deviceId: PHONE }, body: { terminal: { use: true } } });
  });

  it('should refuse to send an empty patch', async () => {
    // Arrange
    const { seen, client } = recording();

    // Act + Assert
    await expect(new ProtocolDeviceGateway(client).changeGrants(PHONE, {})).rejects.toThrow();
    expect(seen).toEqual([]);
  });
});

describe('the command surface', () => {
  /** The three verbs over a fake gateway; `interactive` and `answer` drive the revoke prompt. */
  const build = (gateway: FakeGateway, interactive = false, answer = '') => {
    const exit = new ExitStatus();
    const errors: string[] = [];
    const messages: string[] = [];
    const out: IDeviceOutput = {
      success: message => messages.push(message),
      error: message => errors.push(message),
      setExitCode: code => exit.setExitCode(code),
    };
    const verbs = deviceVerbs(
      () => new DeviceController({ gateway, out, prompt: new ScriptedPrompt(answer), interactive, clientName: 'fy' }),
      { err: text => errors.push(text) },
      exit,
    );
    return { verbs, errors, messages };
  };

  it('should implement every device verb the manifest declares', () => {
    const declared = (manifest.actions.cli as readonly { readonly verb: string }[])
      .map(entry => entry.verb)
      .filter(verb => verb.startsWith('device '));
    expect(Object.keys(build(new FakeGateway(view([]))).verbs).sort()).toEqual(declared.sort());
  });

  it('should name the binary it runs as in every example and in the ungoverned note', () => {
    // Arrange — not the shipped name, so an example that spells "fy" cannot pass.
    const grantHelp = deviceGrantHelp('foo');
    const groupHelp = deviceHelp('foo');

    // Assert
    expect(grantHelp).toContain('  foo device grant "Pixel 9" terminal --use');
    expect(groupHelp).toContain('`foo daemon config`');
    expect(`${grantHelp}${groupHelp}`).not.toMatch(/\bfy (device|daemon)/u);
  });

  it('should explain the model in the group help', () => {
    // Act
    const help = deviceHelp('fy');

    // Assert
    expect(help).toContain('ungoverned');
    expect(help).toContain('admin token');
    expect(help).toContain('FULL grants');
    expect(help).toContain('unlocks with its passkey');
    expect(help).toContain('pair --limited');
    expect(help).not.toContain('starts with fleet.use only');
    expect(help).toContain('AND the daemon-wide ones');
    expect(help).toContain('pairing.configure');
    expect(help).toContain('passkey step-up');
    expect(help).toContain(CAPABILITY_NAMES.join(', '));
  });

  it('should list through `device ls` and `device ls --json`', async () => {
    // Arrange
    const { verbs, messages } = build(new FakeGateway(view([device(PHONE, 'Pixel 9')])));

    // Act
    const codes = [
      await verbs['device ls']({ args: [], options: {} }),
      await verbs['device ls']({ args: [], options: { json: true } }),
    ];

    // Assert
    expect(codes).toEqual([0, 0]);
    expect(messages[0]).toContain('"Pixel 9"');
    expect(JSON.parse(messages[1] ?? '{}')).toHaveProperty('hostLocal', true);
  });

  it('P117 should drive revoke from the parsed command line, with -y skipping the prompt', async () => {
    // Arrange
    const gateway = new FakeGateway(view([device(PHONE, 'Pixel 9')]));
    const { verbs } = build(gateway);

    // Act
    const code = await verbs['device revoke']({ args: ['Pixel 9'], options: { y: true } });

    // Assert
    expect(code).toBe(0);
    expect(gateway.revoked).toEqual([PHONE]);
    expect(deviceRevokeHelp('foo')).toContain('  foo device revoke "Pixel 9" --yes');
    expect(deviceRevokeHelp('foo')).not.toMatch(/\bfy device/u);
  });

  it('P120 should refuse off a terminal without --yes and exit 1, revoking nothing', async () => {
    // Arrange
    const gateway = new FakeGateway(view([device(PHONE, 'Pixel 9')]));
    const { verbs, errors } = build(gateway, false);

    // Act
    const code = await verbs['device revoke']({ args: ['Pixel 9'], options: {} });

    // Assert
    expect(code).toBe(1);
    expect(errors[0]).toContain('pass --yes');
    expect(gateway.revoked).toEqual([]);
  });

  it('P120 should make the owner type revoke at a terminal', async () => {
    // Arrange
    const typed = new FakeGateway(view([device(PHONE, 'Pixel 9')]));
    const declined = new FakeGateway(view([device(PHONE, 'Pixel 9')]));

    // Act
    const yes = await build(typed, true, 'revoke').verbs['device revoke']({ args: ['Pixel 9'], options: {} });
    const no = await build(declined, true, 'y').verbs['device revoke']({ args: ['Pixel 9'], options: {} });

    // Assert
    expect([yes, no]).toEqual([0, 1]);
    expect(typed.revoked).toEqual([PHONE]);
    expect(declined.revoked).toEqual([]);
  });

  it('P40 should drive the controller from the parsed command line, non-interactively', async () => {
    // Arrange
    const gateway = new FakeGateway(view([device(PHONE, 'Pixel 9')]), view([device(PHONE, 'Pixel 9', withTerminal())]));
    const { verbs } = build(gateway);

    // Act
    const code = await verbs['device grant']({
      args: ['Pixel 9', 'terminal'],
      options: { use: true, configure: false },
    });

    // Assert
    expect(code).toBe(0);
    expect(gateway.changed).toEqual({ deviceId: PHONE, patch: { terminal: { use: true, configure: false } } });
  });

  it('should refuse what commander refused: an unknown flag, a missing argument, a value on a switch', async () => {
    // Arrange
    const gateway = new FakeGateway(view([device(PHONE, 'Pixel 9')]));
    const { verbs, errors } = build(gateway);

    // Act
    const codes = [
      await verbs['device revoke']({ args: ['Pixel 9'], options: { force: true } }),
      await verbs['device grant']({ args: ['Pixel 9'], options: { use: true } }),
      await verbs['device grant']({ args: ['Pixel 9', 'terminal'], options: { use: 'yes' } }),
      await verbs['device ls']({ args: ['extra'], options: {} }),
    ];

    // Assert
    expect(codes).toEqual([1, 1, 1, 1]);
    expect(errors).toEqual([
      "error: unknown option '--force'\n",
      "error: missing required argument 'capability'\n",
      "error: option '--use' takes no value\n",
      "error: too many arguments for 'ls'. Expected 0 arguments but got 1.\n",
    ]);
    expect(gateway.revoked).toEqual([]);
    expect(gateway.changed).toBeUndefined();
  });
});
