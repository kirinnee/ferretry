import { afterEach, describe, expect, it } from 'bun:test';
import {
  type AccountList,
  AccountListSchema,
  DAEMON_FEATURES,
  LOGIN_ONE_FACTOR_WARNING,
  LOGIN_TOTP_WARNING,
  type TwoFactorStageId,
} from '@ferretry/protocol';
import { InputCard } from '../../../src/features/input-request/input-card.tsx';
import { InputCardHost } from '../../../src/features/input-request/input-card-host.tsx';
import { daemonConnection } from '../../../src/lib/daemon-connection.ts';
import { fieldsOf } from '../../../src/lib/input-card.ts';
import { DaemonClientProvider } from '../../../src/lib/store.tsx';
import { type Mounted, mount } from '../../support/dom.ts';
import { click, settle, typeInto } from '../../support/dom-form.ts';
import { healthOf } from '../../support/health.ts';
import { type Call, fakeClient, NOW, offer, requestOf, saved } from '../../support/input-fixtures.ts';

const mounted: Mounted[] = [];
afterEach(async () => {
  for (const each of mounted.splice(0)) await each.unmount();
});

const AT = '2026-10-31T10:00:00.000Z';
const SIGN_IN = 'si_0123456789abcdef';
const SMS = 'tf_000000000001';
const APP = 'tf_000000000002';
const STAGE = `st_${'a'.repeat(24)}` as TwoFactorStageId;
const KEY = 'otpauth://totp/GitHub:kirinnee?secret=JBSWY3DPEHPK3PXP&issuer=GitHub';
const OTHER_KEY = 'otpauth://totp/Slack:someone@else.test?secret=JBSWY3DPEHPK3PXP&issuer=Slack';
const PARAMS = { algorithm: 'SHA1', digits: 6, period: 30 };

const sms = (id: string) => ({
  id,
  kind: 'sms',
  label: 'Phone',
  endsWith: '42',
  addedAt: AT,
  addedBy: 'owner',
  automatic: false,
});
const totp = (id: string, label: string) => ({
  id,
  kind: 'totp',
  label,
  params: PARAMS,
  addedAt: AT,
  addedBy: 'owner',
  automatic: true,
});

const accountList = (factors: readonly object[] = [sms(SMS)]): AccountList =>
  AccountListSchema.parse({
    v: 1,
    health: 'ready',
    accounts: [
      {
        id: 'GITHUB',
        label: 'GitHub',
        username: 'kirinnee',
        fields: { password: true, totp: factors.some(each => (each as { automatic?: boolean }).automatic === true) },
        factors,
        signIns: [SIGN_IN],
        createdAt: AT,
        updatedAt: AT,
      },
    ],
    signIns: [
      {
        id: SIGN_IN,
        account: 'GITHUB',
        place: { kind: 'site', domains: ['github.com'], match: [] },
        method: { kind: 'password' },
        createdAt: AT,
        updatedAt: AT,
      },
    ],
  });

const codeCard = (codes?: readonly object[]) =>
  requestOf('code', {
    expiresAt: '2099-01-01T00:00:00.000Z',
    target: { kind: 'browser', key: 'app' },
    saved: saved({
      match: 'github.com',
      offers: [
        offer({
          id: 'GITHUB',
          label: 'GitHub (kirinnee)',
          username: 'kirinnee',
          fills: 'totp',
          matched: true,
          primary: true,
          why: 'only',
          signIn: SIGN_IN,
          ...(codes === undefined ? {} : { codes: codes as never }),
        }),
      ],
    }),
  });

const answers = (call: Call): unknown => {
  if (call.path.endsWith('/commit'))
    return { account: 'GITHUB', factor: totp(APP, 'Authenticator app'), mismatch: false };
  if (call.method === 'DELETE') return { stage: STAGE, dropped: true };
  if (call.path.endsWith('/factors/seed'))
    return {
      stage: STAGE,
      account: 'GITHUB',
      label: 'Authenticator app',
      expiresAt: AT,
      parsed: { params: PARAMS, issuer: 'GitHub', accountName: 'kirinnee' },
    };
  return {};
};

const draw = async (over: { addKey?: (stage: TwoFactorStageId) => Promise<boolean>; accounts?: AccountList } = {}) => {
  const machine = fakeClient(answers);
  const asked: TwoFactorStageId[] = [];
  const addKey = over.addKey ?? (async (stage: TwoFactorStageId) => void asked.push(stage) === undefined);
  const request = codeCard();
  const view = await mount(
    <InputCard
      accounts={over.accounts ?? accountList()}
      addKey={addKey}
      client={machine.client}
      fields={fieldsOf(request)}
      now={NOW}
      onDone={() => undefined}
      request={request}
    />,
  );
  mounted.push(view);
  const q = (selector: string) => view.container.querySelector<HTMLElement>(selector);
  return { view, q, calls: machine.calls, asked };
};

