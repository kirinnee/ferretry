import { afterEach, describe, expect, it } from 'bun:test';
import type { LoginEntryList } from '@ferretry/protocol';
import { LoginsSurface } from '../../../src/features/secrets/logins-surface.tsx';
import { daemonConnection } from '../../../src/lib/daemon-connection.ts';
import { type Mounted, mount, must } from '../../support/dom.ts';
import { byText, click, settle, typeInto } from '../../support/dom-form.ts';
import { type Call, fakeClient, logins } from '../../support/input-fixtures.ts';

const CONNECTION = daemonConnection({ daemonId: 'workshop', baseUrl: 'https://workshop.example.test', deviceId: 't1' });
const OTHER = daemonConnection({ daemonId: 'laptop', baseUrl: 'https://laptop.example.test', deviceId: 't2' });
const mounted: Mounted[] = [];

afterEach(async () => {
  for (const each of mounted.splice(0)) await each.unmount();
});

const surface = async (
  answer: (call: Call) => unknown,
  connection = CONNECTION,
  createClient?: () => Promise<never>,
) => {
  const fake = fakeClient(answer);
  const view = await mount(
    <LoginsSurface connection={connection} createClient={createClient ?? (async () => fake.client)} />,
  );
  mounted.push(view);
  await settle();
  return { ...fake, view, text: () => view.container.textContent ?? '' };
};

describe('the accounts surface', () => {
  it('reads the daemon list through a client for this machine', async () => {
    const { calls, view } = await surface(() => logins());

    expect(calls.map(call => `${call.method} ${call.path}`)).toEqual(['GET /v1/secrets/logins']);
    expect(view.container.querySelector('[data-login="GITHUB_KIRINNEE"]')).not.toBeNull();
  });

  it('says it is reading while the list is on its way', async () => {
    const view = await mount(
      <LoginsSurface connection={CONNECTION} createClient={() => new Promise<never>(() => undefined)} />,
    );
    mounted.push(view);

    expect(view.container.querySelector('[aria-label="Loading accounts"]')).not.toBeNull();
  });

  it('says a failed read is a refusal and not an empty list, for an error or a bare cause', async () => {
    const error = await surface(
      () => logins(),
      CONNECTION,
      async () => {
        throw new Error('the relay is down');
      },
    );
    expect(error.text()).toContain('Accounts unavailable');
    expect(error.text()).toContain('the relay is down');

    const bare = await surface(
      () => logins(),
      CONNECTION,
      async () => {
        throw 'offline';
      },
    );
    expect(bare.text()).toContain('offline');
  });

  const github = (view: Mounted): HTMLElement =>
    must(view.container.querySelector<HTMLElement>('[data-login="GITHUB_KIRINNEE"]'), 'the GitHub row');

  const remove = async (view: Mounted): Promise<void> => {
    await click(must(github(view).querySelector('[aria-label="Delete GitHub (kirinnee)"]'), 'Delete'));
    await click(must(github(view).querySelector('[data-login-confirm-delete]'), 'confirm'));
    await settle();
  };

  it('writes, then re-reads so the screen is what the daemon holds', async () => {
    let list: LoginEntryList = logins();
    const { calls, view } = await surface(call => {
      if (call.method === 'DELETE') {
        list = { ...list, entries: list.entries.filter(entry => entry.id !== 'GITHUB_KIRINNEE') };
        return { id: 'GITHUB_KIRINNEE', removed: true };
      }
      return list;
    });

    await remove(view);

    expect(calls.map(call => call.method)).toEqual(['GET', 'DELETE', 'GET']);
    expect(view.container.querySelector('[data-login="GITHUB_KIRINNEE"]')).toBeNull();
  });

  it('says why a write was refused and keeps what it had', async () => {
    const { view } = await surface(call => {
      if (call.method === 'DELETE') throw new Error('the vault is locked');
      return logins();
    });

    await remove(view);

    expect(view.container.querySelector('[data-testid="logins-error"]')?.textContent).toBe('the vault is locked');
    expect(view.container.querySelector('[data-login="GITHUB_KIRINNEE"]')).not.toBeNull();
  });

  it('puts a replaced password and renames a handle through the daemon', async () => {
    const entry = logins().entries[0];
    const { calls, view } = await surface(call => (call.method === 'GET' ? logins() : entry));

    await click(must(github(view).querySelector('[aria-label="Replace password for GitHub (kirinnee)"]'), 'Replace'));
    await typeInto(view.container.querySelector('[data-login-replace-password]'), 'a-brand-new-password');
    await click(byText(github(view), 'button', 'Replace password'));
    await settle();
    await click(must(github(view).querySelector('[aria-label="Rename handle of GitHub (kirinnee)"]'), 'Rename'));
    await typeInto(view.container.querySelector('[data-login-rename-handle]'), 'gh');
    await click(byText(github(view), 'button', 'Rename'));
    await settle();

    expect(calls.map(call => `${call.method} ${call.path}`)).toEqual([
      'GET /v1/secrets/logins',
      'PUT /v1/secrets/logins/GITHUB_KIRINNEE',
      'GET /v1/secrets/logins',
      'POST /v1/secrets/logins/GITHUB_KIRINNEE/rename',
      'GET /v1/secrets/logins',
    ]);
  });

  it('shows nothing of the old machine once the connection changes', async () => {
    const fake = fakeClient(() => logins());
    const view = await mount(<LoginsSurface connection={CONNECTION} createClient={async () => fake.client} />);
    mounted.push(view);
    await settle();
    expect(view.container.querySelector('[data-login]')).not.toBeNull();

    await view.render(<LoginsSurface connection={OTHER} createClient={() => new Promise<never>(() => undefined)} />);

    expect(view.container.querySelector('[data-login]')).toBeNull();
    expect(view.container.querySelector('[aria-label="Loading accounts"]')).not.toBeNull();
  });
});
