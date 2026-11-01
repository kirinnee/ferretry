import { describe, it } from 'bun:test';
import { COPY_MAX_RULES, type InputTargetFacts, type PasteRule, type PasteRuleSettings } from '@ferretry/protocol';
import should from 'should';
import { type PasteRuleCaller, PasteRuleService, routeOf, SecureCopyError } from '../../../src/lib/index.ts';
import { FACTS } from '../input-requests/support.ts';

const OWNER: PasteRuleCaller = { kind: 'owner', actor: { kind: 'host' } };
const PHONE: PasteRuleCaller = { kind: 'owner', actor: { kind: 'device', deviceId: 'phone-1' } };
const AGENT: PasteRuleCaller = { kind: 'agent' };
const GH = { kind: 'command', program: 'gh' } as const;
/** A copy from the gh the daemon found on its PATH, in a folder no ferret can write. */
const GH_COPY = { ...GH, path: '/usr/bin/gh' } as const;
const VERCEL_TERMINAL = { kind: 'terminal', program: 'vercel' } as const;
const AT_VERCEL: InputTargetFacts = {
  ...FACTS,
  foreground: { ...FACTS.foreground, comm: 'vercel' },
  program: 'vercel',
};

const settle = async (): Promise<void> => {
  for (let tick = 0; tick < 10; tick += 1) await Promise.resolve();
};

function rules(options: { readonly unreadable?: boolean; readonly failWrites?: boolean } = {}) {
  const ms = { now: Date.parse('2026-10-31T12:00:00.000Z') };
  const stored: { rules: readonly PasteRule[] | undefined; settings?: PasteRuleSettings } = { rules: undefined };
  const warned: string[] = [];
  const disk = { failing: options.failWrites === true };
  let id = 0;
  const service = new PasteRuleService({
    store: {
      read: async () => {
        if (options.unreadable === true) throw new Error('damaged');
        return stored.rules === undefined
          ? undefined
          : { rules: stored.rules, settings: stored.settings ?? { allowProfileTargets: false } };
      },
      write: async next => {
        if (disk.failing) throw new Error('disk full');
        stored.rules = next.rules;
        stored.settings = next.settings;
      },
    },
    clock: { now: () => ms.now },
    ids: { ruleId: () => (++id).toString(16).padStart(32, '0') },
    warn: message => void warned.push(message),
  });
  return { service, stored, warned, ms, disk };
}

const refused = async (work: Promise<unknown> | (() => unknown)): Promise<SecureCopyError> => {
  const error = await Promise.resolve()
    .then(() => (typeof work === 'function' ? work() : work))
    .then(
      () => undefined,
      (thrown: unknown) => thrown,
    );
  should(error).be.instanceOf(SecureCopyError);
  return error as SecureCopyError;
};

describe('PasteRuleService: who may change the rules', () => {
  it('should let only the owner create, list or revoke a rule', async () => {
    const { service } = rules();
    await service.load();

    should((await refused(service.create(AGENT, { from: GH, to: VERCEL_TERMINAL }))).code).equal('forbidden');
    should((await refused(() => service.list(AGENT))).code).equal('forbidden');
    const rule = await service.create(PHONE, { from: GH, to: VERCEL_TERMINAL });
    should((await refused(service.revoke(AGENT, rule.id))).code).equal('forbidden');
    should(rule.createdBy).eql({ kind: 'device', deviceId: 'phone-1' });
  });

  it('should keep a rule in the store with its count and expiry, and take it back on revoke', async () => {
    const { service, stored } = rules();
    await service.load();

    const rule = await service.create(OWNER, {
      from: GH,
      to: VERCEL_TERMINAL,
      count: 3,
      expiresInSeconds: 3600,
      sessionId: 's1',
    });

    should(rule).match({ remaining: 3, used: 0, sessionId: 's1', expiresAt: '2026-10-31T13:00:00.000Z' });
    should(stored.rules).eql([rule]);
    await service.revoke(OWNER, rule.id);
    should(stored.rules).eql([]);
    should((await refused(service.revoke(OWNER, rule.id))).code).equal('not_found');
  });

  it('should refuse a rule past the cap', async () => {
    const { service } = rules();
    await service.load();
    for (let index = 0; index < COPY_MAX_RULES; index += 1)
      await service.create(OWNER, { from: GH, to: VERCEL_TERMINAL });

    should((await refused(service.create(OWNER, { from: GH, to: VERCEL_TERMINAL }))).code).equal('capacity');
  });

  it('should change nothing when the store cannot be written', async () => {
    const { service } = rules({ failWrites: true });
    await service.load();

    should((await refused(service.create(OWNER, { from: GH, to: VERCEL_TERMINAL }))).code).equal('unavailable');
    should(service.list(OWNER)).eql([]);
  });

  it('should read a damaged store as NO rules, say so once, and match nothing', async () => {
    const { service, warned } = rules({ unreadable: true });
    await service.load();

    should(service.list(OWNER)).eql([]);
    should(warned).have.length(1);
    should(service.reserve('s1', GH_COPY, AT_VERCEL)).be.undefined();
  });

  it('should match nothing before the store has been read', async () => {
    const { service, stored } = rules();
    stored.rules = [
      {
        id: 'a'.repeat(32),
        from: GH,
        to: VERCEL_TERMINAL,
        used: 0,
        createdAt: '2026-10-31T00:00:00.000Z',
        createdBy: { kind: 'host' },
      },
    ];

    should(service.reserve('s1', GH_COPY, AT_VERCEL)).be.undefined();
    await service.load();
    should(service.reserve('s1', GH_COPY, AT_VERCEL)).equal('a'.repeat(32));
  });
});

