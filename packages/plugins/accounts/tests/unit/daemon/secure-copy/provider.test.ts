import { describe, it } from 'bun:test';
import type { FerretId } from '@ferretry/kernel/contract';
import type { BrowsersApi } from '@ferretry/plugin-browsers/contract';
import should from 'should';
import type { SecretChildRunner } from '../../../../daemon/lib/local-ports.ts';
import { SecureCopyHook, TAKEN_OVER_PASTE } from '../../../../daemon/lib/secure-copy/provider.ts';
import type { PasteRuleService } from '../../../../daemon/lib/secure-copy/rules.ts';
import { SecureCopyService } from '../../../../daemon/lib/secure-copy/service.ts';
import { EphemeralValues } from '../support/masking.ts';

const SENTINEL = 'FAKE-SC-7f3a91';

class Clock {
  ms = Date.parse('2026-11-13T09:00:00.000Z');
  now(): number {
    return this.ms;
  }
}

const runner: SecretChildRunner = {
  run: async () => ({ outcome: 'exited', exitCode: 0, stdout: `${SENTINEL}\n`, stderr: '', truncated: false }),
};

async function world(browsers: () => BrowsersApi | undefined = () => undefined) {
  const clock = new Clock();
  const masking = new EphemeralValues(clock);
  const pasted: { copy: string; key: string; until: () => number | undefined }[] = [];
  const copies = new SecureCopyService({
    clock,
    runner,
    folders: { folderOf: async () => '/work' },
    exposure: { transcriptHolds: async () => 'clean' },
    masking,
    redact: async text => text,
    guards: {
      hold: () => undefined,
      pastedInto: async (_session, copy, key, until) => void pasted.push({ copy, key, until }),
      drop: () => undefined,
    },
  });
  await copies.capture('s1', { name: 'token', source: { kind: 'command', argv: ['gh', 'auth', 'token'] } });
  const reserved: unknown[][] = [];
  const rules = {
    reserve: (...args: unknown[]) => {
      reserved.push(args);
      return 'rule-1';
    },
    release: (id: string) => void reserved.push(['release', id]),
    spent: (id: string) => void reserved.push(['spent', id]),
  } as unknown as PasteRuleService;
  return { copies, hook: new SecureCopyHook(copies, rules, browsers), reserved, masking, pasted, clock };
}

const takenOver =
  (value: boolean): (() => BrowsersApi) =>
  () =>
    ({
      copy: {
        takenOver: async (_ferret: FerretId, key: string) => value && key === 'app',
      },
    }) as unknown as BrowsersApi;

describe('what Accounts gives the Vault’s paste (input.secure-copy:copy)', () => {
  it('should describe a live copy by facts only, open it for the one write, and count a use', async () => {
    const { hook } = await world();

    const told = hook.describe('s1', 'token');
    const value = hook.open('s1', 'token');
    hook.used('s1', 'token', { kind: 'terminal', key: 'dev' });

    should(told).match({ handle: 'sealed:token', length: SENTINEL.length, state: 'live', uses: 0 });
    should(JSON.stringify(told)).not.containEql(SENTINEL);
    should(value).equal(SENTINEL);
    should(hook.describe('s1', 'token')).match({ uses: 1 });
  });

  it('should know no copy of another session, an ended copy, or a name that is not one', async () => {
    const { hook, copies } = await world();

    should(hook.describe('s2', 'token')).equal(undefined);
    should(hook.open('s2', 'token')).equal(undefined);
    should(hook.describe('s1', 'NOT A NAME')).equal(undefined);
    should(hook.open('s1', '../token')).equal(undefined);
    copies.discard('s1', 'token');
    should(hook.describe('s1', 'token')).equal(undefined);
    should(hook.open('s1', 'token')).equal(undefined);
  });

  it('should refuse a paste into a page a person has taken over, and let a free page and a terminal through', async () => {
    const held = await world(takenOver(true));
    const free = await world(takenOver(false));

    should(await held.hook.refusal('s1', 'token', { kind: 'page', key: 'app' })).equal(TAKEN_OVER_PASTE);
    should(await held.hook.refusal('s1', 'token', { kind: 'page', key: 'other' })).equal(undefined);
    should(await free.hook.refusal('s1', 'token', { kind: 'page', key: 'app' })).equal(undefined);
    should(await held.hook.refusal('s1', 'token', { kind: 'terminal', key: 'dev' })).equal(undefined);
    should(await held.hook.refusal('s1', 'token', { kind: 'secret', key: 'VERCEL_TOKEN' })).equal(undefined);
  });

  it('should fail closed when Browsers cannot say whether a page is held', async () => {
    const off = await world(() => undefined);

    const said = await off.hook.refusal('s1', 'token', { kind: 'page', key: 'app' });

    should(said).containEql('could not check');
  });

  it('should hand a rule only an origin that parses, and pass its reserve, release and spend through', async () => {
    const { hook, reserved } = await world();
    const facts = { kind: 'terminal' } as never;

    const bad = hook.reserve('s1', { kind: 'command', program: 7 }, facts);
    const good = hook.reserve('s1', { kind: 'command', program: 'gh' }, facts, 'gh');
    hook.release('rule-1');
    hook.spent('rule-1');

    should(bad).equal(undefined);
    should(good).equal('rule-1');
    should(reserved).eql([
      ['s1', { kind: 'command', program: 'gh' }, facts, 'gh'],
      ['release', 'rule-1'],
      ['spent', 'rule-1'],
    ]);
  });
});

describe('a paste, as the Vault tells the copy where it went', () => {
  it('should mask a paste into a TERMINAL for the life of its scrollback, long after the copy’s own mask ended', async () => {
    const { hook, masking, clock } = await world();

    hook.used('s1', 'token', { kind: 'terminal', key: 'dev' });
    clock.ms += 7 * 24 * 3_600_000;

    should(masking.scrub('s1', `$ echo ${SENTINEL}`)).equal('$ echo [sealed:token]');
  });

  it('should close the origin of a PAGE a paste went into, until the copy ends', async () => {
    const { hook, pasted, copies } = await world();

    hook.used('s1', 'token', { kind: 'page', key: 'form' });
    await Promise.resolve();

    should(pasted).have.length(1);
    should(pasted[0]).match({ copy: 'token', key: 'form' });
    should(pasted[0]?.until()).be.a.Number();
    copies.discard('s1', 'token');
    should(pasted[0]?.until()).equal(undefined);
  });

  it('should hold nothing for a paste into the secret store, or for a name that is not a copy', async () => {
    const { hook, masking, pasted } = await world();

    hook.used('s1', 'token', { kind: 'secret', key: 'VERCEL_TOKEN' });
    hook.used('s1', 'not a copy!', { kind: 'terminal', key: 'dev' });

    should(pasted).eql([]);
    should(masking.scrub('s1', SENTINEL)).equal('[sealed:token]');
  });
});
