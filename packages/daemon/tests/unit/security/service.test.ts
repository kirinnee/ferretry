import { describe, it } from 'bun:test';
import {
  DEFAULT_SECURITY_SETTINGS,
  SECURITY_SETTING_BOUNDS,
  SECURITY_SETTING_FIELDS,
  type SecuritySettings,
  type SecuritySettingsPatch,
  SecuritySettingsPatchSchema,
  widensSecurity,
} from '@ferretry/protocol';
import should from 'should';
import type { GrantAuditEntry } from '../../../src/lib/grants/index.ts';
import {
  DAMAGED_SECURITY_SETTINGS,
  type SecurityCaller,
  SecuritySettingsService,
  type StoredSecuritySettings,
} from '../../../src/lib/security/index.ts';

/**
 * The machine's security settings (`docs/design/zero-trust.md` B6): tighten from anywhere, loosen
 * only at the machine, fail closed on damage, and leave a record of every change.
 */
const AT_MS = Date.parse('2026-10-01T12:00:00.000Z');
const AT = new Date(AT_MS).toISOString();
const COMMAND = 'fy daemon security set <field> <value>';

const REMOTE: SecurityCaller = { hostLocal: false, actor: 'device:phone' };
const HOST: SecurityCaller = { hostLocal: true, actor: 'admin-cli' };

/** A tight machine, so every field has room to loosen AND to tighten. */
const MIDDLE: SecuritySettings = {
  stepUpWindowMinutes: 30,
  deviceKeyRotationDays: 40,
  presenceOnOpen: true,
  presenceValidityHours: 12,
  idleExpiryDays: 40,
};

interface World {
  readonly stored?: StoredSecuritySettings;
  /** Makes the read throw this, standing in for an unreadable document. */
  readonly unreadable?: unknown;
  readonly devicesIdleLongerThan?: (days: number) => number;
  readonly withoutCounter?: boolean;
}

function build(world: World = {}) {
  let document = world.stored;
  const writes: StoredSecuritySettings[] = [];
  const audited: GrantAuditEntry[] = [];
  const announced: SecuritySettings[] = [];
  const asked: number[] = [];
  const service = new SecuritySettingsService({
    document: {
      read: async () => {
        if (world.unreadable !== undefined) throw world.unreadable;
        return document;
      },
      write: async stored => {
        writes.push(stored);
        document = stored;
      },
    },
    audit: {
      record: async entry => {
        audited.push(entry);
      },
      recent: async () => ({ entries: [], unreadable: 0, truncated: false }),
    },
    clock: { nowMs: () => AT_MS },
    widenCommand: COMMAND,
    changed: settings => {
      announced.push(settings);
    },
    ...(world.withoutCounter === true
      ? {}
      : {
          devicesIdleLongerThan:
            world.devicesIdleLongerThan ??
            (days => {
              asked.push(days);
              return 3;
            }),
        }),
  });
  return { service, writes, audited, announced, asked };
}

async function ready(world: World = {}) {
  const built = build({ stored: { settings: MIDDLE, updatedAt: '2026-09-01T00:00:00.000Z' }, ...world });
  await built.service.refresh();
  built.announced.length = 0;
  return built;
}

describe('reading the settings document', () => {
  it('should read as the strictest reading until the first refresh', () => {
    // Enforcement is synchronous, so what it sees before the document is read must fail closed.
    // Arrange
    const { service } = build();

    // Act + Assert
    should(service.current()).deepEqual(DAMAGED_SECURITY_SETTINGS);
    should(service.view(HOST).source).equal('damaged');
  });

  it('should use the defaults, and say so, when the document was never written', async () => {
    // Arrange
    const { service, announced } = build();

    // Act
    const sentence = await service.refresh();

    // Assert
    should(sentence).be.undefined();
    should(service.current()).deepEqual(DEFAULT_SECURITY_SETTINGS);
    const view = service.view(HOST);
    should(view.source).equal('defaults');
    should(view).not.have.property('updatedAt');
    should(announced).deepEqual([DEFAULT_SECURITY_SETTINGS]);
  });

  it('should use the stored settings and report when they were written', async () => {
    // Arrange
    const { service } = build({ stored: { settings: MIDDLE, updatedAt: '2026-09-01T00:00:00.000Z' } });

    // Act
    const sentence = await service.refresh();

    // Assert
    should(sentence).be.undefined();
    should(service.current()).deepEqual(MIDDLE);
    should(service.view(REMOTE)).deepEqual({
      settings: MIDDLE,
      source: 'document',
      mayWiden: false,
      widenCommand: COMMAND,
      updatedAt: '2026-09-01T00:00:00.000Z',
    });
  });

  it('should tell the caller whether they may widen, from where they arrived', async () => {
    // Arrange
    const { service } = await ready();

    // Act + Assert
    should(service.view(HOST).mayWiden).be.true();
    should(service.view(REMOTE).mayWiden).be.false();
  });
});

