import { afterEach, describe, expect, it } from 'bun:test';
import { LOGIN_TOTP_WARNING, type LoginEntryList, type PutLoginEntryRequest } from '@ferretry/protocol';
import { LoginsCard } from '../../../src/features/secrets/logins-card.tsx';
import { interact, type Mounted, mount, must } from '../../support/dom.ts';
import { byText, click, settle, typeInto } from '../../support/dom-form.ts';
import { login, logins, signInLogins } from '../../support/input-fixtures.ts';

const mounted: Mounted[] = [];
afterEach(async () => {
  for (const each of mounted.splice(0)) await each.unmount();
});

const PASSWORD = 'hunter2-hunter2';
const SEED = 'JBSWY3DPEHPK3PXP';

const show = async (list: LoginEntryList = logins()) => {
  const puts: { id: string; body: PutLoginEntryRequest }[] = [];
  const renames: { id: string; to: string }[] = [];
  const removes: string[] = [];
  const view = await mount(
    <LoginsCard
      list={list}
      onPut={async (id, body) => {
        puts.push({ id, body });
        return true;
      }}
      onRename={async (id, to) => {
        renames.push({ id, to });
        return true;
      }}
      onRemove={async id => {
        removes.push(id);
        return true;
      }}
    />,
  );
  mounted.push(view);
  const q = <T extends Element = HTMLElement>(selector: string): T | null => view.container.querySelector<T>(selector);
  return { view, q, puts, renames, removes };
};

const row = (view: { q: (selector: string) => HTMLElement | null }, id: string): HTMLElement =>
  must(view.q(`[data-login="${id}"]`), `the ${id} row`);
const inRow = (element: HTMLElement, selector: string): HTMLElement =>
  must(element.querySelector<HTMLElement>(selector), selector);

describe('the saved logins list', () => {
  it('shows label, match, username and which secret fields exist, and never a value', async () => {
    const view = await show();
    const github = row(view, 'GITHUB_KIRINNEE');
    const sudo = row(view, 'SUDO_KIRIN_BOX');

    expect(inRow(github, '[data-login-label]').textContent).toBe('GitHub (kirinnee)');
    expect(inRow(github, '[data-login-match]').textContent).toContain('github.com');
    expect(inRow(github, '[data-login-username]').textContent).toContain('kirinnee');
    expect(inRow(github, '[data-login-fields]').textContent).toBe('password ✓ · no 2FA');
    expect(inRow(sudo, '[data-login-fields]').textContent).toBe('password ✓ · 2FA ✓');
    expect(view.view.container.querySelectorAll('input')).toHaveLength(0);
  });

  it('says a damaged store is damaged, and not that it is empty', async () => {
    const view = await show(logins({ health: 'damaged', diagnosis: 'the vault file did not decrypt', entries: [] }));

    expect(view.q('[data-testid="logins-damaged"]')?.textContent).toContain('cannot read its saved logins');
    expect(view.q('[data-testid="logins-damaged"]')?.textContent).toContain('the vault file did not decrypt');
    expect(view.q('[data-testid="logins-damaged"]')?.textContent).toContain('It is not empty');
    expect(view.q('[data-testid="logins-empty"]')).toBeNull();
    expect(view.q('[data-login-add-open]')).toBeNull();
  });

  it('says there are none only when the store is healthy and empty', async () => {
    const view = await show(logins({ entries: [] }));
    expect(view.q('[data-testid="logins-empty"]')?.textContent).toContain('No saved logins');
  });
});

describe('adding a login', () => {
  it('sends the label, match, username and password, and clears the password box', async () => {
    const view = await show(logins({ entries: [] }));

    await click(view.q('[data-login-add-open]'));
    await typeInto(view.q('[data-login-new-label]'), 'GitHub (kirinnee)');
    expect(must(view.q<HTMLInputElement>('[data-login-new-id]'), 'handle').value).toBe('GITHUB_KIRINNEE');
    await typeInto(view.q('[data-login-new-match]'), 'github.com');
    await typeInto(view.q('[data-login-new-username]'), 'kirinnee');
    const password = must(view.q<HTMLInputElement>('[data-login-new-password]'), 'password');
    expect(password.type).toBe('password');
    await typeInto(password, PASSWORD);
    await click(byText(view.view.container, 'button', 'Add login'));
    await settle();

    expect(view.puts).toEqual([
      {
        id: 'GITHUB_KIRINNEE',
        body: { label: 'GitHub (kirinnee)', match: ['github.com'], username: 'kirinnee', password: PASSWORD },
      },
    ]);
    expect(view.view.container.textContent).not.toContain(PASSWORD);
  });

  it('will not add a password shorter than the vault keeps', async () => {
    const view = await show(logins({ entries: [] }));
    await click(view.q('[data-login-add-open]'));
    await typeInto(view.q('[data-login-new-label]'), 'Short');
    await typeInto(view.q('[data-login-new-password]'), 'abc');

    expect(byText(view.view.container, 'button', 'Add login').hasAttribute('disabled')).toBe(true);
    expect(view.q('[data-login-problem]')?.textContent).toContain('at least 8');
  });
});