const seedCalls = (calls: readonly Call[]) => calls.filter(call => call.path.includes('/factors/seed'));

describe('"Set up automatic codes" under a code card', () => {
  it('should not be offered to a card that is not a code card', async () => {
    const machine = fakeClient(answers);
    const request = requestOf('secret', { saved: saved({ offers: [offer({ id: 'GITHUB', signIn: SIGN_IN })] }) });
    const view = await mount(
      <InputCard
        accounts={accountList()}
        addKey={async () => true}
        client={machine.client}
        fields={fieldsOf(request)}
        now={NOW}
        onDone={() => undefined}
        request={request}
      />,
    );
    mounted.push(view);

    expect(view.container.querySelector('[data-codes-panel]')).toBeNull();
  });

  it('should refuse to save until the warning is ticked, and send nothing', async () => {
    const card = await draw();

    await click(card.q('[data-codes-panel] summary'));
    await typeInto(card.q('[data-codes-seed]'), KEY);

    expect(card.q('[data-codes-warning]')?.textContent).toBe(LOGIN_TOTP_WARNING);
    expect(card.q('[data-codes-reads]')?.textContent).toContain('6-digit codes, new every 30 seconds');
    expect((card.q('[data-codes-save]') as HTMLButtonElement).disabled).toBe(true);
    expect(card.q('[data-codes-blocked]')?.textContent).toBe('Tick the box to say you read the warning.');
    await click(card.q('[data-codes-save]'));
    expect(seedCalls(card.calls)).toEqual([]);
  });

  it('should need the second tick for a key that says it is for another account', async () => {
    const card = await draw();

    await click(card.q('[data-codes-panel] summary'));
    await typeInto(card.q('[data-codes-seed]'), OTHER_KEY);
    await click(card.q('[data-codes-warning-tick]'));

    expect(card.q('[data-codes-mismatch]')?.textContent).toContain('This key says it is for Slack');
    expect((card.q('[data-codes-save]') as HTMLButtonElement).disabled).toBe(true);
    await click(card.q('[data-codes-mismatch-tick]'));
    expect((card.q('[data-codes-save]') as HTMLButtonElement).disabled).toBe(false);
  });

  it('should say a key that is not a key, without repeating it', async () => {
    const card = await draw();

    await click(card.q('[data-codes-panel] summary'));
    await typeInto(card.q('[data-codes-seed]'), 'hunter2-not-a-key!');

    const problem = card.q('[data-codes-problem]')?.textContent ?? '';
    expect(problem.length).toBeGreaterThan(0);
    expect(problem).not.toContain('hunter2');
  });

  it('should stage the key once, clear the field, ask for the passkey for THAT stage, then commit with no body', async () => {
    const card = await draw();

    await click(card.q('[data-codes-panel] summary'));
    await typeInto(card.q('[data-codes-seed]'), KEY);
    await click(card.q('[data-codes-warning-tick]'));
    await click(card.q('[data-codes-save]'));
    await settle();
    await settle();

    const [stage, commit] = seedCalls(card.calls);
    expect(stage?.path).toBe('/v1/accounts/GITHUB/factors/seed');
    expect(stage?.body).toMatchObject({ totpAcknowledged: true, request: 'ab'.repeat(16) });
    expect(((stage?.body as { padded?: string } | undefined)?.padded ?? '').length).toBeGreaterThan(KEY.length + 100);
    expect(JSON.stringify(seedCalls(card.calls).slice(1))).not.toContain('JBSWY3DPEHPK3PXP');
    expect(stage?.body).not.toHaveProperty('mismatchAcknowledged');
    expect(card.asked).toEqual([STAGE]);
    expect(commit?.path).toBe(`/v1/accounts/GITHUB/factors/seed/${STAGE}/commit`);
    expect(commit?.body).toBeUndefined();
    expect(seedCalls(card.calls)).toHaveLength(2);
    expect((card.q('[data-codes-seed]') as HTMLInputElement | null)?.value ?? '').toBe('');
    expect(card.q('[data-codes-saved]')?.textContent).toContain('Saved.');
  });

  it('should send the second tick only for a key that says it is for another account', async () => {
    const card = await draw();

    await click(card.q('[data-codes-panel] summary'));
    await typeInto(card.q('[data-codes-seed]'), OTHER_KEY);
    await click(card.q('[data-codes-warning-tick]'));
    await click(card.q('[data-codes-mismatch-tick]'));
    await click(card.q('[data-codes-save]'));
    await settle();

    expect(seedCalls(card.calls)[0]?.body).toMatchObject({ mismatchAcknowledged: true });
  });

  it('should drop the staged key and save nothing when the passkey is dismissed', async () => {
    const card = await draw({ addKey: async () => false });

    await click(card.q('[data-codes-panel] summary'));
    await typeInto(card.q('[data-codes-seed]'), KEY);
    await click(card.q('[data-codes-warning-tick]'));
    await click(card.q('[data-codes-save]'));
    await settle();
    await settle();

    expect(seedCalls(card.calls).map(call => call.method)).toEqual(['POST', 'DELETE']);
    expect(card.q('[data-codes-failed]')?.textContent).toBe(
      'You did not confirm with your passkey, so nothing was saved.',
    );
  });

  it('should refuse a fifth key that makes codes, in words, before anything is sent', async () => {
    const full = accountList([1, 2, 3, 4].map(n => totp(`tf_00000000000${String(n)}`, `App ${String(n)}`)));
    const card = await draw({ accounts: full });

    await click(card.q('[data-codes-panel] summary'));
    await typeInto(card.q('[data-codes-seed]'), KEY);
    await click(card.q('[data-codes-warning-tick]'));

    expect(card.q('[data-codes-blocked]')?.textContent).toContain('already has 4 keys');
    expect((card.q('[data-codes-save]') as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('a code card with keys Ferretry makes codes from', () => {
  const withKeys = async (codes: readonly object[]) => {
    const machine = fakeClient(() => ({ outcome: 'typed' }));
    const request = codeCard(codes);
    const view = await mount(
      <InputCard
        accounts={accountList([sms(SMS), totp(APP, 'Authenticator app')])}
        client={machine.client}
        fields={fieldsOf(request)}
        now={NOW}
        onDone={() => undefined}
        request={request}
      />,
    );
    mounted.push(view);
    return { view, calls: machine.calls };
  };

  it('should title the card from the account’s keys, not from a ferret', async () => {
    const { view } = await withKeys([{ factor: APP, label: 'Authenticator app' }]);

    expect(view.container.querySelector('[data-input-title]')?.textContent).toBe(
      '!A7 · The ferret · One-time code: SMS ••42 or Authenticator app',
    );
  });

  it('should draw one "Use code from Ferretry" button per key, each sending its own key and sign-in, under the one-factor line', async () => {
    const { view, calls } = await withKeys([
      { factor: APP, label: 'Authenticator app', checked: 'worked' },
      { factor: SMS, label: 'Backup app', checked: 'failed' },
    ]);

    const buttons = [...view.container.querySelectorAll<HTMLElement>('[data-input-code-key]')];
    expect(buttons.map(button => button.textContent)).toEqual([
      'Use code from Ferretry · Authenticator appworked last time',
      'Use code from Ferretry · Backup appdid not work last time',
    ]);
    expect(view.container.querySelector('[data-input-one-factor]')?.textContent).toBe(LOGIN_ONE_FACTOR_WARNING);
    await click(buttons[1] ?? null);
    await settle();
    expect(calls.at(-1)?.body).toMatchObject({ entry: 'GITHUB', signIn: SIGN_IN, factor: SMS });
  });
});

describe('the code card host', () => {
  const served = (features: string[] | undefined) => {
    const paths: string[] = [];
    const client = {
      request: async (path: string, schema: { parse: (value: unknown) => unknown }) => {
        paths.push(path);
        if (path === '/v1/health') return schema.parse(healthOf('9.9.9', features));
        if (path === '/v1/accounts') return schema.parse(accountList([totp(APP, 'Authenticator app')]));
        return schema.parse({ requests: [codeCard([{ factor: APP, label: 'Authenticator app' }])] });
      },
    };
    return { paths, factory: async () => client as never };
  };

  const host = async (machine: ReturnType<typeof served>) => {
    const view = await mount(
      <DaemonClientProvider client={machine.factory}>
        <InputCardHost
          connection={daemonConnection({
            daemonId: 'workshop',
            baseUrl: 'https://workshop.example.test',
            deviceId: 't1',
          })}
          item={{ input: { requestId: 'ab'.repeat(16) } }}
          sessionId="sess-1"
        />
      </DaemonClientProvider>,
    );
    mounted.push(view);
    for (let tries = 0; tries < 6; tries += 1) await settle();
    return view;
  };

  it('should not read accounts, nor change the card, against a daemon that does not report 2FA keys', async () => {
    const machine = served(['messages.tail.1']);

    const view = await host(machine);

    expect(machine.paths).not.toContain('/v1/accounts');
    expect(view.container.querySelector('[data-input-title]')).toBeNull();
    expect(view.container.querySelector('[data-codes-panel]')).toBeNull();
  });

  it('should read accounts and title the card from the keys where the daemon reports 2FA keys', async () => {
    const machine = served([DAEMON_FEATURES.twoFactorKeys]);

    const view = await host(machine);

    expect(machine.paths).toContain('/v1/accounts');
    expect(view.container.querySelector('[data-input-title]')?.textContent).toContain('Code from Authenticator app');
  });
});
