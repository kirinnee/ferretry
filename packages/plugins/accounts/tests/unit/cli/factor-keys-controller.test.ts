import { describe, it } from 'bun:test';
import should from 'should';
import { FactorKeyController } from '../../../cli/lib/factor-keys-controller.ts';
import { DAMAGED, LIST, TF, accountPorts, rejection, type RigOptions } from './accounts-rig.ts';

function rig(options: RigOptions = {}) {
  const made = accountPorts(options);
  return { ...made, controller: new FactorKeyController(made.ports) };
}

const noKeys = { ...LIST, accounts: LIST.accounts.map(account => ({ ...account, factors: [] })) };

describe('FactorKeyController list', () => {
  it('should list every 2FA key of every account, each with the id the other verbs take', async () => {
    const { controller, said } = rig();
    await controller.list(undefined, {});
    should(said[0]?.split('\n')).eql([
      `GITHUB_HOME  ${TF(1)}  text  (text message ending ••42: you type the code)`,
      `GITHUB_HOME  ${TF(2)}  authy  (authenticator app: Ferretry makes the codes (not tried yet))`,
    ]);
  });

  it("should list one account's keys, or say it has none", async () => {
    const some = rig();
    await some.controller.list(' GITHUB_HOME ', {});
    should(some.said[0]?.split('\n')).have.length(2);
    const none = rig();
    await none.controller.list('GITHUB_WORK', {});
    should(none.said).eql(['GITHUB_WORK has no 2FA keys (add one with `account factor add`).']);
  });

  it('should say no key exists on the daemon at all', async () => {
    const { controller, said } = rig({ list: noKeys });
    await controller.list(undefined, {});
    should(said).eql(['No 2FA keys on this daemon.']);
  });

  it('should print JSON as one entry per account with its keys', async () => {
    const { controller, said } = rig();
    await controller.list('GITHUB_HOME', { json: true });
    const parsed = JSON.parse(said[0] ?? '');
    should(parsed).have.length(1);
    should(parsed[0].account).equal('GITHUB_HOME');
    should(parsed[0].factors.map((key: { id: string }) => key.id)).eql([TF(1), TF(2)]);
  });

  it('should refuse an account that does not exist and a store it cannot read', async () => {
    should(await rejection(() => rig().controller.list('NOPE', {}))).equal('no account NOPE (see `account ls`)');
    should(await rejection(() => rig({ list: DAMAGED }).controller.list(undefined, {}))).containEql('NOT gone');
    should(
      await rejection(() =>
        rig({ list: { ...DAMAGED, diagnosis: undefined as never } }).controller.list(undefined, {}),
      ),
    ).containEql('no diagnosis was given');
  });
});