describe('a damaged settings document', () => {
  it('should fail closed with a sentence, never throw, and keep serving on the strict reading', async () => {
    // A corrupted file must not quietly turn presence-on-open off.
    // Arrange
    const { service, announced } = build({ unreadable: new Error('/state/security.json is not valid JSON') });

    // Act
    const sentence = await service.refresh();

    // Assert
    should(sentence).match(/\/state\/security\.json is not valid JSON/u);
    should(sentence).match(/passkey on opening/u);
    should(service.current()).deepEqual(DAMAGED_SECURITY_SETTINGS);
    should(service.view(HOST)).containDeep({ source: 'damaged' });
    should(announced).deepEqual([DAMAGED_SECURITY_SETTINGS]);
  });

  it('should read a thrown non-error as its text', async () => {
    // Arrange
    const { service } = build({ unreadable: 'disk gone' });

    // Act
    const sentence = await service.refresh();

    // Assert
    should(sentence).match(/disk gone/u);
  });

  it('should read as a confirmation every time, a passkey on opening and the shortest periods', () => {
    // Act + Assert — and the idle period deliberately stays the default: unpairing cannot be undone.
    should(DAMAGED_SECURITY_SETTINGS).deepEqual({
      stepUpWindowMinutes: 0,
      deviceKeyRotationDays: SECURITY_SETTING_BOUNDS.deviceKeyRotationDays.min,
      presenceOnOpen: true,
      presenceValidityHours: SECURITY_SETTING_BOUNDS.presenceValidityHours.min,
      idleExpiryDays: DEFAULT_SECURITY_SETTINGS.idleExpiryDays,
    });
  });

  it('should refuse a remote change as unavailable and write nothing', async () => {
    // Arrange
    const { service, writes, audited } = build({ unreadable: new Error('bad') });
    await service.refresh();

    // Act
    const outcome = await service.patch({ idleExpiryDays: 5 }, REMOTE);

    // Assert
    should(outcome).deepEqual({ ok: false, refusal: 'unavailable' });
    should(writes).be.empty();
    should(audited).be.empty();
    should(service.current()).deepEqual(DAMAGED_SECURITY_SETTINGS);
  });

  it('should let the machine replace it, whole, and then read as the document', async () => {
    // Arrange
    const { service, writes, audited } = build({ unreadable: new Error('bad') });
    await service.refresh();

    // Act
    const outcome = await service.patch({ presenceOnOpen: false }, HOST);

    // Assert — the host's loosening is judged against the strict reading it replaces.
    should(outcome.ok).be.true();
    should(writes).have.length(1);
    should(writes[0]?.settings).deepEqual({ ...DAMAGED_SECURITY_SETTINGS, presenceOnOpen: false });
    should(service.view(HOST).source).equal('document');
    should(audited).have.length(1);
  });
});

describe('what each bound accepts', () => {
  it('should accept every numeric bound at both edges and refuse one past, at the patch schema', () => {
    // A value outside the bounds is refused, never clamped.
    for (const [field, { min, max }] of Object.entries(SECURITY_SETTING_BOUNDS)) {
      for (const value of [min, max])
        should(SecuritySettingsPatchSchema.safeParse({ [field]: value }).success).be.true();
      for (const value of [min - 1, max + 1])
        should(SecuritySettingsPatchSchema.safeParse({ [field]: value }).success).be.false();
    }
  });

  it('should apply a value sitting exactly on an edge, as the host', async () => {
    // Arrange
    const { service } = await ready();

    // Act
    for (const [field, { min, max }] of Object.entries(SECURITY_SETTING_BOUNDS)) {
      await service.patch({ [field]: max } as SecuritySettingsPatch, HOST);
      should(service.current()[field as keyof typeof SECURITY_SETTING_BOUNDS]).equal(max);
      await service.patch({ [field]: min } as SecuritySettingsPatch, HOST);
      should(service.current()[field as keyof typeof SECURITY_SETTING_BOUNDS]).equal(min);
    }
  });
});

