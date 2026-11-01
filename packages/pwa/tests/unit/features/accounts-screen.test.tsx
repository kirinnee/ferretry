import { afterEach, describe, expect, it } from 'bun:test';
import { DAEMON_FEATURES, LOGIN_TOTP_WARNING, type TwoFactorStageId } from '@ferretry/protocol';
import { AccountsSurface } from '../../../src/features/accounts/accounts-surface.tsx';
import { DaemonSettingsFrame } from '../../../src/features/settings/daemon-settings-frame.tsx';
import { daemonConnection } from '../../../src/lib/daemon-connection.ts';
import { DaemonClientProvider } from '../../../src/lib/store.tsx';
import {
  APP,
  answer,
  fileOf,
  KEY,
  list,
  PROPOSAL,
  SECRET_PASSWORD,
  SI_GITHUB,
  SI_VERCEL,
  SMS,
  STAGE,
  type World,
} from '../../support/accounts-fixtures.ts';
import { interact, type Mounted, mount, must } from '../../support/dom.ts';
import { click, settle, typeInto } from '../../support/dom-form.ts';
import { healthOf } from '../../support/health.ts';
import { fakeClient, logins } from '../../support/input-fixtures.ts';

const CONNECTION = daemonConnection({ daemonId: 'workshop', baseUrl: 'https://workshop.example.test', deviceId: 't1' });
const mounted: Mounted[] = [];
afterEach(async () => {
  for (const each of mounted.splice(0)) await each.unmount();
});

const open = async (
  world: World = {},
  over: { addKey?: (stage: TwoFactorStageId, words: string) => Promise<boolean>; withKeys?: boolean } = {},
) => {
  const fake = fakeClient(answer(world));
  const view = await mount(
    <AccountsSurface
      connection={CONNECTION}
      createClient={async () => fake.client}
      {...(over.addKey === undefined ? {} : { addKey: over.addKey })}
      {...(over.withKeys === undefined ? {} : { withKeys: over.withKeys })}
    />,
  );
  mounted.push(view);
  await settle();
  await settle();
  const q = (selector: string) => view.container.querySelector<HTMLElement>(selector);
  const all = (selector: string) => [...view.container.querySelectorAll<HTMLElement>(selector)];
  const text = () => view.container.textContent ?? '';
  const tab = (id: string) => click(q(`[data-accounts-tab="${id}"]`));
  const openAccount = (id: string) => click(q(`[data-accounts-row="${id}"] button`));
  const writes = () => fake.calls.filter(call => call.method !== 'GET');
  return { ...fake, view, q, all, text, tab, openAccount, writes };
};