describe('FactorKeyController add', () => {
  const sent = (made: ReturnType<typeof rig>) => made.gateway.calls.at(-1);

  it('should add an authenticator the owner holds, a security key and a bare sms or email key', async () => {
    const totp = rig();
    await totp.controller.add('GITHUB_WORK', { authenticator: true, label: ' Authy on my phone ' });
    should(sent(totp)).eql(['addFactor', 'GITHUB_WORK', { label: 'Authy on my phone', kind: 'totp' }]);
    should(totp.said[0]).startWith('Added to GITHUB_WORK: tf_');

    const key = rig();
    await key.controller.add('GITHUB_WORK', { securityKey: true, label: 'yubikey' });
    should(sent(key)).eql(['addFactor', 'GITHUB_WORK', { label: 'yubikey', kind: 'security-key' }]);

    const sms = rig();
    await sms.controller.add('GITHUB_WORK', { sms: true, label: 'text' });
    should(sent(sms)).eql(['addFactor', 'GITHUB_WORK', { label: 'text', kind: 'sms' }]);

    const email = rig();
    await email.controller.add('GITHUB_WORK', { email: true, label: 'mail' });
    should(sent(email)).eql(['addFactor', 'GITHUB_WORK', { label: 'mail', kind: 'email' }]);
  });

  it('should carry the plain facts of its kind: the last digits, where the code goes, which app', async () => {
    const sms = rig();
    await sms.controller.add('GITHUB_WORK', { sms: true, label: 'text', endsWith: ' 42 ' });
    should(sent(sms)).eql(['addFactor', 'GITHUB_WORK', { label: 'text', kind: 'sms', endsWith: '42' }]);

    const email = rig();
    await email.controller.add('GITHUB_WORK', { email: true, label: 'mail', to: ' k***@example.com ' });
    should(sent(email)).eql(['addFactor', 'GITHUB_WORK', { label: 'mail', kind: 'email', to: 'k***@example.com' }]);

    const push = rig();
    await push.controller.add('GITHUB_WORK', { push: true, label: 'duo', app: ' Duo ' });
    should(sent(push)).eql(['addFactor', 'GITHUB_WORK', { label: 'duo', kind: 'push', app: 'duo' }]);

    const bare = rig();
    await bare.controller.add('GITHUB_WORK', { push: true, label: 'phone' });
    should(sent(bare)).eql(['addFactor', 'GITHUB_WORK', { label: 'phone', kind: 'push' }]);
  });

  it('should refuse no kind, two kinds, no label and a bad label before asking the daemon anything', async () => {
    const made = rig();
    should(await rejection(() => made.controller.add('GITHUB_WORK', { label: 'x' }))).containEql(
      'name exactly one kind of 2FA key',
    );
    should(
      await rejection(() => made.controller.add('GITHUB_WORK', { sms: true, email: true, label: 'x' })),
    ).containEql('name exactly one kind');
    should(await rejection(() => made.controller.add('GITHUB_WORK', { sms: true }))).containEql(
      'give the key a --label',
    );
    should(await rejection(() => made.controller.add('GITHUB_WORK', { sms: true, label: ' ' }))).containEql(
      '--label must be one line',
    );
    should(made.gateway.calls).eql([]);
  });

  it('should refuse a fact that belongs to another kind, and a fact that is not valid', async () => {
    const made = rig();
    should(
      await rejection(() => made.controller.add('GITHUB_WORK', { email: true, label: 'x', endsWith: '42' })),
    ).equal('--ends-with is for sms, not email');
    should(await rejection(() => made.controller.add('GITHUB_WORK', { sms: true, label: 'x', to: 'a@b.c' }))).equal(
      '--to is for email, not sms',
    );
    should(await rejection(() => made.controller.add('GITHUB_WORK', { sms: true, label: 'x', app: 'duo' }))).equal(
      '--app is for push, not sms',
    );
    should(
      await rejection(() => made.controller.add('GITHUB_WORK', { sms: true, label: 'x', endsWith: '+15551234567' })),
    ).containEql('never the whole number');
    should(
      await rejection(() => made.controller.add('GITHUB_WORK', { push: true, label: 'x', app: 'carrier-pigeon' })),
    ).containEql('--app is one of okta-verify');
    should(await rejection(() => made.controller.add('GITHUB_WORK', { email: true, label: 'x', to: ' ' }))).containEql(
      '--to must be one line',
    );
    should(made.gateway.calls).eql([]);
  });

  it('should refuse an account that does not exist and a store it cannot read', async () => {
    const missing = rig();
    should(await rejection(() => missing.controller.add('NOPE', { sms: true, label: 'x' }))).containEql(
      'no account NOPE',
    );
    const damaged = rig({ list: DAMAGED });
    should(await rejection(() => damaged.controller.add('GITHUB_WORK', { sms: true, label: 'x' }))).containEql(
      'NOT gone',
    );
    for (const made of [missing, damaged]) should(made.gateway.calls.map(call => call[0])).not.containEql('addFactor');
  });
});

describe('FactorKeyController remove', () => {
  it('should remove at once with --yes', async () => {
    const { controller, gateway, said, asked } = rig();
    await controller.remove('GITHUB_HOME', TF(1), { yes: true });
    should(asked).eql([]);
    should(gateway.calls.at(-1)).eql(['removeFactor', 'GITHUB_HOME', TF(1)]);
    should(said).eql([`Removed ${TF(1)} from GITHUB_HOME.`]);
  });

  it('should ask first, and warn that the saved seed goes with a key Ferretry makes codes for', async () => {
    const plain = rig({ typed: ['yes'] });
    await plain.controller.remove('GITHUB_HOME', TF(1), {});
    should(plain.asked[0]).equal(
      `Remove ${TF(1)}  text  (text message ending ••42: you type the code) from GITHUB_HOME? Type yes: `,
    );
    should(plain.gateway.calls.at(-1)).eql(['removeFactor', 'GITHUB_HOME', TF(1)]);

    const automatic = rig({ typed: ['yes'] });
    await automatic.controller.remove('GITHUB_HOME', TF(2), {});
    should(automatic.asked[0])
      .containEql('Ferretry makes its codes: the saved seed is deleted with it')
      .and.endWith('Type yes: ');
  });

  it('should keep the key on any other answer', async () => {
    const { controller, gateway, said } = rig({ typed: ['no'] });
    await controller.remove('GITHUB_HOME', TF(1), {});
    should(said).eql([`Kept ${TF(1)}.`]);
    should(gateway.calls.map(call => call[0])).not.containEql('removeFactor');
  });

  it('should refuse to ask away from a terminal', async () => {
    const { controller, gateway } = rig({ interactive: false });
    should(await rejection(() => controller.remove('GITHUB_HOME', TF(1), {}))).containEql('pass --yes to skip');
    should(gateway.calls.map(call => call[0])).not.containEql('removeFactor');
  });

  it('should refuse an account or a key that does not exist, and ids that are not ids', async () => {
    should(await rejection(() => rig().controller.remove('NOPE', TF(1), { yes: true }))).containEql('no account NOPE');
    should(await rejection(() => rig().controller.remove('GITHUB_HOME', TF(9), { yes: true }))).equal(
      `GITHUB_HOME has no 2FA key ${TF(9)} (see \`account factor ls GITHUB_HOME\`)`,
    );
    should(await rejection(() => rig().controller.remove('GITHUB_HOME', 'tf_x', { yes: true }))).containEql(
      'is not a 2FA key id',
    );
  });
});