describe('PasteRuleService: matching a paste', () => {
  it("should never match a page field's value, which the agent could have typed there", async () => {
    const { service } = rules();
    await service.load();
    const page = { kind: 'browser', origin: 'https://github.com' } as const;
    await service.create(OWNER, { from: page, to: VERCEL_TERMINAL });

    should(service.reserve('s1', { ...page, editable: true }, AT_VERCEL)).be.undefined();
    should(service.reserve('s1', page, AT_VERCEL)).not.be.undefined();
  });

  it('should match a program only where the daemon found it, in a file no ferret could have swapped', async () => {
    const { service } = rules();
    await service.load();
    await service.create(OWNER, { from: GH, to: VERCEL_TERMINAL });

    should(service.reserve('s1', GH, AT_VERCEL)).be.undefined();
    should(
      service.reserve('s1', { ...GH, path: '/home/k/.local/bin/gh', replaceable: true }, AT_VERCEL),
    ).be.undefined();
    should(service.reserve('s1', GH_COPY, AT_VERCEL)).not.be.undefined();
  });

  it('should match only the program the copy came from and the program reading the terminal', async () => {
    const { service } = rules();
    await service.load();
    const rule = await service.create(OWNER, { from: GH, to: VERCEL_TERMINAL });

    should(service.reserve('s1', GH_COPY, AT_VERCEL)).equal(rule.id);
    should(service.reserve('s1', { kind: 'command', program: 'curl' }, AT_VERCEL)).be.undefined();
    should(
      service.reserve('s1', GH_COPY, { ...FACTS, foreground: { ...FACTS.foreground, comm: 'zsh' }, program: 'zsh' }),
    ).be.undefined();
    should(service.reserve('s1', { kind: 'browser', origin: 'https://github.com' }, AT_VERCEL)).be.undefined();
  });

  it('should never paste under a rule into a terminal whose program only ps names: the kernel must prove it', async () => {
    // Arrange — the ferret's shell renamed itself vercel (`printf vercel > /proc/$$/comm`): ps agrees, nothing is proved.
    const { service } = rules();
    await service.load();
    await service.create(OWNER, { from: GH, to: VERCEL_TERMINAL });
    const disguised = { ...AT_VERCEL, program: undefined } as InputTargetFacts;
    const provedOther = { ...AT_VERCEL, program: 'bash' } as InputTargetFacts;

    // Act / Assert
    should(service.reserve('s1', GH_COPY, disguised)).be.undefined();
    should(service.reserve('s1', GH_COPY, provedOther)).be.undefined();
  });

  it('should never paste under a rule into a proved program that reads key by key: it may relay them (L2)', async () => {
    const { service } = rules();
    await service.load();
    await service.create(OWNER, { from: GH, to: VERCEL_TERMINAL });

    for (const canonical of [false, undefined])
      should(service.reserve('s1', GH_COPY, { ...AT_VERCEL, canonical } as InputTargetFacts)).be.undefined();
    should(service.reserve('s1', GH_COPY, AT_VERCEL)).not.be.undefined();
  });

  it('should keep a session rule to its session, and a lapsed rule to nobody', async () => {
    const { service, ms } = rules();
    await service.load();
    await service.create(OWNER, { from: GH, to: VERCEL_TERMINAL, sessionId: 's1', expiresInSeconds: 60 });

    should(service.reserve('s2', GH_COPY, AT_VERCEL)).be.undefined();
    should(service.reserve('s1', GH_COPY, AT_VERCEL)).not.be.undefined();
    ms.now += 60_000;
    should(service.reserve('s1', GH_COPY, AT_VERCEL)).be.undefined();
    should(service.list(OWNER)).eql([]);
  });

  it('should never let a rule for the secret store match a terminal paste', async () => {
    const { service } = rules();
    await service.load();
    await service.create(OWNER, { from: GH, to: { kind: 'secret', name: 'VERCEL_TOKEN' } });

    should(service.reserve('s1', GH_COPY, AT_VERCEL)).be.undefined();
  });

  it('should let a rule for the secret store match only the exact secret it names', async () => {
    const { service } = rules();
    await service.load();
    const rule = await service.create(OWNER, { from: GH, to: { kind: 'secret', name: 'VERCEL_TOKEN' } });
    const into = (name: string) => ({ kind: 'secret', name, exists: false }) as InputTargetFacts;

    should(service.reserve('s1', GH_COPY, into('VERCEL_TOKEN_2'))).be.undefined();
    should(service.reserve('s1', GH_COPY, into('vercel_token'))).be.undefined();
    should(service.reserve('s1', GH_COPY, into('VERCEL_TOKEN'))).equal(rule.id);
  });

  it("should hand out a counted rule's last use once, give it back on release, and drop the rule once spent", async () => {
    const { service, stored } = rules();
    await service.load();
    const rule = await service.create(OWNER, { from: GH, to: VERCEL_TERMINAL, count: 1 });

    should(service.reserve('s1', GH_COPY, AT_VERCEL)).equal(rule.id);
    should(service.reserve('s1', GH_COPY, AT_VERCEL)).be.undefined();
    service.release(rule.id);
    should(service.reserve('s1', GH_COPY, AT_VERCEL)).equal(rule.id);
    service.spent(rule.id);
    should(service.reserve('s1', GH_COPY, AT_VERCEL)).be.undefined();
    await settle();
    should(stored.rules).eql([]);
    should(service.reserve('s1', GH_COPY, AT_VERCEL)).be.undefined();
  });

  it('should count uses of a rule with no count, and ignore a release or spend nobody reserved', async () => {
    const { service } = rules();
    await service.load();
    const rule = await service.create(OWNER, { from: GH, to: VERCEL_TERMINAL });

    service.spent(rule.id);
    service.release(rule.id);
    service.reserve('s1', GH_COPY, AT_VERCEL);
    service.spent(rule.id);
    await settle();

    should(service.list(OWNER)).match([{ id: rule.id, used: 1 }]);
    should(service.list(OWNER)[0]?.remaining).be.undefined();
  });
});