describe('editing, replacing, renaming and deleting', () => {
  it('edits label, match and username, sending only what changed', async () => {
    const view = await show();
    const github = row(view, 'GITHUB_KIRINNEE');

    await click(inRow(github, '[aria-label="Edit GitHub (kirinnee)"]'));
    await typeInto(view.q('[data-login-edit-label]'), 'GitHub');
    await click(byText(github, 'button', 'Save changes'));
    await settle();

    expect(view.puts).toEqual([{ id: 'GITHUB_KIRINNEE', body: { label: 'GitHub' } }]);
  });

  it('replaces a password through a write-only field and sends nothing else', async () => {
    const view = await show();
    const github = row(view, 'GITHUB_KIRINNEE');

    await click(inRow(github, '[aria-label="Replace password for GitHub (kirinnee)"]'));
    const field = must(view.q<HTMLInputElement>('[data-login-replace-password]'), 'the field');
    expect(field.type).toBe('password');
    expect(field.value).toBe('');
    await typeInto(field, PASSWORD);
    await click(byText(github, 'button', 'Replace password'));
    await settle();

    expect(view.puts).toEqual([{ id: 'GITHUB_KIRINNEE', body: { password: PASSWORD } }]);
  });

  it('renames the handle', async () => {
    const view = await show();
    const github = row(view, 'GITHUB_KIRINNEE');

    await click(inRow(github, '[aria-label="Rename handle of GitHub (kirinnee)"]'));
    await typeInto(view.q('[data-login-rename-handle]'), 'gh');
    await click(byText(github, 'button', 'Rename'));
    await settle();

    expect(view.renames).toEqual([{ id: 'GITHUB_KIRINNEE', to: 'GH' }]);
  });

  it('asks before deleting', async () => {
    const view = await show();
    const github = row(view, 'GITHUB_KIRINNEE');

    await click(inRow(github, '[aria-label="Delete GitHub (kirinnee)"]'));
    expect(view.removes).toEqual([]);
    expect(inRow(github, '[data-login-confirm]').textContent).toContain('This cannot be undone');
    await click(byText(github, 'button', 'Keep it'));
    expect(view.removes).toEqual([]);

    await click(inRow(github, '[aria-label="Delete GitHub (kirinnee)"]'));
    await click(inRow(github, '[data-login-confirm-delete]'));
    await settle();

    expect(view.removes).toEqual(['GITHUB_KIRINNEE']);
  });
});

describe('2FA', () => {
  const open = async () => {
    const view = await show();
    const github = row(view, 'GITHUB_KIRINNEE');
    expect(view.q('[data-login-totp]')).toBeNull();
    await click(inRow(github, '[aria-label="Add 2FA seed to GitHub (kirinnee)"]'));
    return { view, github };
  };
  const submit = (github: HTMLElement) =>
    must(github.querySelector<HTMLButtonElement>('[data-login-totp] button[type="submit"]'), 'the submit');

  it('is off until asked for, and shows the warning verbatim when opened', async () => {
    const { view } = await open();
    expect(view.q('[data-login-totp-warning]')?.textContent).toBe(LOGIN_TOTP_WARNING);
  });

  it('will not send a seed without the explicit tick', async () => {
    const { view, github } = await open();
    await typeInto(view.q('[data-login-totp-seed]'), SEED);

    expect(submit(github).disabled).toBe(true);
    await click(view.q('[data-login-totp-ack]'));
    expect(submit(github).disabled).toBe(false);
  });

  it('sends the seed with the acknowledgement once ticked', async () => {
    const { view, github } = await open();
    await typeInto(view.q('[data-login-totp-seed]'), SEED);
    await click(view.q('[data-login-totp-ack]'));

    await click(submit(github));
    await settle();

    expect(view.puts).toEqual([{ id: 'GITHUB_KIRINNEE', body: { totp: { seed: SEED }, totpAcknowledged: true } }]);
  });

  it('removes 2FA with null', async () => {
    const view = await show();
    const sudo = row(view, 'SUDO_KIRIN_BOX');

    await click(inRow(sudo, '[aria-label="Remove 2FA from sudo on kirin-box"]'));
    await settle();

    expect(view.puts).toEqual([{ id: 'SUDO_KIRIN_BOX', body: { totp: null } }]);
  });
});

