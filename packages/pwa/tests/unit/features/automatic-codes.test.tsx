import { afterEach, describe, expect, it } from 'bun:test';
import {
  type AccountList,
  AccountListSchema,
  DAEMON_FEATURES,
  LOGIN_ONE_FACTOR_WARNING,
  LOGIN_TOTP_WARNING,
  TWO_FACTOR_ERROR_CODES,
  type InputRequest,
  type TwoFactorStageId,
} from '@ferretry/protocol';
import { InputCard } from '../../../src/features/input-request/input-card.tsx';
import { InputCardHost } from '../../../src/features/input-request/input-card-host.tsx';
import { daemonConnection } from '../../../src/lib/daemon-connection.ts';
import { seedFailureWords, savedSeedWords } from '../../../src/lib/automatic-codes.ts';
import { fieldsOf } from '../../../src/lib/input-card.ts';
import { createAppStore, DaemonClientProvider, StoreProvider } from '../../../src/lib/store.tsx';
import { interact, type Mounted, mount } from '../../support/dom.ts';
import { click, settle, typeInto } from '../../support/dom-form.ts';
import { healthOf } from '../../support/health.ts';
import { type Call, fakeClient, field, NOW, offer, requestOf, saved } from '../../support/input-fixtures.ts';

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

const draw = async (
  over: {
    addKey?: (stage: TwoFactorStageId, words: string) => Promise<boolean>;
    accounts?: AccountList;
    request?: InputRequest;
  } = {},
) => {
  const machine = fakeClient(answers);
  const asked: TwoFactorStageId[] = [];
  const words: string[] = [];
  const addKey =
    over.addKey ??
    (async (stage: TwoFactorStageId, said: string) => {
      asked.push(stage);
      words.push(said);
      return true;
    });
  const request = over.request ?? codeCard();
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
  return { view, q, calls: machine.calls, asked, words };
};

