import { describe, it } from 'bun:test';
import type { AccountId, SignInRuleStageId } from '@ferretry/protocol';
import should from 'should';
import { connectSignInRules, SignInRuleDevicePurge, SignInRuleService } from '../../../src/lib/sign-in-rules/index.ts';
import { PasskeysChangedSignal } from '../../../src/lib/step-up/passkeys-changed.ts';
import { MemoryLoginIndex } from '../runtime/mounts/support.ts';
import { CountingSealed, daemonOver } from '../secrets/accounts-fixtures.ts';
import {
  CREDENTIAL,
  DEVICE,
  deviceOwner,
  evidenceFor,
  FakeProofs,
  HOST_OWNER,
  MemoryRuleStore,
  NOW,
} from './support.ts';

/**
 * THE THREE HOOKS THAT KEEP THE RULES TOLD (secrev-1274b L4): every committed account change, every passkey change and
 * every device revocation reaches the rule service through {@link connectSignInRules}, and the daemon makes that one
 * call. Each is proved here over the real directory and the real signal, and the composition root is read to prove it
 * connects all three, so deleting any one fails a test.
 */

async function world() {
  const directory = daemonOver(new MemoryLoginIndex(), new CountingSealed()).directory;
  await directory.putAccount('GITHUB' as AccountId, { label: 'GitHub', username: 'kirinnee', password: 'pw-UNIQUE-1' });
  const github = await directory.addSignIn('GITHUB' as AccountId, {
    place: { kind: 'site', domains: ['github.com'], match: [] },
  });
  for (let tap = 0; tap < 2; tap += 1)
    await directory.observeSignIn(github.id, {
      at: 'github.com',
      surface: 'page',
      identity: '0123456789abcdef',
      masked: true,
      navigatedAway: true,
      tapped: true,
    });
  const proofs = new FakeProofs();
  let ids = 0;
  const rules = new SignInRuleService({
    store: new MemoryRuleStore(),
    accounts: { listing: async () => await directory.keyedList() },
    proofs,
    passkeys: { any: async () => true, of: async () => true },
    audit: { record: async () => undefined },
    clock: { now: () => NOW },
    ids: {
      ruleId: () => `sr_${(++ids).toString(16).padStart(24, '0')}`,
      stageId: () => `srs_${(++ids).toString(16).padStart(24, '0')}` as SignInRuleStageId,
    },
    warn: () => undefined,
  });
  await rules.load();
  const passkeys = new PasskeysChangedSignal();
  const devices = new SignInRuleDevicePurge();
  const approve = async () => {
    const staged = await rules.stage(deviceOwner(), { signIn: github.id, fields: ['username', 'password'] });
    const challenge = rules.challengeOf(staged.stage, DEVICE) ?? new Uint8Array();
    await rules.commit(deviceOwner(), staged.stage, () => evidenceFor(challenge));
  };
  const status = async () => {
    const [rule] = (await rules.list(HOST_OWNER)).rules;
    return rule?.suspended?.because ?? rule?.status;
  };
  return { directory, rules, proofs, passkeys, devices, approve, status, signIn: github.id };
}

describe('connectSignInRules', () => {
  it('should follow every committed account change', async () => {
    const w = await world();
    connectSignInRules(w.rules, { accounts: w.directory, passkeys: w.passkeys, devices: w.devices });
    await w.approve();
    await w.directory.putSignIn(w.signIn, { recipe: 'Open github.com/login' });
    should(await w.status()).equal('recipe-changed');
  });

  it('should hear the passkeys-changed signal and check every proof again', async () => {
    const w = await world();
    connectSignInRules(w.rules, { accounts: w.directory, passkeys: w.passkeys, devices: w.devices });
    await w.approve();
    w.proofs.held.delete(`${DEVICE}:${CREDENTIAL}`);
    await w.passkeys.emit({ cause: 'device-forgotten', deviceId: DEVICE });
    should(await w.status()).equal('passkey-removed');
  });

  it('should take pairing’s device purge, which does nothing before it is connected', async () => {
    const w = await world();
    await w.devices.forgetDevice(DEVICE);
    connectSignInRules(w.rules, { accounts: w.directory, passkeys: w.passkeys, devices: w.devices });
    await w.approve();
    await w.devices.forgetDevice(DEVICE);
    should(await w.status()).equal('passkey-removed');
  });

  it('should leave the rules untold when it is not called', async () => {
    const w = await world();
    await w.approve();
    await w.directory.putSignIn(w.signIn, { recipe: 'Open github.com/login' });
    await w.passkeys.emit({ cause: 'device-forgotten', deviceId: DEVICE });
    await w.devices.forgetDevice(DEVICE);
    should(await w.status()).equal('active');
  });
});

describe('the composition root makes every connection', () => {
  it('should connect the rules, put them in pairing’s device purge, and flush them at shutdown', async () => {
    const source = await Bun.file(new URL('../../../bin/fyd.ts', import.meta.url)).text();
    const flat = source.replaceAll(/\s+/gu, ' ');
    should(flat).containEql(
      'connectSignInRules(signInRules, { accounts: accountDirectory, passkeys: passkeysChanged, devices: signInRuleDevices, });',
    );
    should(flat).containEql('deviceState: [push, stepUp, signInRuleDevices],');
    should(flat).containEql('cleanups.push(async () => await subsystems.signInRules.flush());');
    should(flat).containEql(
      'setInterval(() => void signInRules.sweepRules().catch(() => undefined), INPUT_REQUEST_SWEEP_MS)',
    );
  });
});

// secrev-1301 / lizzette (a): the terminal gate is the protocol's compile-time list, read nowhere else.
describe('terminal standing rules are switched by the build alone', () => {
  it('should read sign-in-rules-terminal.1 only through daemonFeatureList, for the rule service, the suggestions and the fills', async () => {
    const fyd = await Bun.file(new URL('../../../bin/fyd.ts', import.meta.url)).text();
    const reads = fyd.split('\n').filter(line => line.includes('signInRulesTerminal'));
    should(reads.map(line => line.trim())).eql([
      'terminalRules: () => daemonFeatureList().includes(DAEMON_FEATURES.signInRulesTerminal),',
      'terminalRules: () => daemonFeatureList().includes(DAEMON_FEATURES.signInRulesTerminal),',
      'terminal: () => daemonFeatureList().includes(DAEMON_FEATURES.signInRulesTerminal),',
    ]);
    // No daemon code (comments aside) holds the feature's name, which a config, env or file value could match.
    const glob = new Bun.Glob('**/*.ts');
    const code = (source: string): string => source.replaceAll(/\/\*[\s\S]*?\*\//gu, '').replaceAll(/\/\/.*$/gmu, '');
    const holding: string[] = [];
    for await (const file of glob.scan(new URL('../../../', import.meta.url).pathname))
      if (!file.includes('tests/') && !file.includes('node_modules/'))
        if (
          code(await Bun.file(new URL(`../../../${file}`, import.meta.url)).text()).includes('sign-in-rules-terminal')
        )
          holding.push(file);
    should(holding).eql([]);
    const features = await Bun.file(new URL('../../../../protocol/src/lib/daemon-features.ts', import.meta.url)).text();
    should(features).match(/const NOT_YET_REPORTED[^;]*DAEMON_FEATURES\.signInRulesTerminal[^;]*;/u);
  });
});
