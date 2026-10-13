import { describe, expect, it } from 'bun:test';
import {
  DEFAULT_SECURITY_SETTINGS,
  SECURITY_SETTING_BOUNDS,
  type SecuritySettings,
  type SecuritySettingsChange,
  type SecuritySettingsPatch,
  type SecuritySettingsView,
} from '@ferretry/protocol';
import { Command } from 'commander';
import { registerSecurityCommands } from '../../../src/lib/security/commands';
import { SecurityController } from '../../../src/lib/security/controller';
import { ProtocolSecurityGateway, SECURITY_PATH } from '../../../src/lib/security/gateway';
import type { ISecurityGateway, ISecurityOutput } from '../../../src/lib/security/ports';
import { formatSettingValue, renderSecurity, renderSecurityChange } from '../../../src/lib/security/render';

const view = (overrides: Partial<SecuritySettingsView> = {}, settings: Partial<SecuritySettings> = {}) =>
  ({
    settings: { ...DEFAULT_SECURITY_SETTINGS, ...settings },
    source: 'defaults',
    mayWiden: true,
    widenCommand: 'fy daemon security set <field> <value>',
    ...overrides,
  }) satisfies SecuritySettingsView;

const change = (devicesExpiring = 0, settings: Partial<SecuritySettings> = {}): SecuritySettingsChange => ({
  view: view({ source: 'document' }, settings),
  devicesExpiring,
});

class RecordingOutput implements ISecurityOutput {
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

class FakeGateway implements ISecurityGateway {
  patch: SecuritySettingsPatch | undefined;

  constructor(
    private readonly current: SecuritySettingsView = view(),
    private readonly next: SecuritySettingsChange = change(),
  ) {}

  async read(): Promise<SecuritySettingsView> {
    return this.current;
  }