const interactSelect = async (element: Element | null, value: string): Promise<void> => {
  const select = element as HTMLSelectElement;
  await interact(() => {
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
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

describe('the setup panel, from the fields and the sign-in the daemon matched', () => {
  const secretFieldOnCodeCard = (): InputRequest => ({ ...codeCard(), fields: [field('secret')] });
  const seedless = (): InputRequest => ({ ...codeCard(), saved: saved({ match: 'github.com', offers: [] }) });

  it('should give a card with a secret field no panel and no code title, whatever the card says it is', async () => {
    const card = await draw({ request: secretFieldOnCodeCard() });

    expect(card.q('[data-codes-panel]')).toBeNull();
    expect(card.q('[data-input-title]')?.textContent).not.toContain('One-time code');
  });

  it('should offer the panel and the code title to an account with no key yet, matched by the card’s own key', async () => {
    const card = await draw({ request: seedless() });

    expect(card.q('[data-codes-panel]')).not.toBeNull();
    expect(card.q('[data-input-title]')?.textContent).toContain('Code sent to ••42 (SMS)');
    expect(card.q('[data-input-code-key]')).toBeNull();
    expect(card.q('[data-input-use-saved]')).toBeNull();
  });

  it('should offer no panel when no account has a sign-in at the card’s key', async () => {
    const elsewhere = { ...seedless(), saved: saved({ match: 'gitlab.com', offers: [] }) };
    const card = await draw({ request: elsewhere });

    expect(card.q('[data-codes-panel]')).toBeNull();
  });

  it('should keep the seed field out of password managers', async () => {
    const card = await draw();

    await click(card.q('[data-codes-panel] summary'));
    const seed = card.q('[data-codes-seed]');
    expect(seed?.getAttribute('autocomplete')).toBe('new-password');
    expect(seed?.getAttribute('data-1p-ignore')).toBe('');
    expect(seed?.getAttribute('data-lpignore')).toBe('true');
    expect(seed?.hasAttribute('data-bwignore')).toBe(true);
  });

  it('should start with both ticks off and Save disabled, for a key that matches and for one that does not', async () => {
    const card = await draw();

    await click(card.q('[data-codes-panel] summary'));
    await typeInto(card.q('[data-codes-seed]'), OTHER_KEY);

    expect((card.q('[data-codes-warning-tick]') as HTMLInputElement).checked).toBe(false);
    expect((card.q('[data-codes-mismatch-tick]') as HTMLInputElement).checked).toBe(false);
    expect((card.q('[data-codes-save]') as HTMLButtonElement).disabled).toBe(true);
  });

  it('should wipe the key from the field the moment the page is hidden', async () => {
    const card = await draw();

    await click(card.q('[data-codes-panel] summary'));
    await typeInto(card.q('[data-codes-seed]'), KEY);
    const original = Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState');
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    try {
      await interact(() => document.dispatchEvent(new Event('visibilitychange')));
    } finally {
      delete (document as { visibilityState?: unknown }).visibilityState;
      if (original !== undefined) Object.defineProperty(Document.prototype, 'visibilityState', original);
    }

    expect((card.q('[data-codes-seed]') as HTMLInputElement).value).toBe('');
  });

  it('should take the second tick back when the key changes', async () => {
    const card = await draw();

    await click(card.q('[data-codes-panel] summary'));
    await typeInto(card.q('[data-codes-seed]'), OTHER_KEY);
    await click(card.q('[data-codes-warning-tick]'));
    await click(card.q('[data-codes-mismatch-tick]'));
    expect((card.q('[data-codes-save]') as HTMLButtonElement).disabled).toBe(false);

    await typeInto(card.q('[data-codes-seed]'), OTHER_KEY.replaceAll('Slack', 'Linear'));

    expect((card.q('[data-codes-mismatch-tick]') as HTMLInputElement).checked).toBe(false);
    expect((card.q('[data-codes-save]') as HTMLButtonElement).disabled).toBe(true);
  });

  it('should take the second tick back when the account changes', async () => {
    const two = accountList();
    const both = AccountListSchema.parse({
      ...two,
      accounts: [
        ...two.accounts,
        { ...two.accounts[0], id: 'GITHUB2', username: 'second', signIns: ['si_fedcba9876543210'] },
      ],
      signIns: [...two.signIns, { ...two.signIns[0], id: 'si_fedcba9876543210', account: 'GITHUB2' }],
    });
    const card = await draw({ accounts: both, request: seedless() });

    await click(card.q('[data-codes-panel] summary'));
    await typeInto(card.q('[data-codes-seed]'), KEY);
    expect(card.q('[data-codes-reads]')).not.toBeNull();
    expect(card.q('[data-codes-mismatch]')).toBeNull();
    await interactSelect(card.q('[data-codes-account]'), 'GITHUB');
    await typeInto(card.q('[data-codes-seed]'), OTHER_KEY);
    await click(card.q('[data-codes-warning-tick]'));
    await click(card.q('[data-codes-mismatch-tick]'));
    expect((card.q('[data-codes-save]') as HTMLButtonElement).disabled).toBe(false);

    await interactSelect(card.q('[data-codes-account]'), 'GITHUB2');

    expect((card.q('[data-codes-mismatch-tick]') as HTMLInputElement | null)?.checked ?? false).toBe(false);
    expect((card.q('[data-codes-save]') as HTMLButtonElement).disabled).toBe(true);
  });

  it('should name the account in the passkey prompt from the daemon’s own list, never from a ferret', async () => {
    const card = await draw();

    await click(card.q('[data-codes-panel] summary'));
    await typeInto(card.q('[data-codes-seed]'), KEY);
    await click(card.q('[data-codes-warning-tick]'));
    await click(card.q('[data-codes-save]'));
    await settle();
    await settle();

    expect(card.words).toEqual(['save automatic codes to GitHub · kirinnee']);
  });

  it('should say a stage the daemon refused, clear the key, and let the owner try again', async () => {
    const machine = fakeClient(call => {
      if (call.path.endsWith('/factors/seed'))
        throw Object.assign(new Error('no'), { status: 403, code: 'passkey_required' });
      return answers(call);
    });
    const request = codeCard();
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
    const q = (selector: string) => view.container.querySelector<HTMLElement>(selector);

    await click(q('[data-codes-panel] summary'));
    await typeInto(q('[data-codes-seed]'), KEY);
    await click(q('[data-codes-warning-tick]'));
    await click(q('[data-codes-save]'));
    await settle();
    await settle();

    expect(q('[data-codes-failed]')?.textContent).toContain('Needs a passkey');
    await click(q('[data-codes-again]'));
    expect(q('[data-codes-seed]')).not.toBeNull();
    expect((q('[data-codes-warning-tick]') as HTMLInputElement).checked).toBe(false);
  });

  it('should drop the staged key when the commit fails', async () => {
    const machine = fakeClient(call => {
      if (call.path.endsWith('/commit'))
        throw Object.assign(new Error('gone'), { status: 410, code: 'stage_not_found' });
      return answers(call);
    });
    const request = codeCard();
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
    const q = (selector: string) => view.container.querySelector<HTMLElement>(selector);

    await click(q('[data-codes-panel] summary'));
    await typeInto(q('[data-codes-seed]'), KEY);
    await click(q('[data-codes-warning-tick]'));
    await click(q('[data-codes-save]'));
    await settle();
    await settle();

    expect(seedCalls(machine.calls).map(call => call.method)).toEqual(['POST', 'POST', 'DELETE']);
    expect(q('[data-codes-failed]')?.textContent).toContain('timed out');
  });
});

describe('what a failed save says, in the owner’s words', () => {
  const refused = (code: string, status = 409, message = '') => ({
    status,
    code,
    ...(message === '' ? {} : { message }),
  });

  it('should name each refusal the daemon gives, and never repeat anything pasted', () => {
    expect(seedFailureWords(refused(TWO_FACTOR_ERROR_CODES.notThisCardsAccount))).toContain('another account now');
    expect(seedFailureWords(refused(TWO_FACTOR_ERROR_CODES.mismatch))).toContain('tick the second box');
    expect(seedFailureWords(refused(TWO_FACTOR_ERROR_CODES.notAKey))).toContain('not a 2FA key');
    expect(seedFailureWords(refused(TWO_FACTOR_ERROR_CODES.tooManyStages))).toContain('Too many keys');
  });

  it('should explain a grant refusal, and fall back to the daemon’s message, then to a plain line', () => {
    expect(seedFailureWords(refused('grant_not_granted', 403))).not.toBe('');
    expect(seedFailureWords(refused('grant_not_granted', 403, 'No.'))).toContain('No.');
    expect(seedFailureWords(refused('other', 500, 'Broke.'))).toBe('Broke.');
    expect(seedFailureWords(refused('other', 500))).toBe('The daemon refused this.');
    expect(seedFailureWords(new Error('offline'))).toBe('Could not reach the machine. Nothing was saved.');
    expect(seedFailureWords(null)).toBe('Could not reach the machine. Nothing was saved.');
  });

  it('should say a first code was typed into the card when the daemon did that', () => {
    expect(savedSeedWords({ typed: true, mismatch: false }, 'GitHub')).toContain('typed the first code');
    expect(savedSeedWords({ mismatch: false }, 'GitHub')).toContain('will make GitHub’s codes');
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

  it('should draw the code buttons for another account in “Choose another account” too, with its own sign-in', async () => {
    const machine = fakeClient(() => ({ outcome: 'typed' }));
    const base = codeCard([{ factor: APP, label: 'Authenticator app' }]);
    const request: InputRequest = {
      ...base,
      saved: saved({
        match: 'github.com',
        offers: [
          offer({
            id: 'WORK',
            label: 'GitHub (work)',
            fills: 'totp',
            matched: true,
            primary: true,
            why: 'only',
            signIn: SIGN_IN,
            codes: [{ factor: APP, label: 'Authenticator app' }] as never,
          }),
          offer({
            id: 'GITHUB',
            label: 'GitHub (kirinnee)',
            fills: 'totp',
            matched: true,
            signIn: 'si_fedcba9876543210',
            codes: [{ factor: APP, label: 'Backup app' }] as never,
          }),
        ],
      }),
    };
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

    const buttons = [...view.container.querySelectorAll<HTMLElement>('[data-input-code-key]')];
    expect(buttons.map(button => button.textContent).join('|')).toContain('Use code from Ferretry · Backup app');
    await click(buttons.find(button => button.textContent?.includes('Backup app')) ?? null);
    await settle();
    expect(machine.calls.at(-1)?.body).toMatchObject({ entry: 'GITHUB', signIn: 'si_fedcba9876543210', factor: APP });
  });
});

describe('a code card with several accounts that sign in here', () => {
  const two = async (why: 'ferret' | 'only', matchedSecond = true) => {
    const base = codeCard([{ factor: APP, label: 'Authenticator app' }]);
    const request: InputRequest = {
      ...base,
      saved: saved({
        match: 'github.com',
        offers: [
          offer({
            id: 'WORK',
            label: 'GitHub (work)',
            fills: 'totp',
            matched: true,
            primary: true,
            why,
            signIn: SIGN_IN,
            codes: [{ factor: APP, label: 'Authenticator app' }] as never,
          }),
          offer({
            id: 'GITHUB',
            label: 'GitHub (kirinnee)',
            fills: 'totp',
            matched: matchedSecond,
            signIn: 'si_fedcba9876543210',
            codes: [{ factor: APP, label: 'Backup app' }] as never,
          }),
        ],
      }),
    };
    const view = await mount(
      <InputCard
        accounts={accountList([sms(SMS), totp(APP, 'Authenticator app')])}
        client={fakeClient(() => ({ outcome: 'typed' })).client}
        fields={fieldsOf(request)}
        now={NOW}
        onDone={() => undefined}
        request={request}
      />,
    );
    mounted.push(view);
    return view.container;
  };

  it('should say the ferret chose, and name the account on the lead code button, so a hint cannot pick unseen', async () => {
    const card = await two('ferret');

    expect(card.querySelector('[data-input-why]')?.textContent).toBe('Ferret chose this');
    const lead = card.querySelector('[data-variant="primary"]');
    expect(lead?.querySelector('[data-input-code-account]')?.textContent).toContain('GitHub (work)');
  });

  it('should not name the account or say "only account" when just one account matched', async () => {
    const card = await two('only', false);

    expect(card.querySelector('[data-input-why]')).toBeNull();
    expect(card.querySelector('[data-variant="primary"] [data-input-code-account]')).toBeNull();
  });
});

describe('the code card host', () => {
  const served = (
    features: string[] | undefined,
    card: InputRequest = codeCard([{ factor: APP, label: 'Authenticator app' }]),
  ) => {
    const paths: string[] = [];
    const client = {
      request: async (path: string, schema: { parse: (value: unknown) => unknown }, init?: RequestInit) => {
        paths.push(path);
        if (path.includes('/factors/seed'))
          return schema.parse(answers({ path, method: init?.method ?? 'GET', body: undefined }));
        if (path === '/v1/health') return schema.parse(healthOf('9.9.9', features));
        if (path === '/v1/accounts') return schema.parse(accountList([totp(APP, 'Authenticator app')]));
        return schema.parse({ requests: [card] });
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

  it('should draw no code panel or code title for a card whose field the daemon made a secret, even if it says code', async () => {
    const machine = served([DAEMON_FEATURES.twoFactorKeys], { ...codeCard(), fields: [field('secret')] });

    const view = await host(machine);

    // The accounts are read (secrets-gated) only to name whose sign-in it is in the title (&B137), never for keys.
    expect(view.container.querySelector('[data-codes-panel]')).toBeNull();
    expect(view.container.querySelector('[data-input-code-key]')).toBeNull();
  });

  it('should draw the plain card, no panel, when the accounts cannot be read', async () => {
    const client = {
      request: async (path: string, schema: { parse: (value: unknown) => unknown }) => {
        if (path === '/v1/health') return schema.parse(healthOf('9.9.9', [DAEMON_FEATURES.twoFactorKeys]));
        if (path === '/v1/accounts') throw new Error('unreachable');
        return schema.parse({ requests: [codeCard([{ factor: APP, label: 'Authenticator app' }])] });
      },
    };

    const view = await host({ paths: [], factory: async () => client as never });

    expect(view.container.querySelector('[data-input-code-key]')).not.toBeNull();
    expect(view.container.querySelector('[data-codes-panel]')).toBeNull();
  });

  it('should ask the app’s own passkey prompt, naming the account, when a key is saved inside the app', async () => {
    const machine = served([DAEMON_FEATURES.twoFactorKeys]);
    const store = await createAppStore({
      repository: { load: async () => null, save: async () => undefined },
      connectClient: async () => ({}) as never,
      fetcher: async () => Response.json({}),
    });
    const view = await mount(
      <StoreProvider store={store}>
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
        </DaemonClientProvider>
      </StoreProvider>,
    );
    mounted.push(view);
    for (let tries = 0; tries < 6; tries += 1) await settle();

    await click(view.container.querySelector('[data-codes-panel] summary'));
    await typeInto(view.container.querySelector('[data-codes-seed]'), KEY);
    await click(view.container.querySelector('[data-codes-warning-tick]'));
    await click(view.container.querySelector('[data-codes-save]'));
    for (let tries = 0; tries < 4; tries += 1) await settle();

    expect(store.stepUp.snapshot()?.acts).toEqual(['save automatic codes to GitHub · kirinnee']);
    store.stepUp.dismiss();
    for (let tries = 0; tries < 4; tries += 1) await settle();
    expect(view.container.querySelector('[data-codes-failed]')?.textContent).toContain('did not confirm');
  });

  it('should read accounts and title the card from the keys where the daemon reports 2FA keys', async () => {
    const machine = served([DAEMON_FEATURES.twoFactorKeys]);

    const view = await host(machine);

    expect(machine.paths).toContain('/v1/accounts');
    expect(view.container.querySelector('[data-input-title]')?.textContent).toContain('Code from Authenticator app');
  });
});