describe('PasteRuleService: the rest of the routes', () => {
  it('should match a page or clipboard copy by origin, into a page by origin', async () => {
    const { service } = rules();
    await service.load();
    const page = await service.create(OWNER, {
      from: { kind: 'clipboard', origin: 'https://github.com' },
      to: { kind: 'browser', origin: 'https://vercel.com' },
    });
    const field: InputTargetFacts = {
      kind: 'browser',
      pageId: 'p1',
      origin: 'https://vercel.com',
      secure: true,
      navigationId: 'n1',
      fields: [
        {
          fieldId: 'value',
          frameOrigin: 'https://vercel.com',
          frameId: 'f1',
          backendNodeId: 7,
          field: { tag: 'input', type: 'password' },
          box: { x: 0, y: 0, w: 10, h: 10 },
          visible: true,
        },
      ],
    };

    should(service.reserve('s1', { kind: 'clipboard', origin: 'https://github.com' }, field)).equal(page.id);
    should(service.reserve('s1', { kind: 'browser', origin: 'https://github.com' }, field)).be.undefined();
    should(
      service.reserve(
        's1',
        { kind: 'clipboard', origin: 'https://github.com' },
        { ...field, origin: 'https://evil.dev' },
      ),
    ).be.undefined();
    should(service.reserve('s1', { kind: 'clipboard', origin: 'https://github.com' }, AT_VERCEL)).be.undefined();
    const typed = await service.create(OWNER, {
      from: { kind: 'browser', origin: 'https://github.com' },
      to: { kind: 'browser', origin: 'https://vercel.com' },
    });
    should(service.reserve('s1', { kind: 'browser', origin: 'https://github.com' }, field)).equal(typed.id);
  });

  it('should keep two reservations of one rule apart', async () => {
    const { service } = rules();
    await service.load();
    const rule = await service.create(OWNER, { from: GH, to: VERCEL_TERMINAL, count: 2 });

    service.reserve('s1', GH_COPY, AT_VERCEL);
    service.reserve('s1', GH_COPY, AT_VERCEL);
    should(service.reserve('s1', GH_COPY, AT_VERCEL)).be.undefined();
    service.release(rule.id);
    should(service.reserve('s1', GH_COPY, AT_VERCEL)).equal(rule.id);
  });

  it('should word every kind of route', () => {
    should(
      routeOf({ kind: 'browser', origin: 'https://github.com' }, { kind: 'browser', origin: 'https://vercel.com' }),
    ).equal('text from https://github.com → a field on https://vercel.com');
    should(routeOf({ kind: 'clipboard', origin: 'https://github.com' }, { kind: 'secret', name: 'GH_TOKEN' })).equal(
      'the clipboard of https://github.com → the secret GH_TOKEN',
    );
  });
});

