import { describe, it } from 'bun:test';
import should from 'should';
import {
  activeDisable,
  DISABLED_REASON_LIMIT,
  DisabledSchema,
  disabledPhrase,
  disabledUntilMs,
  nextDisableExpiry,
} from '../../src/lib/account/disabled.ts';
import { binaryNameOf, runtimeDisable, switchedOff } from '../../src/lib/account/disabled-runtime.ts';
import { EMPTY_RUNTIME_IDS } from '../../src/lib/account/ids.ts';
import { materialiseFleet } from '../../src/lib/account/materialise.ts';
import { type AccountModelDocument, parseAccountModel } from '../../src/lib/account/schema.ts';
import type { FleetLayout } from '../../src/lib/provisioning.ts';

const NOW = Date.parse('2026-10-30T12:00:00Z');

describe('DisabledSchema', () => {
  it('should read a reason and a date or an instant', () => {
    should(DisabledSchema.parse({ reason: ' spend limit ', until: '2026-11-01' })).eql({
      reason: 'spend limit',
      until: '2026-11-01',
    });
    should(DisabledSchema.parse({ until: '2026-11-01T09:00:00+02:00' })).eql({ until: '2026-11-01T09:00:00+02:00' });
    should(DisabledSchema.parse({})).eql({});
  });

  it('should refuse a blank or over-long reason, a vague time and an unknown key', () => {
    should(DisabledSchema.safeParse({ reason: '  ' }).success).be.false();
    should(DisabledSchema.safeParse({ reason: 'x'.repeat(DISABLED_REASON_LIMIT + 1) }).success).be.false();
    const vague = DisabledSchema.safeParse({ until: 'next week' });
    should(vague.success).be.false();
    should(JSON.stringify(vague.error?.issues)).match(/write \\"until\\" as a date/u);
    should(DisabledSchema.safeParse({ why: 'x' }).success).be.false();
  });
});

describe('disabled time helpers', () => {
  it('should read a bare date as the start of that day in UTC', () => {
    should(disabledUntilMs('2026-11-01')).equal(Date.parse('2026-11-01T00:00:00Z'));
    should(disabledUntilMs(undefined)).be.undefined();
    should(disabledUntilMs('not a time')).be.undefined();
  });

  it('should drop a block whose until has passed and keep the rest', () => {
    should(activeDisable(undefined, NOW)).be.undefined();
    should(activeDisable({ reason: 'a' }, NOW)).eql({ reason: 'a' });
    should(activeDisable({ until: '2026-10-30T12:00:00Z' }, NOW)).be.undefined();
    should(activeDisable({ until: '2026-10-30' }, NOW)).be.undefined();
    should(activeDisable({ until: '2026-11-01' }, NOW)).eql({ until: '2026-11-01' });
  });

  it('should find the earliest expiry still ahead', () => {
    should(nextDisableExpiry([undefined, { reason: 'forever' }, { until: '2026-10-01' }], NOW)).be.undefined();
    should(nextDisableExpiry([{ until: '2026-12-01' }, undefined, { until: '2026-11-01' }], NOW)).equal(
      Date.parse('2026-11-01T00:00:00Z'),
    );
  });

  it('should say a block in a sentence', () => {
    should(disabledPhrase({})).equal('disabled');
    should(disabledPhrase({ reason: 'spend limit reached', until: '2026-11-01' })).equal(
      'disabled (spend limit reached) until 2026-11-01',
    );
    should(disabledPhrase({ until: '2026-11-01T09:30:00Z' })).equal('disabled until 2026-11-01 09:30 UTC');
    should(disabledPhrase({ until: 'garbled' })).equal('disabled until garbled');
  });
});

const modelOf = (disabled?: { login?: object; first?: object; second?: object }) =>
  parseAccountModel({
    version: 2,
    credentials: {
      'claude-work': { harness: 'claude', store: 'ferretry', ...(disabled?.login ? { disabled: disabled.login } : {}) },
      'claude-home': { harness: 'claude', store: 'host' },
      'codex-work': { harness: 'codex', store: 'ferretry' },
    },
    components: {
      modelSets: {
        claude: { models: ['claude-opus-5-5'], default: 'claude-opus-5-5' },
        codex: { models: ['gpt-6'], default: 'gpt-6' },
      },
    },
    profiles: { default: { layers: ['modelSets/claude', 'modelSets/codex'] } },
    runtimes: {
      'claude-a': {
        credential: 'claude-work',
        profile: 'default',
        agent: true,
        ...(disabled?.first ? { disabled: disabled.first } : {}),
      },
      'claude-b': { credential: 'claude-home', profile: 'default', agent: true },
      'claude-c': {
        credential: 'claude-home',
        profile: 'default',
        agent: true,
        ...(disabled?.second ? { disabled: disabled.second } : {}),
      },
      'codex-a': { credential: 'codex-work', profile: 'default', agent: true },
    },
  } satisfies AccountModelDocument);