describe('loosening, field by field', () => {
  /** One loosening per field, from MIDDLE. */
  const WIDENING: readonly SecuritySettingsPatch[] = [
    { stepUpWindowMinutes: 31 },
    { deviceKeyRotationDays: 41 },
    { presenceOnOpen: false },
    { presenceValidityHours: 13 },
    { idleExpiryDays: 41 },
  ];

  it('should cover every field with a widening case', () => {
    should(WIDENING.map(patch => Object.keys(patch)[0]).sort()).deepEqual([...SECURITY_SETTING_FIELDS].sort());
  });

  for (const patch of WIDENING) {
    const [field] = Object.keys(patch) as [keyof SecuritySettings];

    it(`should refuse widening ${field} from a device, naming the field, and change nothing`, async () => {
      // Arrange
      const { service, writes, audited } = await ready();

      // Act
      const outcome = await service.patch(patch, REMOTE);

      // Assert
      should(outcome).deepEqual({ ok: false, refusal: 'widen-remote', fields: [field] });
      should(service.current()).deepEqual(MIDDLE);
      should(writes).be.empty();
      should(audited).be.empty();
    });

    it(`should let the machine widen ${field}`, async () => {
      // Arrange
      const { service, writes } = await ready();

      // Act
      const outcome = await service.patch(patch, HOST);

      // Assert
      should(outcome.ok).be.true();
      should(service.current()).deepEqual({ ...MIDDLE, ...patch });
      should(writes).have.length(1);
    });
  }

  it('should agree with the protocol about which direction loosens', () => {
    for (const patch of WIDENING) {
      const [field] = Object.keys(patch) as [keyof SecuritySettings];
      should(widensSecurity(field, MIDDLE[field] as never, patch[field] as never)).be.true();
    }
  });
});

describe('tightening', () => {
  const NARROWING: readonly SecuritySettingsPatch[] = [
    { stepUpWindowMinutes: 0 },
    { deviceKeyRotationDays: 7 },
    { presenceValidityHours: 1 },
    { idleExpiryDays: 1 },
  ];

  it('should accept every narrowing from a device', async () => {
    for (const patch of NARROWING) {
      // Arrange
      const { service } = await ready();

      // Act
      const outcome = await service.patch(patch, REMOTE);

      // Assert
      should(outcome.ok).be.true();
      should(service.current()).deepEqual({ ...MIDDLE, ...patch });
    }
  });

  it('should accept turning the passkey on opening ON from a device', async () => {
    // Arrange
    const { service } = await ready({ stored: { settings: { ...MIDDLE, presenceOnOpen: false }, updatedAt: AT } });

    // Act
    const outcome = await service.patch({ presenceOnOpen: true }, REMOTE);

    // Assert
    should(outcome.ok).be.true();
    should(service.current().presenceOnOpen).be.true();
  });

  it('should accept restating the current value from a device, as nothing widens', async () => {
    // Arrange
    const { service, writes, audited } = await ready();

    // Act
    const outcome = await service.patch({ idleExpiryDays: MIDDLE.idleExpiryDays }, REMOTE);

    // Assert — recorded as an attempt, written as nothing.
    should(outcome.ok).be.true();
    should(writes).be.empty();
    should(audited).have.length(1);
  });
});