  async change(patch: SecuritySettingsPatch): Promise<SecuritySettingsChange> {
    this.patch = patch;
    return this.next;
  }
}

const controller = (gateway: ISecurityGateway) => {
  const out = new RecordingOutput();
  return { out, instance: new SecurityController({ gateway, out, clientName: 'fy' }) };
};

describe('the security report', () => {
  it('should show every value with its bounds', () => {
    // Act
    const rendered = renderSecurity(view(), 'fy');

    // Assert
    expect(rendered).toContain('stepUpWindowMinutes');
    for (const [field, { min, max }] of Object.entries(SECURITY_SETTING_BOUNDS))
      expect(rendered).toMatch(new RegExp(`${field}\\s+\\d+\\s+\\(${String(min)}-${String(max)}\\)`, 'u'));
    expect(rendered).toMatch(/presenceOnOpen\s+off\s+\(on \| off\)/u);
    expect(rendered).toContain('fy daemon security set <field> <value>');
  });

  it('should say where the values came from, and when they last changed', () => {
    // Act + Assert
    expect(renderSecurity(view({ source: 'defaults' }), 'fy')).toContain('source: defaults');
    const document = renderSecurity(view({ source: 'document', updatedAt: '2026-10-13T10:00:00.000Z' }), 'fy');
    expect(document).toContain('source: the settings document');
    expect(document).toContain('updated: 2026-10-13T10:00:00.000Z');
  });

  it('should say a damaged document is damaged rather than present the fail-closed values as chosen', () => {
    // Act
    const rendered = renderSecurity(view({ source: 'damaged' }, { presenceOnOpen: true }), 'fy');

    // Assert
    expect(rendered).toContain('DAMAGED');
    expect(rendered).toMatch(/presenceOnOpen\s+on/u);
  });

  it('should format the switch as on/off and numbers as themselves', () => {
    // Act + Assert
    expect(formatSettingValue('presenceOnOpen', view().settings)).toBe('off');
    expect(formatSettingValue('presenceOnOpen', view({}, { presenceOnOpen: true }).settings)).toBe('on');
    expect(formatSettingValue('idleExpiryDays', view().settings)).toBe('30');
  });
});

describe('the change report', () => {
  it('should print the new value alone when no device is affected', () => {
    // Act + Assert
    expect(renderSecurityChange('idleExpiryDays', change(0, { idleExpiryDays: 14 }))).toBe('idleExpiryDays = 14');
  });

  it('should say how many devices a shortened idle period will unpair', () => {
    // Act
    const rendered = renderSecurityChange('idleExpiryDays', change(3, { idleExpiryDays: 1 }));

    // Assert
    expect(rendered).toContain('idleExpiryDays = 1');
    expect(rendered).toContain('3 paired device(s) will be unpaired at the next check');
  });
});

describe('reading the settings', () => {
  it('should print the report', async () => {
    // Arrange
    const { instance, out } = controller(new FakeGateway());

    // Act
    await instance.show({});

    // Assert
    expect(out.messages[0]).toContain('stepUpWindowMinutes');
  });

  it('should print the protocol document when asked', async () => {
    // Arrange
    const { instance, out } = controller(new FakeGateway());

    // Act
    await instance.show({ json: true });

    // Assert
    expect(JSON.parse(out.messages[0] ?? '{}')).toHaveProperty('source', 'defaults');
  });
});

describe('changing a setting', () => {
  it.each([
    ['stepUpWindowMinutes', '0', { stepUpWindowMinutes: 0 }],
    ['deviceKeyRotationDays', '45', { deviceKeyRotationDays: 45 }],
    ['presenceValidityHours', '+12', { presenceValidityHours: 12 }],
    ['idleExpiryDays', ' 7 ', { idleExpiryDays: 7 }],
    ['presenceOnOpen', 'on', { presenceOnOpen: true }],
    ['presenceOnOpen', 'TRUE', { presenceOnOpen: true }],
    ['presenceOnOpen', 'off', { presenceOnOpen: false }],
    ['presenceOnOpen', 'False', { presenceOnOpen: false }],
  ])('should send %s=%s as %j', async (field, value, expected) => {
    // Arrange
    const gateway = new FakeGateway();
    const { instance } = controller(gateway);

    // Act
    await instance.set(field, value);

    // Assert
    expect(gateway.patch).toEqual(expected);
  });

  it('should print the new value and the devices it will unpair', async () => {
    // Arrange
    const { instance, out } = controller(new FakeGateway(view(), change(2, { idleExpiryDays: 1 })));

    // Act
    await instance.set('idleExpiryDays', '1');

    // Assert
    expect(out.messages[0]).toContain('idleExpiryDays = 1');
    expect(out.messages[0]).toContain('2 paired device(s) will be unpaired at the next check');
    expect(out.exitCode).toBeUndefined();
  });

  it('should refuse a field that is not a setting without asking the daemon', async () => {
    // Arrange
    const gateway = new FakeGateway();
    const { instance, out } = controller(gateway);

    // Act
    await instance.set('lease', '5');

    // Assert
    expect(out.errors[0]).toContain('"lease" is not a security setting');
    expect(out.errors[0]).toContain('stepUpWindowMinutes');
    expect(out.exitCode).toBe(1);
    expect(gateway.patch).toBeUndefined();
  });

  it.each(['abc', '1.5', '', '1e3', 'on'])('should refuse %j as a number', async value => {
    // Arrange
    const gateway = new FakeGateway();
    const { instance, out } = controller(gateway);

    // Act
    await instance.set('idleExpiryDays', value);

    // Assert
    expect(out.errors[0]).toContain('takes a whole number');
    expect(out.exitCode).toBe(1);
    expect(gateway.patch).toBeUndefined();
  });

  it('should refuse a word that is not a switch', async () => {
    // Arrange
    const gateway = new FakeGateway();
    const { instance, out } = controller(gateway);

    // Act
    await instance.set('presenceOnOpen', 'maybe');

    // Assert
    expect(out.errors[0]).toContain('takes on, off, true or false');
    expect(out.exitCode).toBe(1);
    expect(gateway.patch).toBeUndefined();
  });

  it('should hand an out-of-bounds number to the daemon rather than judge it here', async () => {
    // The daemon owns the bounds and its refusal sentence is what the person should read.
    // Arrange
    const gateway = new FakeGateway();
    const { instance } = controller(gateway);

    // Act
    await instance.set('idleExpiryDays', '9999');

    // Assert
    expect(gateway.patch).toEqual({ idleExpiryDays: 9999 });
  });
});

describe('the verbs', () => {
  const mounted = (gateway: ISecurityGateway) => {
    const program = new Command();
    program.command('daemon').description('manage the daemon');
    const { instance, out } = controller(gateway);
    registerSecurityCommands(program, () => instance);
    return { program, out };
  };

  it('should refuse to mount before the daemon group exists', () => {
    // Act + Assert
    expect(() => registerSecurityCommands(new Command(), () => controller(new FakeGateway()).instance)).toThrow(
      'daemon command group must be registered',
    );
  });

  it('should read the report through the default subcommand', async () => {
    // Arrange
    const { program, out } = mounted(new FakeGateway());

    // Act
    await program.parseAsync(['daemon', 'security'], { from: 'user' });

    // Assert
    expect(out.messages[0]).toContain('stepUpWindowMinutes');
  });

  it('should print json with --json', async () => {
    // Arrange
    const { program, out } = mounted(new FakeGateway());

    // Act
    await program.parseAsync(['daemon', 'security', 'show', '--json'], { from: 'user' });

    // Assert
    expect(JSON.parse(out.messages[0] ?? '{}')).toHaveProperty('mayWiden', true);
  });

  it('should change a setting through `set <field> <value>`', async () => {
    // Arrange
    const gateway = new FakeGateway();
    const { program } = mounted(gateway);

    // Act
    await program.parseAsync(['daemon', 'security', 'set', 'presenceOnOpen', 'on'], { from: 'user' });

    // Assert
    expect(gateway.patch).toEqual({ presenceOnOpen: true });
  });

  it('should show examples in the set help', () => {
    // Arrange
    const { program } = mounted(new FakeGateway());
    const set = program.commands[0]?.commands.find(c => c.name() === 'security')?.commands.find(c => c.name() === 'set');

    // Act
    let help = '';
    set?.configureOutput({ writeOut: text => (help += text) });
    set?.outputHelp();

    // Assert
    expect(help).toContain('daemon security set presenceOnOpen on');
  });
});

describe('the gateway', () => {
  const recording = (answer: unknown) => {
    const calls: { path: string; init: RequestInit | undefined }[] = [];
    const client = {
      request: async (path: string, _schema: unknown, init?: RequestInit) => {
        calls.push({ path, init });
        return answer;
      },
    };
    return { calls, client: client as never };
  };

  it('should read the security path', async () => {
    // Arrange
    const { calls, client } = recording(view());

    // Act
    await new ProtocolSecurityGateway(client).read();

    // Assert
    expect(calls).toEqual([{ path: SECURITY_PATH, init: undefined }]);
  });

  it('should PATCH the validated body', async () => {
    // Arrange
    const { calls, client } = recording(change());

    // Act
    await new ProtocolSecurityGateway(client).change({ idleExpiryDays: 14 });

    // Assert
    expect(calls[0]?.path).toBe('/v1/security');
    expect(calls[0]?.init?.method).toBe('PATCH');
    expect(calls[0]?.init?.body).toBe(JSON.stringify({ idleExpiryDays: 14 }));
  });

  it('should refuse to send an empty change', async () => {
    // Arrange
    const { client } = recording(change());

    // Act + Assert
    await expect(new ProtocolSecurityGateway(client).change({})).rejects.toThrow();
  });
});