describe('write-only', () => {
  it('offers no way to reveal or copy a stored value', async () => {
    const view = await show();
    const labels = [...view.view.container.querySelectorAll('button')].map(
      button => `${button.getAttribute('aria-label') ?? ''} ${button.textContent ?? ''}`,
    );
    expect(labels.some(label => /\b(show|reveal|copy|view)\b/iu.test(label))).toBe(false);
    expect(login().fields).toEqual({ password: true, totp: false });
  });
});

describe('the add form and the rename', () => {
  it('keeps a handle the person typed, instead of following the label', async () => {
    const view = await show(logins({ entries: [] }));
    await click(view.q('[data-login-add-open]'));

    await typeInto(view.q('[data-login-new-id]'), 'my handle');
    await typeInto(view.q('[data-login-new-label]'), 'GitHub (kirinnee)');

    expect(must(view.q<HTMLInputElement>('[data-login-new-id]'), 'handle').value).toBe('MY_HANDLE');
  });

  it('says a handle is taken, and does not rename onto it', async () => {
    const view = await show();
    const github = row(view, 'GITHUB_KIRINNEE');

    await click(inRow(github, '[aria-label="Rename handle of GitHub (kirinnee)"]'));
    await typeInto(view.q('[data-login-rename-handle]'), 'sudo_kirin_box');

    expect(github.textContent).toContain('SUDO_KIRIN_BOX already exists.');
    expect(byText(github, 'button', 'Rename').hasAttribute('disabled')).toBe(true);
  });

  it('shows the refusal of a write above the list', async () => {
    const view = await mount(
      <LoginsCard
        error="the vault is locked"
        list={logins()}
        onPut={async () => false}
        onRename={async () => false}
        onRemove={async () => false}
      />,
    );
    mounted.push(view);

    expect(view.container.querySelector('[data-testid="logins-error"]')?.textContent).toBe('the vault is locked');
  });
});