describe('a mixed request', () => {
  it('should be refused whole: no field applied, nothing written, nothing audited', async () => {
    // A narrowing and a loosening in one request take neither half.
    // Arrange
    const { service, writes, audited, announced } = await ready();

    // Act
    const outcome = await service.patch(
      { idleExpiryDays: 5, presenceValidityHours: 24, stepUpWindowMinutes: 0 },
      REMOTE,
    );

    // Assert
    should(outcome).deepEqual({ ok: false, refusal: 'widen-remote', fields: ['presenceValidityHours'] });
    should(service.current()).deepEqual(MIDDLE);
    should(writes).be.empty();
    should(audited).be.empty();
    should(announced).be.empty();
  });

  it('should name every loosened field, in the declared order', async () => {
    // Arrange
    const { service } = await ready();

    // Act
    const outcome = await service.patch({ idleExpiryDays: 90, stepUpWindowMinutes: 60 }, REMOTE);

    // Assert
    should(outcome).deepEqual({
      ok: false,
      refusal: 'widen-remote',
      fields: ['stepUpWindowMinutes', 'idleExpiryDays'],
    });
  });

  it('should let the machine make the same mixed request, both halves', async () => {
    // Arrange
    const { service } = await ready();

    // Act
    const outcome = await service.patch({ idleExpiryDays: 5, presenceValidityHours: 24 }, HOST);

    // Assert
    should(outcome.ok).be.true();
    should(service.current()).deepEqual({ ...MIDDLE, idleExpiryDays: 5, presenceValidityHours: 24 });
  });
});

describe('the record of a change', () => {
  it('should record each field with its old and new value, who asked, and when', async () => {
    // Arrange
    const { service, audited, writes } = await ready();

    // Act
    await service.patch({ idleExpiryDays: 10, presenceOnOpen: true, stepUpWindowMinutes: 0 }, REMOTE);

    // Assert
    should(audited).deepEqual([
      {
        actor: 'device:phone',
        at: AT,
        changes: ['security.stepUpWindowMinutes=30->0', 'security.idleExpiryDays=40->10'],
      },
    ]);
    should(writes[0]).deepEqual({ settings: { ...MIDDLE, idleExpiryDays: 10, stepUpWindowMinutes: 0 }, updatedAt: AT });
  });

  it('should record the old and new value of a boolean as text', async () => {
    // Arrange
    const { service, audited } = await ready();

    // Act
    await service.patch({ presenceOnOpen: false }, HOST);

    // Assert
    should(audited[0]?.changes).deepEqual(['security.presenceOnOpen=true->false']);
    should(audited[0]?.actor).equal('admin-cli');
  });

  it('should record a request that changed nothing, with no changes, and write nothing', async () => {
    // An attempt is part of the history.
    // Arrange
    const { service, audited, writes, announced } = await ready();

    // Act
    const outcome = await service.patch({ ...MIDDLE }, HOST);

    // Assert
    should(outcome.ok).be.true();
    should(audited).deepEqual([{ actor: 'admin-cli', at: AT, changes: [] }]);
    should(writes).be.empty();
    should(announced).be.empty();
  });

  it('should answer with the view the caller is entitled to, carrying the time of the write', async () => {
    // Arrange
    const { service } = await ready();

    // Act
    const outcome = await service.patch({ idleExpiryDays: 10 }, REMOTE);

    // Assert
    if (!outcome.ok) throw new Error('expected the change to be accepted');
    should(outcome.change.view).deepEqual({
      settings: { ...MIDDLE, idleExpiryDays: 10 },
      source: 'document',
      mayWiden: false,
      widenCommand: COMMAND,
      updatedAt: AT,
    });
  });

  it('should keep the old write time when nothing was written', async () => {
    // Arrange
    const { service } = await ready();

    // Act
    const outcome = await service.patch({ idleExpiryDays: MIDDLE.idleExpiryDays }, HOST);

    // Assert
    if (!outcome.ok) throw new Error('expected the change to be accepted');
    should(outcome.change.view.updatedAt).equal('2026-09-01T00:00:00.000Z');
  });
});

