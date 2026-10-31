import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { AUDIT_DEFAULT_LIMIT, AUDIT_EVENTS, type AuditRecord, type AuditView } from '@ferretry/protocol';
import { Command } from 'commander';
import { registerAuditCommands } from '../../../src/lib/audit/commands';
import { AuditController } from '../../../src/lib/audit/controller';
import { AUDIT_PATH, ProtocolAuditGateway } from '../../../src/lib/audit/gateway';
import type { IAuditGateway, IAuditOutput } from '../../../src/lib/audit/ports';
import { describeActor, localTime, renderAudit, renderAuditRecord } from '../../../src/lib/audit/render';

let originalZone: string | undefined;
beforeAll(() => {
  originalZone = process.env.TZ;
  process.env.TZ = 'UTC';
});
afterAll(() => {
  if (originalZone === undefined) delete process.env.TZ;
  else process.env.TZ = originalZone;
});

const record = (overrides: Partial<AuditRecord> = {}): AuditRecord => ({
  at: '2026-10-13T09:05:07.000Z',
  event: 'device.paired',
  actor: { kind: 'host' },
  outcome: 'succeeded',
  ...overrides,
});

const view = (overrides: Partial<AuditView> = {}): AuditView => ({
  records: [record({ event: 'terminal.opened' })],
  kept: [record()],
  keptTotal: 1,
  unreadable: 0,
  ...overrides,
});