const choose = async (element: HTMLElement | null, value: string): Promise<void> => {
  const select = must(element, 'a select') as HTMLSelectElement;
  await interact(() => {
    must(Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set, 'a value setter').call(
      select,
      value,
    );
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
};

const optionValues = (select: HTMLElement | null): string[] =>
  [...must(select, 'a select').querySelectorAll('option')].map(option => (option as HTMLOptionElement).value);

describe('how a login signs in', () => {
  it('shows each row its method in words and its login domains; a password one says Password', async () => {
    const view = await show(signInLogins());

    expect(inRow(row(view, 'VERCEL'), '[data-login-method]').textContent).toBe(
      "Sign in with Google via 'Google (kirin@…)'",
    );
    expect(inRow(row(view, 'VERCEL'), '[data-login-domains]').textContent).toContain('app.vercel.com');
    expect(inRow(row(view, 'GOOGLE_KIRIN'), '[data-login-domains]').textContent).toContain('accounts.google.com');
    expect(inRow(row(view, 'GITHUB_KIRINNEE'), '[data-login-method]').textContent).toBe('Password');
  });

  it('reads an entry from an older daemon as Password, with its web match hosts as login domains', async () => {
    const view = await show(logins());

    expect(inRow(row(view, 'GITHUB_KIRINNEE'), '[data-login-method]').textContent).toBe('Password');
    expect(inRow(row(view, 'GITHUB_KIRINNEE'), '[data-login-domains]').textContent).toContain('github.com');
    expect(row(view, 'SUDO_KIRIN_BOX').querySelector('[data-login-domains]')).toBeNull();
  });

  it('adds a login with a provider method, the provider login it goes via, and normalised login domains', async () => {
    const view = await show(signInLogins());

    await click(view.q('[data-login-add-open]'));
    expect(optionValues(view.q('[data-login-new-method]'))).toEqual([
      'password',
      'google',
      'github',
      'microsoft',
      'apple',
      'sso',
    ]);
    expect(view.q('[data-login-new-via]')).toBeNull();
    await typeInto(view.q('[data-login-new-label]'), 'Linear');
    await choose(view.q('[data-login-new-method]'), 'google');
    expect(optionValues(view.q('[data-login-new-via]'))).toEqual(['', 'VERCEL', 'GOOGLE_KIRIN', 'GITHUB_KIRINNEE']);
    await choose(view.q('[data-login-new-via]'), 'GOOGLE_KIRIN');
    await typeInto(view.q('[data-login-new-domains]'), 'https://App.Linear.app/login, accounts.google.com');
    await typeInto(view.q('[data-login-new-password]'), PASSWORD);
    await click(byText(view.view.container, 'button', 'Add login'));
    await settle();

    expect(view.puts).toEqual([
      {
        id: 'LINEAR',
        body: {
          label: 'Linear',
          match: [],
          method: { kind: 'google', via: 'GOOGLE_KIRIN' },
          domains: ['app.linear.app', 'accounts.google.com'],
          password: PASSWORD,
        },
      },
    ]);
  });

  it('asks for the SSO provider name, refuses a passkey one, and has no passkey option', async () => {
    const view = await show(logins({ entries: [] }));

    await click(view.q('[data-login-add-open]'));
    await typeInto(view.q('[data-login-new-label]'), 'Acme');
    await typeInto(view.q('[data-login-new-password]'), PASSWORD);
    await choose(view.q('[data-login-new-method]'), 'sso');
    expect(view.q('[data-login-new-sso-name]')).not.toBeNull();
    expect(byText(view.view.container, 'button', 'Add login').hasAttribute('disabled')).toBe(true);
    expect(view.q('[data-login-problem]')?.textContent).toContain('Name the SSO provider');

    await typeInto(view.q('[data-login-new-sso-name]'), 'Passkey');
    expect(byText(view.view.container, 'button', 'Add login').hasAttribute('disabled')).toBe(true);
    expect(view.q('[data-login-problem]')?.textContent).toContain('passkeys are off');

    await typeInto(view.q('[data-login-new-sso-name]'), 'Okta');
    expect(byText(view.view.container, 'button', 'Add login').hasAttribute('disabled')).toBe(false);
    await click(byText(view.view.container, 'button', 'Add login'));
    await settle();
    expect(view.puts[0]?.body.method).toEqual({ kind: 'sso', name: 'Okta' });
    expect(view.view.container.textContent?.toLowerCase()).not.toContain('passkey option');
  });

  it('says a login domain that is not a web host', async () => {
    const view = await show(logins({ entries: [] }));

    await click(view.q('[data-login-add-open]'));
    await typeInto(view.q('[data-login-new-label]'), 'Acme');
    await typeInto(view.q('[data-login-new-password]'), PASSWORD);
    await typeInto(view.q('[data-login-new-domains]'), 'not a host!');

    expect(byText(view.view.container, 'button', 'Add login').hasAttribute('disabled')).toBe(true);
    expect(view.q('[data-login-problem]')?.textContent).toContain('is not a web host');
  });

  it('prefills the edit form, lists every OTHER login as a via, and sends the whole method', async () => {
    const view = await show(signInLogins());
    const vercel = row(view, 'VERCEL');

    await click(inRow(vercel, '[aria-label="Edit Vercel"]'));
    expect(must(view.q<HTMLSelectElement>('[data-login-edit-method]'), 'method').value).toBe('google');
    expect(optionValues(view.q('[data-login-edit-via]'))).toEqual(['', 'GOOGLE_KIRIN', 'GITHUB_KIRINNEE']);
    expect(must(view.q<HTMLSelectElement>('[data-login-edit-via]'), 'via').value).toBe('GOOGLE_KIRIN');
    expect(must(view.q<HTMLInputElement>('[data-login-edit-domains]'), 'domains').value).toBe('app.vercel.com');

    await choose(view.q('[data-login-edit-method]'), 'github');
    await typeInto(view.q('[data-login-edit-domains]'), 'app.vercel.com, vercel.com');
    await click(byText(vercel, 'button', 'Save changes'));
    await settle();

    expect(view.puts).toEqual([
      {
        id: 'VERCEL',
        body: { method: { kind: 'github', via: 'GOOGLE_KIRIN' }, domains: ['app.vercel.com', 'vercel.com'] },
      },
    ]);
  });

  it('forgets a half-made sign-in change on Cancel, so the next edit starts from what is saved', async () => {
    const view = await show(signInLogins());
    const vercel = row(view, 'VERCEL');

    await click(inRow(vercel, '[aria-label="Edit Vercel"]'));
    await choose(view.q('[data-login-edit-method]'), 'github');
    await click(byText(vercel, 'button', 'Cancel'));
    await click(inRow(vercel, '[aria-label="Edit Vercel"]'));

    expect(must(view.q<HTMLSelectElement>('[data-login-edit-method]'), 'method').value).toBe('google');
    expect(view.puts).toEqual([]);
  });

  it('prefills an older entry with its web match hosts and sends nothing until something changes', async () => {
    const view = await show();
    const github = row(view, 'GITHUB_KIRINNEE');

    await click(inRow(github, '[aria-label="Edit GitHub (kirinnee)"]'));
    expect(must(view.q<HTMLSelectElement>('[data-login-edit-method]'), 'method').value).toBe('password');
    expect(view.q('[data-login-edit-via]')).toBeNull();
    expect(must(view.q<HTMLInputElement>('[data-login-edit-domains]'), 'domains').value).toBe('github.com');
    expect(byText(github, 'button', 'Save changes').hasAttribute('disabled')).toBe(true);

    await choose(view.q('[data-login-edit-method]'), 'password');
    expect(byText(github, 'button', 'Save changes').hasAttribute('disabled')).toBe(true);
    expect(view.puts).toEqual([]);
  });
});