const choose = async (element: Element | null, value: string): Promise<void> => {
  const select = must(element, 'a select') as HTMLSelectElement;
  await interact(() => {
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
};

describe('the Accounts screen is drawn only by a daemon that reports it', () => {
  const frame = async (features: string[] | undefined, health: 'ok' | 'fail' = 'ok') => {
    const paths: string[] = [];
    const client = {
      request: async (path: string, schema: { parse: (value: unknown) => unknown }) => {
        paths.push(path);
        if (path === '/v1/health') {
          if (health === 'fail') throw new Error('down');
          return schema.parse(healthOf('9.9.9', features));
        }
        if (path === '/v1/accounts') return schema.parse(list());
        if (path.startsWith('/v1/config/file')) return schema.parse(fileOf('', false));
        if (path === '/v1/accounts/look-alike') return schema.parse({ v: 1, groups: [] });
        return schema.parse(logins());
      },
    };
    const view = await mount(
      <DaemonClientProvider client={async () => client as never}>
        <DaemonSettingsFrame
          connection={CONNECTION}
          name="Workshop"
          panel="accounts"
          onOpenPanel={() => undefined}
          readWardenStatus={async () => Promise.reject(new Error('not here'))}
          createWardenClient={async () => Promise.reject(new Error('not here'))}
        />
      </DaemonClientProvider>,
    );
    mounted.push(view);
    for (let tries = 0; tries < 8; tries += 1) await settle();
    return { view, paths, q: (selector: string) => view.container.querySelector(selector) };
  };

  it('should keep today’s saved-logins surface on a daemon that does not report accounts', async () => {
    const machine = await frame(['messages.tail.1']);

    expect(machine.q('[data-accounts-screen]')).toBeNull();
    expect(machine.q('[data-login]')).not.toBeNull();
    expect(machine.paths).not.toContain('/v1/accounts');
  });

  it('should keep the saved-logins surface when the health read fails, not guess', async () => {
    const machine = await frame([DAEMON_FEATURES.accountsSignIns], 'fail');

    expect(machine.q('[data-accounts-screen]')).toBeNull();
    expect(machine.q('[data-login]')).not.toBeNull();
  });

  it('should draw the accounts screen on a daemon that reports it', async () => {
    const machine = await frame([DAEMON_FEATURES.accountsSignIns, DAEMON_FEATURES.twoFactorKeys]);

    expect(machine.q('[data-accounts-screen]')).not.toBeNull();
    expect(machine.q('[data-login]')).toBeNull();
  });

  it('should offer no 2FA keys tab on a daemon that reports accounts but not 2FA keys', async () => {
    const machine = await frame([DAEMON_FEATURES.accountsSignIns]);

    await click(machine.q('[data-accounts-row="GITHUB"] button'));
    expect(machine.q('[data-accounts-tab="details"]')).not.toBeNull();
    expect(machine.q('[data-accounts-tab="keys"]')).toBeNull();
  });
});

describe('the list', () => {
  it('should group accounts by site and keep a signed-out account in its own section', async () => {
    const screen = await open();

    expect(screen.all('[data-accounts-site-group]').map(each => each.getAttribute('data-accounts-site-group'))).toEqual(
      ['github.com', 'vercel.com'],
    );
    expect(
      screen
        .all('[data-accounts-site-group="github.com"] [data-accounts-row]')
        .map(each => each.getAttribute('data-accounts-row')),
    ).toEqual(['GITHUB', 'GITHUB_WORK']);
    expect(
      screen.all('[data-accounts-unplaced] [data-accounts-row]').map(each => each.getAttribute('data-accounts-row')),
    ).toEqual(['GOOGLE']);
  });

  it('should say a damaged store is damaged and never "no accounts"', async () => {
    const screen = await open({
      accounts: list({ health: 'damaged', diagnosis: 'accounts.json would not parse' }),
    });

    expect(screen.q('[data-accounts-damaged]')?.textContent).toContain('accounts.json would not parse');
    expect(screen.q('[data-accounts-empty]')).toBeNull();
  });

  it('should say a failed read is a refusal, not an empty list', async () => {
    const view = await mount(
      <AccountsSurface
        connection={CONNECTION}
        createClient={async () => {
          throw new Error('the relay is down');
        }}
      />,
    );
    mounted.push(view);
    await settle();

    expect(view.container.textContent).toContain('Accounts unavailable');
    expect(view.container.textContent).toContain('the relay is down');
  });
});

describe('an account’s Details', () => {
  it('should keep the password write-only: never in the page, and only sent when typed', async () => {
    const screen = await open();
    await screen.openAccount('GITHUB');

    expect(screen.q('[data-accounts-password]')?.getAttribute('type')).toBe('password');
    expect((screen.q('[data-accounts-password]') as HTMLInputElement).value).toBe('');
    expect(screen.q('[data-accounts-password-state]')?.textContent).toContain('write-only');

    await typeInto(screen.q('[data-accounts-username]'), 'kirinnee2');
    await click(screen.q('[data-accounts-save]'));
    await settle();
    expect(screen.writes()[0]?.body).toEqual({ username: 'kirinnee2' });

    await typeInto(screen.q('[data-accounts-password]'), SECRET_PASSWORD);
    await typeInto(screen.q('[data-accounts-username]'), 'kirinnee3');
    await click(screen.q('[data-accounts-save]'));
    await settle();
    expect(screen.writes()[1]).toMatchObject({ method: 'PUT', path: '/v1/accounts/GITHUB' });
    expect(screen.writes()[1]?.body).toMatchObject({ password: SECRET_PASSWORD });
    expect((screen.q('[data-accounts-password]') as HTMLInputElement).value).toBe('');
    expect(screen.text()).not.toContain(SECRET_PASSWORD);
  });

  it('should ask twice before removing an account', async () => {
    const screen = await open();
    await screen.openAccount('GOOGLE');

    await click(screen.q('[data-accounts-remove]'));
    expect(screen.writes()).toEqual([]);
    await click(screen.q('[data-accounts-confirm-remove]'));
    await settle();

    expect(screen.writes()[0]).toMatchObject({ method: 'DELETE', path: '/v1/accounts/GOOGLE' });
  });
});

describe('an account’s 2FA keys', () => {
  it('should list each key with what is true of it, and no secret', async () => {
    const screen = await open();
    await screen.openAccount('GITHUB');
    await screen.tab('keys');

    expect(screen.all('[data-accounts-key]').map(each => each.getAttribute('data-accounts-key'))).toEqual([SMS, APP]);
    expect(screen.q(`[data-accounts-key="${SMS}"]`)?.textContent).toContain('••42');
    expect(screen.q(`[data-accounts-key="${APP}"]`)?.getAttribute('data-accounts-key-state')).toBe('verified');
    expect(screen.q(`[data-accounts-key="${SMS}"]`)?.hasAttribute('data-accounts-key-state')).toBe(false);
  });

  it('should add a label for an SMS key through the keys route, with no seed', async () => {
    const screen = await open();
    await screen.openAccount('GITHUB');
    await screen.tab('keys');

    await click(screen.q('[data-accounts-key-add-open]'));
    await choose(screen.q('[data-accounts-key-kind]'), 'sms');
    await typeInto(screen.q('[data-accounts-key-label]'), 'Work phone');
    await typeInto(screen.q('[data-accounts-key-fact]'), '99');
    await click(screen.q('[data-accounts-key-add]'));
    await settle();

    expect(screen.writes()[0]).toMatchObject({ method: 'POST', path: '/v1/accounts/GITHUB/factors' });
    expect(screen.writes()[0]?.body).toEqual({ kind: 'sms', label: 'Work phone', endsWith: '99' });
  });

  it('should remove a key only after a second press', async () => {
    const screen = await open();
    await screen.openAccount('GITHUB');
    await screen.tab('keys');

    await click(screen.q(`[data-accounts-key="${SMS}"] [data-accounts-key-remove]`));
    expect(screen.writes()).toEqual([]);
    await click(screen.q(`[data-accounts-key="${SMS}"] [data-accounts-key-confirm]`));
    await settle();

    expect(screen.writes()[0]).toMatchObject({ method: 'DELETE', path: `/v1/accounts/GITHUB/factors/${SMS}` });
  });

  it('should save automatic codes through the SAME stage → passkey → commit flow as the input card, with no card', async () => {
    const asked: TwoFactorStageId[] = [];
    const screen = await open(
      {},
      {
        addKey: async stage => {
          asked.push(stage);
          return true;
        },
      },
    );
    await screen.openAccount('GITHUB');
    await screen.tab('keys');

    await click(screen.q('[data-codes-panel] summary'));
    await typeInto(screen.q('[data-codes-seed]'), KEY);
    expect(screen.q('[data-codes-warning]')?.textContent).toBe(LOGIN_TOTP_WARNING);
    expect((screen.q('[data-codes-save]') as HTMLButtonElement).disabled).toBe(true);
    await click(screen.q('[data-codes-warning-tick]'));
    await click(screen.q('[data-codes-save]'));
    await settle();
    await settle();

    const seed = screen.writes().filter(call => call.path.includes('/factors/seed'));
    expect(seed[0]?.path).toBe('/v1/accounts/GITHUB/factors/seed');
    expect(seed[0]?.body).toMatchObject({ totpAcknowledged: true });
    expect(seed[0]?.body).not.toHaveProperty('request');
    expect(asked).toEqual([STAGE]);
    expect(seed[1]?.path).toBe(`/v1/accounts/GITHUB/factors/seed/${STAGE}/commit`);
    expect(seed[1]?.body).toBeUndefined();
    expect(JSON.stringify(seed.slice(1))).not.toContain('JBSWY3DPEHPK3PXP');
  });

  it('should offer no way to save a seed where this browser has no passkey prompt, and say so', async () => {
    const screen = await open();
    await screen.openAccount('GITHUB');
    await screen.tab('keys');

    expect(screen.q('[data-codes-panel]')).toBeNull();
    expect(screen.q('[data-accounts-codes-unavailable]')).not.toBeNull();
  });

  it('should offer no keys tab when the machine has no 2FA keys', async () => {
    const screen = await open({}, { withKeys: false });
    await screen.openAccount('GITHUB');

    expect(screen.q('[data-accounts-tab="keys"]')).toBeNull();
  });
});

describe('a site row', () => {
  const site = async (world: World = {}) => {
    const screen = await open(world);
    await screen.openAccount('GITHUB');
    await screen.tab('sites');
    await click(screen.q(`[data-accounts-signin="${SI_GITHUB}"] button`));
    return screen;
  };

  it('should show the recipe as plain text, labelled as the ferret’s', async () => {
    const screen = await site();
    await screen.tab('recipe');

    expect(screen.q('[data-accounts-recipe-body]')?.textContent).toBe(
      '# Sign in\n<script>alert(1)</script>\nClick **Sign in**.',
    );
    expect(screen.q('[data-accounts-recipe-body] script')).toBeNull();
    expect(screen.q('[data-accounts-recipe-body] strong')).toBeNull();
    expect(screen.q('[data-accounts-recipe-unreviewed]')?.textContent).toContain('ferret');
  });

  it('should show a ferret’s proposal as the ferret’s and send the owner’s decision as a person write', async () => {
    const screen = await site();
    await screen.tab('recipe');

    expect(screen.q('[data-accounts-proposal]')?.textContent).toContain('The ferret says: The button moved');
    await click(screen.q('[data-accounts-proposal-approve]'));
    await settle();
    await click(screen.q('[data-accounts-proposal-decline]'));
    await settle();

    expect(screen.writes().map(call => `${call.method} ${call.path}`)).toEqual([
      `POST /v1/accounts/sign-ins/${SI_GITHUB}/recipe/proposals/${PROPOSAL}`,
      `POST /v1/accounts/sign-ins/${SI_GITHUB}/recipe/proposals/${PROPOSAL}`,
    ]);
    expect(screen.writes().map(call => call.body)).toEqual([{ decision: 'approve' }, { decision: 'decline' }]);
  });

  it('should say what Ferretry saw there, in words', async () => {
    const screen = await site();
    await screen.tab('seen');

    expect(screen.text()).toContain('github.com');
    expect(screen.q('[data-accounts-seen-empty]')).toBeNull();
  });

  it('should change the method with a person write', async () => {
    const screen = await site();
    await screen.tab('method');

    await choose(screen.q('[data-accounts-method]'), 'sso');
    await typeInto(screen.q('[data-accounts-sso]'), 'Google');
    await click(screen.q('[data-accounts-method-save]'));
    await settle();

    expect(screen.writes()[0]).toMatchObject({ method: 'PUT', path: `/v1/accounts/sign-ins/${SI_GITHUB}` });
    expect(screen.writes()[0]?.body).toMatchObject({ method: { kind: 'sso' } });
  });
});

describe('defaults on a site row', () => {
  const defaultsTab = async (world: World) => {
    const screen = await open(world);
    await screen.openAccount('VERCEL');
    await screen.tab('sites');
    await click(screen.q(`[data-accounts-signin="${SI_VERCEL}"] button`));
    await screen.tab('defaults');
    return screen;
  };

  it('should list every host the sign-in names, the match host too, and star one for a key', async () => {
    const screen = await defaultsTab({});

    expect(
      screen.all('[data-accounts-default-key]').map(each => each.getAttribute('data-accounts-default-key')),
    ).toEqual(['vercel.com', 'app.vercel.com']);
    await click(screen.q('[data-accounts-default-key="app.vercel.com"] [data-accounts-default-set]'));
    await settle();

    expect(screen.writes()[0]).toMatchObject({ method: 'PUT', path: '/v1/accounts/defaults' });
    expect(screen.writes()[0]?.body).toEqual({ scope: 'sites', key: 'app.vercel.com', account: 'VERCEL' });
  });

  it('should clear a default by sending no account', async () => {
    const screen = await defaultsTab({ defaults: 'sites:\n  vercel.com: VERCEL\n' });

    await click(screen.q('[data-accounts-default-key="vercel.com"] [data-accounts-default-clear]'));
    await settle();

    expect(screen.writes()[0]?.body).toEqual({ scope: 'sites', key: 'vercel.com', account: null });
  });

  it('should say an unreadable defaults file is unreadable, and offer no change on top of it', async () => {
    const screen = await defaultsTab({ defaults: 'sites: [oops' });

    expect(screen.q('[data-accounts-defaults-unreadable]')).not.toBeNull();
    expect(screen.q('[data-accounts-default-set]')).toBeNull();
  });

  it('should say a daemon’s refusal in its words', async () => {
    const screen = await defaultsTab({
      refuse: call =>
        call.path === '/v1/accounts/defaults' ? 'no_sign_in_here: VERCEL has no sign-in at that key' : undefined,
    });

    await click(screen.q('[data-accounts-default-key="vercel.com"] [data-accounts-default-set]'));
    await settle();

    expect(screen.q('[data-accounts-error]')?.textContent).toContain('no_sign_in_here');
  });
});

describe('look-alike accounts', () => {
  it('should show a banner and merge into the account the owner keeps', async () => {
    const screen = await open({ groups: [['GITHUB', 'GITHUB_WORK']] });

    expect(screen.q('[data-accounts-lookalike]')).not.toBeNull();
    await click(screen.q('[data-accounts-merge]'));
    await choose(screen.q('[data-accounts-merge-keep]'), 'GITHUB');
    await click(screen.q('[data-accounts-merge-confirm]'));
    await settle();

    expect(screen.writes()[0]).toMatchObject({ method: 'POST', path: '/v1/accounts/GITHUB/merge' });
    expect(screen.writes()[0]?.body).toEqual({ from: 'GITHUB_WORK' });
  });

  it('should keep two accounts apart with a person write', async () => {
    const screen = await open({ groups: [['GITHUB', 'GITHUB_WORK']] });

    await click(screen.q('[data-accounts-apart]'));
    await settle();

    expect(screen.writes()[0]).toMatchObject({ method: 'POST' });
    expect(screen.writes()[0]?.path).toMatch(/^\/v1\/accounts\/(GITHUB|GITHUB_WORK)\/apart$/u);
  });

  it('should show no banner, and still the list, on a daemon without the route', async () => {
    const screen = await open({ groups: 'missing' });

    expect(screen.q('[data-accounts-lookalike]')).toBeNull();
    expect(screen.q('[data-accounts-screen]')).not.toBeNull();
    expect(screen.all('[data-accounts-row]').length).toBeGreaterThan(0);
  });
});