describe('PasteRuleService: what the security review found', () => {
  it('should keep a spent use spent when the store cannot be written, so a counted rule allows no more', async () => {
    const { service, disk } = rules();
    await service.load();
    const rule = await service.create(OWNER, { from: GH, to: VERCEL_TERMINAL, count: 1 });
    disk.failing = true;

    should(service.reserve('s1', GH_COPY, AT_VERCEL)).equal(rule.id);
    service.spent(rule.id);
    await settle();

    should(service.reserve('s1', GH_COPY, AT_VERCEL)).be.undefined();
    should(service.list(OWNER)).eql([]);
  });

  it("should not lose a spent use to an owner's change written at the same time", async () => {
    const { service, stored } = rules();
    await service.load();
    const rule = await service.create(OWNER, { from: GH, to: VERCEL_TERMINAL, count: 2 });

    service.reserve('s1', GH_COPY, AT_VERCEL);
    const adding = service.create(OWNER, { from: GH, to: { kind: 'terminal', program: 'fly' } });
    service.spent(rule.id);
    await adding;
    await settle();

    should(stored.rules?.find(candidate => candidate.id === rule.id)).match({ remaining: 1, used: 1 });
    should(stored.rules).have.length(2);
  });

  it('should hold every change until the store has been read, and refuse a listing before then', async () => {
    const { service, stored } = rules();
    stored.rules = [
      {
        id: 'a'.repeat(32),
        from: GH,
        to: VERCEL_TERMINAL,
        used: 0,
        createdAt: '2026-10-31T00:00:00.000Z',
        createdBy: { kind: 'host' },
      },
    ];

    should((await refused(() => service.list(OWNER))).code).equal('unavailable');
    const adding = service.create(OWNER, { from: GH, to: { kind: 'terminal', program: 'fly' } });
    await settle();
    should(stored.rules).have.length(1);
    await service.load();
    await adding;

    should(stored.rules).have.length(2);
  });
});