describe('runtimeDisable', () => {
  it('should say nothing for a runtime that is on, one that is unknown and a block that has expired', () => {
    should(runtimeDisable(modelOf(), 'claude-a', NOW, 'fy')).be.undefined();
    should(runtimeDisable(modelOf(), 'nope', NOW, 'fy')).be.undefined();
    should(runtimeDisable(modelOf({ first: { until: '2026-10-01' } }), 'claude-a', NOW, 'fy')).be.undefined();
  });

  it('should name the runtime switch, the alternative and how to move a running ferret', () => {
    const off = runtimeDisable(modelOf({ first: { reason: 'spend limit' } }), 'claude-a', NOW, 'fy');
    should(off?.own).eql({ reason: 'spend limit' });
    should(off?.login).be.undefined();
    should(off?.alternative).equal('claude-b');
    should(off?.clauses).eql([
      'runtime "claude-a" is disabled (spend limit)',
      'Use "claude-b" instead, or turn it back on with `fy runtime enable claude-a`. Ferrets already on it keep running; move one with `fy migrate <id> -a claude-b`',
    ]);
  });

  it('should hold every runtime on a disabled login and tell the person to enable the login', () => {
    const model = modelOf({ login: { reason: 'org spend limit', until: '2026-11-01' } });
    const off = runtimeDisable(model, 'claude-a', NOW, 'fy');
    should(off?.login).eql({ reason: 'org spend limit', until: '2026-11-01' });
    should(off?.clauses[0]).equal('its login "claude-work" is disabled (org spend limit) until 2026-11-01');
    should(off?.clauses[1]).match(/`fy login enable claude-work`/u);
    should(switchedOff(model, model.runtimes['claude-a'] as never, NOW)).be.true();
    should(switchedOff(model, model.runtimes['claude-b'] as never, NOW)).be.false();
  });

  it('should skip an alternative that is off itself, and say so when none is left', () => {
    const second = runtimeDisable(modelOf({ first: {}, second: {} }), 'claude-a', NOW, 'fy');
    should(second?.alternative).equal('claude-b');
    const model = parseAccountModel({
      version: 2,
      credentials: { only: { harness: 'claude', store: 'ferretry', disabled: {} } },
      components: {},
      profiles: { default: { layers: [] } },
      runtimes: { solo: { credential: 'only', profile: 'default' } },
    });
    const off = runtimeDisable(model, 'solo', NOW, 'ferretry');
    should(off?.alternative).be.undefined();
    should(off?.clauses.at(-1)).match(
      /^No other runtime of this kind is on, or turn it back on with `ferretry login enable only`/u,
    );
    should(off?.clauses.at(-1)).match(/migrate <id> -a <runtime>/u);
  });

  it('should take the binary name from the command that runs it', () => {
    should(binaryNameOf('/opt/ferretry/bin/fy')).equal('fy');
    should(binaryNameOf('')).equal('fy');
  });
});

const LAYOUT: FleetLayout = {
  stateHome: '/fy',
  userHome: '/home/person',
  fleetDirectory: '/fy/fleet',
  binDirectory: '/fy/fleet/bin',
  homesDirectory: '/fy/fleet/homes',
  assetsDirectory: '/fy/fleet/assets',
  manifestPath: '/fy/fleet/manifest.json',
  defaultHomeDirectories: { claude: '/home/person/.claude', codex: '/home/person/.codex' },
};

describe('materialiseFleet with a switch off', () => {
  const plan = (model: ReturnType<typeof modelOf>, generatedAt: string) =>
    materialiseFleet({
      model,
      layout: LAYOUT,
      ids: EMPTY_RUNTIME_IDS,
      mint: (() => {
        let n = 0;
        return () => {
          n += 1;
          return `00000000-0000-4000-8000-00000000000${n}`;
        };
      })(),
      generatedAt,
      claudeStatusline: () => "'fy' statusline",
      fyCommand: '/opt/ferretry/bin/fy',
      hostCodexHome: '/home/person/.codex',
      acceptsAutoPermissionMode: true,
    });

  it('should publish the runtimes on a disabled login unavailable and the rest available', () => {
    const result = plan(modelOf({ login: { reason: 'spend limit' } }), '2026-10-30T12:00:00.000Z');
    const row = (name: string) => result.manifest.accounts.find(account => account.displayName === name);
    should(row('claude-a')).match({ available: false });
    should(row('claude-a')?.unavailableReason).match(/its login "claude-work" is disabled \(spend limit\)/u);
    should(row('claude-a')?.unavailableReason).match(/Use "claude-b" instead/u);
    should(row('claude-b')).match({ available: true });
    should(row('codex-a')).match({ available: true });
  });

  it('should print the reason when a disabled runtime is launched by name', () => {
    const result = plan(modelOf({ first: { reason: 'paused' } }), '2026-10-30T12:00:00.000Z');
    const wrapper = result.operations.find(operation => operation.path === '/fy/fleet/bin/claude-a');
    should(wrapper?.kind === 'file' ? wrapper.content : '').match(
      /ferretry: claude-a cannot start: runtime "claude-a" is disabled \(paused\)/u,
    );
  });

  it('should publish a runtime available again once its until has passed', () => {
    const model = modelOf({ first: { until: '2026-11-01' } });
    const before = plan(model, '2026-10-30T12:00:00.000Z').manifest.accounts.find(a => a.displayName === 'claude-a');
    const after = plan(model, '2026-11-01T00:00:00.000Z').manifest.accounts.find(a => a.displayName === 'claude-a');
    should(before).match({ available: false });
    should(after).match({ available: true });
  });
});