class RecordingOutput implements IAuditOutput {
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

class FakeGateway implements IAuditGateway {
  readonly limits: number[] = [];
  readonly offsets: (number | undefined)[] = [];
  constructor(private readonly answer: AuditView = view()) {}
  async read(limit: number, keptOffset?: number): Promise<AuditView> {
    this.limits.push(limit);
    this.offsets.push(keptOffset);
    return this.answer;
  }
}

const controller = (answer?: AuditView) => {
  const gateway = new FakeGateway(answer);
  const out = new RecordingOutput();
  return { gateway, out, instance: new AuditController({ gateway, out }) };
};

describe('audit render', () => {
  it('should print local wall-clock time to the second', () => {
    // Act + Assert
    expect(localTime('2026-10-13T09:05:07.000Z')).toBe('2026-10-13 09:05:07');
  });

  it('should name every actor in plain words', () => {
    // Act + Assert
    expect(describeActor({ kind: 'host' })).toBe('this computer');
    expect(describeActor({ kind: 'warden' })).toBe('a supervising agent');
    expect(describeActor({ kind: 'anonymous' })).toBe('someone who is not paired');
    expect(describeActor({ kind: 'device', deviceId: 'dev-000001', deviceName: 'Pixel' })).toBe(
      'device “Pixel” (…000001)',
    );
    expect(describeActor({ kind: 'device', deviceId: 'dev-000001' })).toBe('device …000001');
    expect(describeActor({ kind: 'device' })).toBe('a paired device');
  });

  it('should have a human sentence for every event the log can hold', () => {
    // Act
    const lines = AUDIT_EVENTS.map(event => renderAuditRecord(record({ event })));

    // Assert
    for (const line of lines) expect(line).toMatch(/^2026-10-13 09:05:07 {2}[A-Z]/u);
    expect(lines.join('\n')).toContain('A device’s access expired');
    expect(lines.join('\n')).toContain('Passkey confirmation failed');
    expect(lines.join('\n')).not.toContain('Password confirmation');
    expect(lines.join('\n')).toContain('A secret was used');
    for (const phrase of [
      'A catalog share code was made',
      'A catalog share code was ended',
      'A person who reads shared catalogs was removed',
      'One browser of a person who reads shared catalogs was removed',
      'A shared catalog was taken away from a person',
      "A share code made for one person was used by another person's browser",
    ])
      expect(lines.join('\n')).toContain(phrase);
  });

  it('should show who, the outcome and what it was done to', () => {
    // Act
    const line = renderAuditRecord(
      record({
        event: 'pairing.refused',
        actor: { kind: 'device', deviceId: 'd1', deviceName: 'Pixel' },
        subject: 'code-7',
        outcome: 'refused',
      }),
    );

    // Assert
    expect(line).toBe('2026-10-13 09:05:07  A pairing attempt was refused (code-7)  by device “Pixel” (d1)  refused');
  });

  it('should never let a device name read as a fixed actor', () => {
    // Act
    const forged = describeActor({ kind: 'device', deviceId: 'dev-abcdef', deviceName: 'this computer' });

    // Assert
    expect(forged).not.toBe(describeActor({ kind: 'host' }));
    expect(forged).toBe('device “this computer” (…abcdef)');
  });

  it('should show the facts a record carries, in a stable order', () => {
    // Act
    const line = renderAuditRecord(
      record({ event: 'terminal.input', subject: 'term-1', detail: { repeats: 4, carrier: 'relay' } }),
    );

    // Assert
    expect(line.endsWith('  [carrier=relay repeats=4]')).toBe(true);
    expect(renderAuditRecord(record({ detail: {} }))).not.toContain('[');
  });

  it('should say plainly when nothing has been recorded', () => {
    // Act + Assert
    expect(renderAudit(view({ records: [], kept: [], keptTotal: 0 }))).toBe('no security events have been recorded');
  });

  it('should show the security changes first, apart from the activity, however much activity there is', () => {
    // Arrange
    const activity = Array.from({ length: 200 }, () => record({ event: 'pairing.code-minted' }));

    // Act
    const lines = renderAudit(view({ records: activity })).split('\n');

    // Assert
    expect(lines[0]).toBe('Security changes — who may reach this machine (all of them):');
    expect(lines[1]).toContain('A device was paired');
    expect(lines[3]).toBe('Recent activity:');
    expect(lines).toHaveLength(204);
  });

  it('should say how many older security changes there are and how to see them', () => {
    // Act
    const text = renderAudit(view({ keptTotal: 5 }), 2);
    const empty = renderAudit(view({ kept: [], keptTotal: 3, records: [] }), 3);

    // Assert
    expect(text).toContain('Security changes — who may reach this machine (3–3 of 5):');
    expect(text).toContain('  … 2 older — run with --kept-skip 3 to see them');
    expect(empty).toContain('  none on this page');
    expect(empty).toContain('Recent activity:\n  none');
  });

  it('should warn loudly at the end when lines could not be read', () => {
    // Act
    const text = renderAudit(view({ unreadable: 3 }));

    // Assert
    expect(text.split('\n').at(-1)).toBe('! 3 lines of the log could not be read — the history has gaps');
    expect(renderAudit(view({ unreadable: 1 }))).toContain('1 line of the log could not be read');
  });

  it('should not warn when the log is whole', () => {
    // Act + Assert
    expect(renderAudit(view())).not.toContain('could not be read');
  });
});

describe('audit controller', () => {
  it('should pass the default limit when none is given', async () => {
    // Arrange
    const { gateway, instance, out } = controller();

    // Act
    await instance.show({});

    // Assert
    expect(gateway.limits).toEqual([AUDIT_DEFAULT_LIMIT]);
    expect(out.messages[0]).toContain('A device was paired');
  });

  it('should pass --limit through', async () => {
    // Arrange
    const { gateway, instance } = controller();

    // Act
    await instance.show({ limit: '7' });

    // Assert
    expect(gateway.limits).toEqual([7]);
  });

  it('should pass --kept-skip through, and refuse one that is not a whole number', async () => {
    // Arrange
    const { gateway, instance } = controller();
    const refused = controller();

    // Act
    await instance.show({ keptSkip: '50' });
    await instance.show({});
    await refused.instance.show({ keptSkip: '-1' });

    // Assert
    expect(gateway.offsets).toEqual([50, 0]);
    expect(refused.gateway.limits).toEqual([]);
    expect(refused.out.exitCode).toBe(1);
    expect(refused.out.errors[0]).toContain('--kept-skip must be a whole number');
  });

  it('should cap --limit at 200', async () => {
    // Arrange
    const { gateway, instance } = controller();

    // Act
    await instance.show({ limit: '5000' });

    // Assert
    expect(gateway.limits).toEqual([200]);
  });

  it.each(['0', '-3', 'abc', '1.5', ''])('should refuse the limit %p without calling the daemon', async raw => {
    // Arrange
    const { gateway, instance, out } = controller();

    // Act
    await instance.show({ limit: raw });

    // Assert
    expect(gateway.limits).toEqual([]);
    expect(out.exitCode).toBe(1);
    expect(out.errors[0]).toContain('--limit must be a whole number');
  });

  it('should print the raw view with --json', async () => {
    // Arrange
    const answer = view({ unreadable: 2 });
    const { instance, out } = controller(answer);

    // Act
    await instance.show({ json: true });

    // Assert
    expect(JSON.parse(out.messages[0] ?? '{}')).toEqual(answer);
  });

  it('should render the unreadable warning in the human listing', async () => {
    // Arrange
    const { instance, out } = controller(view({ unreadable: 2 }));

    // Act
    await instance.show({});

    // Assert
    expect(out.messages[0]).toContain('2 lines of the log could not be read');
  });
});

describe('audit gateway', () => {
  it('should read the audit path with the limit in the query', async () => {
    // Arrange
    const seen: string[] = [];
    const client = {
      request: async (path: string) => {
        seen.push(path);
        return view();
      },
    };

    // Act
    const answer = await new ProtocolAuditGateway(client as never).read(25);
    await new ProtocolAuditGateway(client as never).read(25, 0);
    await new ProtocolAuditGateway(client as never).read(25, 40);

    // Assert
    expect(seen).toEqual([`${AUDIT_PATH}?limit=25`, `${AUDIT_PATH}?limit=25`, `${AUDIT_PATH}?limit=25&keptOffset=40`]);
    expect(answer.records).toHaveLength(1);
  });
});

describe('audit commands', () => {
  it('should mount `audit` on the daemon group and pass its flags', async () => {
    // Arrange
    const program = new Command();
    program.command('daemon').description('manage the daemon');
    const { gateway, instance } = controller();
    registerAuditCommands(program, () => instance);

    // Act
    await program.parseAsync(['daemon', 'audit', '--limit', '9', '--kept-skip', '4', '--json'], { from: 'user' });

    // Assert
    expect(gateway.limits).toEqual([9]);
    expect(gateway.offsets).toEqual([4]);
  });

  it('should fail at startup when the daemon group is missing', () => {
    // Act + Assert
    expect(() => registerAuditCommands(new Command(), () => controller().instance)).toThrow(
      'the daemon command group must be registered',
    );
  });
});