describe('PasteRuleService: the owner settings (profile targets)', () => {
  /** No proved program: only the daemon's own profile reading (`ObserveResult.profileProgram`) names one. */
  const IN_PROFILE = { ...AT_VERCEL, program: undefined } as InputTargetFacts;

  it('should hold profile targets off by default, and off again when the store cannot be read', async () => {
    const fresh = rules();
    await fresh.service.load();
    should(fresh.service.currentSettings(OWNER)).eql({ allowProfileTargets: false });
    const damaged = rules({ unreadable: true });
    await damaged.service.load();
    should(damaged.service.currentSettings(OWNER)).eql({ allowProfileTargets: false });
  });

  it('should keep the setting beside the rules, and let only the owner read or change it', async () => {
    const { service, stored } = rules();
    await service.load();
    await service.create(OWNER, { from: GH, to: VERCEL_TERMINAL });

    should(await service.changeSettings(OWNER, { allowProfileTargets: true })).eql({ allowProfileTargets: true });
    should(stored.settings).eql({ allowProfileTargets: true });
    should(stored.rules).have.length(1);
    should(() => service.currentSettings(AGENT)).throw(/only the owner/u);
    await should(service.changeSettings(AGENT, { allowProfileTargets: false })).be.rejectedWith(/only the owner/u);
    should(stored.settings).eql({ allowProfileTargets: true });
  });

  it('should match a program proved only through the profile when, and only when, the owner allowed it', async () => {
    const { service } = rules();
    await service.load();
    await service.create(OWNER, { from: GH, to: VERCEL_TERMINAL });

    should(service.reserve('s1', GH_COPY, IN_PROFILE, 'vercel')).be.undefined();
    await service.changeSettings(OWNER, { allowProfileTargets: true });
    should(service.reserve('s1', GH_COPY, IN_PROFILE, 'vercel')).not.be.undefined();
    // Still in line mode only, never another program's profile entry, and never with no profile reading at all.
    should(
      service.reserve('s1', GH_COPY, { ...IN_PROFILE, canonical: false } as InputTargetFacts, 'vercel'),
    ).be.undefined();
    should(service.reserve('s1', GH_COPY, IN_PROFILE, 'gh')).be.undefined();
    should(service.reserve('s1', GH_COPY, IN_PROFILE)).be.undefined();
  });

  it('should never let a profile program meet a rule for a password or code program, setting on or not (M1)', async () => {
    const { service } = rules();
    await service.load();
    await service.changeSettings(OWNER, { allowProfileTargets: true });
    for (const program of [
      'sudo',
      'su',
      'doas',
      'passwd',
      'sudoedit',
      'ssh',
      'scp',
      'vault',
      'Sudo',
      'SSH',
      'PassWd',
    ]) {
      await service.create(OWNER, { from: GH, to: { kind: 'terminal', program } });
      should(service.reserve('s1', GH_COPY, IN_PROFILE, program)).be.undefined();
    }
  });

  it('should leave the setting as it was when the store cannot save the change', async () => {
    const { service, stored, disk } = rules();
    await service.load();
    disk.failing = true;
    await should(service.changeSettings(OWNER, { allowProfileTargets: true })).be.rejectedWith(/could not save/u);
    should(service.currentSettings(OWNER)).eql({ allowProfileTargets: false });
    should(stored.settings).be.undefined();
  });
});