describe('what enforces a setting hears about it', () => {
  it('should call the changed callback with the new settings after a change, and only then', async () => {
    // Arrange
    const { service, announced } = await ready();

    // Act
    await service.patch({ idleExpiryDays: 10 }, REMOTE);
    await service.patch({ idleExpiryDays: 10 }, REMOTE);
    await service.patch({ presenceOnOpen: false }, REMOTE);

    // Assert — the second request changed nothing, and the third was refused.
    should(announced).deepEqual([{ ...MIDDLE, idleExpiryDays: 10 }]);
  });

  it('should work with no callback at all', async () => {
    // Arrange
    const service = new SecuritySettingsService({
      document: { read: async () => undefined, write: async () => {} },
      audit: { record: async () => {}, recent: async () => ({ entries: [], unreadable: 0, truncated: false }) },
      clock: { nowMs: () => AT_MS },
      widenCommand: COMMAND,
    });

    // Act
    await service.refresh();
    const outcome = await service.patch({ idleExpiryDays: 1 }, REMOTE);

    // Assert — and with no counter either, a shortening reports none expiring.
    should(outcome.ok).be.true();
    if (outcome.ok) should(outcome.change.devicesExpiring).equal(0);
  });
});

describe('devices that an idle period expires', () => {
  it('should count them, for the new period, only when it shortens', async () => {
    // Arrange
    const { service, asked } = await ready();

    // Act
    const shortened = await service.patch({ idleExpiryDays: 10 }, REMOTE);
    const unchanged = await service.patch({ idleExpiryDays: 10 }, REMOTE);
    const lengthened = await service.patch({ idleExpiryDays: 60 }, HOST);
    const other = await service.patch({ stepUpWindowMinutes: 0 }, REMOTE);

    // Assert
    should(shortened.ok && shortened.change.devicesExpiring).equal(3);
    should(unchanged.ok && unchanged.change.devicesExpiring).equal(0);
    should(lengthened.ok && lengthened.change.devicesExpiring).equal(0);
    should(other.ok && other.change.devicesExpiring).equal(0);
    should(asked).deepEqual([10]);
  });

  it('should report none when nothing can count them', async () => {
    // Arrange
    const { service } = await ready({ withoutCounter: true });

    // Act
    const outcome = await service.patch({ idleExpiryDays: 1 }, REMOTE);

    // Assert
    should(outcome.ok && outcome.change.devicesExpiring).equal(0);
  });
});

describe('concurrent changes', () => {
  it('should serialise, so two that read the old value cannot drop each other', async () => {
    // Arrange — a document that yields before every write, so an unserialised pair would interleave.
    let document: StoredSecuritySettings | undefined = { settings: MIDDLE, updatedAt: AT };
    const service = new SecuritySettingsService({
      document: {
        read: async () => document,
        write: async stored => {
          await new Promise(resolve => setTimeout(resolve, 5));
          document = stored;
        },
      },
      audit: { record: async () => {}, recent: async () => ({ entries: [], unreadable: 0, truncated: false }) },
      clock: { nowMs: () => AT_MS },
      widenCommand: COMMAND,
    });
    await service.refresh();

    // Act
    const [first, second] = await Promise.all([
      service.patch({ idleExpiryDays: 10 }, REMOTE),
      service.patch({ stepUpWindowMinutes: 5 }, REMOTE),
    ]);

    // Assert — both fields survive, in the document and in force.
    should(first.ok && second.ok).be.true();
    should(service.current()).deepEqual({ ...MIDDLE, idleExpiryDays: 10, stepUpWindowMinutes: 5 });
    should(document?.settings).deepEqual({ ...MIDDLE, idleExpiryDays: 10, stepUpWindowMinutes: 5 });
  });

  it('should keep serving after one change fails to write', async () => {
    // Arrange
    let failures = 1;
    const service = new SecuritySettingsService({
      document: {
        read: async () => ({ settings: MIDDLE, updatedAt: AT }),
        write: async () => {
          if (failures-- > 0) throw new Error('disk full');
        },
      },
      audit: { record: async () => {}, recent: async () => ({ entries: [], unreadable: 0, truncated: false }) },
      clock: { nowMs: () => AT_MS },
      widenCommand: COMMAND,
    });
    await service.refresh();

    // Act
    const failed = service.patch({ idleExpiryDays: 10 }, REMOTE);
    const next = service.patch({ idleExpiryDays: 11 }, REMOTE);

    // Assert — the failure reaches ITS caller, not the next one, and nothing changed in force for it.
    await should(failed).be.rejectedWith(/disk full/u);
    should((await next).ok).be.true();
    should(service.current().idleExpiryDays).equal(11);
  });
});