describe('PasteRuleService: a task plan’s pastes live in memory, the owner’s rules on disk', () => {
  const PLAN = 'b'.repeat(32);
  const FLY_TERMINAL = { kind: 'terminal', program: 'fly' } as const;
  const AT_FLY: InputTargetFacts = { ...AT_VERCEL, foreground: { ...FACTS.foreground, comm: 'fly' }, program: 'fly' };

  /** A store whose every write is counted, kept across a "restart" (a second service on the same store). */
  function counted() {
    const made = rules();
    const writes: { rules: readonly PasteRule[]; settings: PasteRuleSettings }[] = [];
    let id = 100;
    const restart = () =>
      new PasteRuleService({
        store: {
          read: async () =>
            made.stored.rules === undefined
              ? undefined
              : { rules: made.stored.rules, settings: made.stored.settings ?? { allowProfileTargets: false } },
          write: async next => {
            writes.push(next);
            made.stored.rules = next.rules;
            made.stored.settings = next.settings;
          },
        },
        clock: { now: () => made.ms.now },
        ids: { ruleId: () => (++id).toString(16).padStart(32, '0') },
        warn: () => undefined,
      });
    return { ...made, writes, restart };
  }

  it('should write nothing for a plan’s pastes, honour their uses, and forget them on a restart', async () => {
    const { writes, restart, ms } = counted();
    const first = restart();
    await first.load();

    first.fromPlan(OWNER, 's1', PLAN, [{ line: 2, from: GH, to: VERCEL_TERMINAL, uses: 2 }], ms.now + 3_600_000);
    const one = first.reserve('s1', GH_COPY, AT_VERCEL);
    first.spent(one as string);
    const two = first.reserve('s1', GH_COPY, AT_VERCEL);
    first.spent(two as string);
    await settle();
    const second = restart();
    await second.load();

    should(writes).eql([]);
    should([one, two]).eql([one, one]);
    should(first.reserve('s1', GH_COPY, AT_VERCEL)).be.undefined();
    should(first.planUses(PLAN)).eql(new Map([[2, 0]]));
    should(second.list(OWNER)).eql([]);
    should(second.reserve('s1', GH_COPY, AT_VERCEL)).be.undefined();
  });

  it('should keep the owner’s standing rules and the profile setting on disk across a restart', async () => {
    const { writes, restart, ms } = counted();
    const first = restart();
    await first.load();

    const standing = await first.create(OWNER, { from: GH, to: VERCEL_TERMINAL });
    await first.changeSettings(OWNER, { allowProfileTargets: true });
    first.fromPlan(OWNER, 's1', PLAN, [{ line: 0, from: GH, to: FLY_TERMINAL, uses: 1 }], ms.now + 3_600_000);
    const second = restart();
    await second.load();

    should(writes).have.length(2);
    should(writes.flatMap(write => write.rules.map(rule => rule.id))).eql([standing.id, standing.id]);
    should(second.list(OWNER).map(rule => rule.id)).eql([standing.id]);
    should(second.currentSettings(OWNER)).eql({ allowProfileTargets: true });
    should(second.reserve('s1', GH_COPY, AT_VERCEL)).equal(standing.id);
    should(second.reserve('s1', GH_COPY, AT_FLY)).be.undefined();
  });

  it('should drop the plan rules a store from before still holds, and never honour them', async () => {
    const { stored, restart } = counted();
    stored.rules = [
      {
        id: 'a'.repeat(32),
        from: GH,
        to: VERCEL_TERMINAL,
        sessionId: 's1',
        remaining: 1,
        used: 0,
        createdAt: '2026-10-31T00:00:00.000Z',
        createdBy: { kind: 'host' },
        plan: PLAN,
      },
    ];
    const service = restart();
    await service.load();

    should(service.list(OWNER)).eql([]);
    should(service.reserve('s1', GH_COPY, AT_VERCEL)).be.undefined();
  });

  it('should end a plan’s pastes by line or whole, and spend a plan rule only in its own session', async () => {
    const { service, ms, stored } = rules();
    await service.load();
    service.fromPlan(
      OWNER,
      's1',
      PLAN,
      [
        { line: 0, from: GH, to: VERCEL_TERMINAL, uses: 1 },
        { line: 1, from: GH, to: FLY_TERMINAL, uses: 1 },
      ],
      ms.now + 3_600_000,
    );

    should(service.reserve('s2', GH_COPY, AT_VERCEL)).be.undefined();
    service.endPlan(PLAN, [0]);
    should(service.reserve('s1', GH_COPY, AT_VERCEL)).be.undefined();
    should(service.planUses(PLAN)).eql(new Map([[1, 1]]));
    service.endPlan(PLAN);
    should(service.reserve('s1', GH_COPY, AT_FLY)).be.undefined();
    should(stored.rules).be.undefined();
  });

  it('should refuse a plan’s pastes for an agent, and a set that would not fit, making none', async () => {
    const { service, ms } = rules();
    await service.load();
    const many = Array.from({ length: COPY_MAX_RULES + 1 }, (_, line) => ({
      line,
      from: GH,
      to: VERCEL_TERMINAL,
      uses: 1,
    }));

    should((await refused(() => service.fromPlan(AGENT, 's1', PLAN, many.slice(0, 1), ms.now + 1))).code).equal(
      'forbidden',
    );
    should((await refused(() => service.fromPlan(OWNER, 's1', PLAN, many, ms.now + 1))).code).equal('capacity');
    should(service.list(OWNER)).eql([]);
  });
});

describe('PasteRuleService: taking back one of a plan’s pastes', () => {
  it('should remove a plan rule by its id from memory, writing nothing', async () => {
    const { service, ms, stored } = rules();
    await service.load();
    const [made] = service.fromPlan(
      OWNER,
      's1',
      'b'.repeat(32),
      [{ line: 0, from: GH, to: VERCEL_TERMINAL, uses: 2 }],
      ms.now + 3_600_000,
    );

    await service.revoke(PHONE, made?.id ?? '');

    should(service.list(OWNER)).eql([]);
    should(service.reserve('s1', GH_COPY, AT_VERCEL)).be.undefined();
    should(stored.rules).be.undefined();
  });
});
