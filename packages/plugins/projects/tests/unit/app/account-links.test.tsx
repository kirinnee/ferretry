import { describe, expect, it } from 'bun:test';
import { interact, mount, must, settleUntil } from '@ferretry/app/testing';
import { AccountLinksView, ProjectAccountLinks } from '../../../app/features/create-project/account-links.tsx';
import { refusal, scripted } from './support/client.ts';

const ACCOUNTS = 'GET /v1/git-accounts';
const account = (id: string, login: string) => ({ id, login, keys: {} });

describe('account links', () => {
  it('says "account removed" for a link whose account is gone, and names the ones that exist', async () => {
    const mounted = await mount(
      <AccountLinksView
        project={{ accounts: ['gha_1', 'gha_2'] }}
        existing={[{ id: 'gha_1', login: 'octocat' }]}
        error={null}
      />,
    );
    const rows = [...mounted.container.querySelectorAll('[data-project-account]')];
    expect(rows.map(row => row.getAttribute('data-project-account-removed'))).toEqual(['false', 'true']);
    expect(rows[0]?.textContent).toBe('@octocat');
    expect(rows[1]?.textContent).toContain('gha_2');
    expect(rows[1]?.textContent).toContain('account removed');
    await mounted.unmount();
  });

  it('says none when nothing is linked, and does not guess when the accounts could not be read', async () => {
    const none = await mount(<AccountLinksView project={{}} existing={null} error={null} />);
    expect(none.container.querySelector('[data-project-accounts="none"]')).not.toBeNull();
    await none.unmount();

    const unread = await mount(
      <AccountLinksView project={{ accounts: ['gha_1'] }} existing={null} error="daemon is offline" />,
    );
    expect(unread.container.querySelector('[data-project-account-removed]')).toBeNull();
    expect(unread.container.textContent).toContain('cannot be checked: daemon is offline');
    await unread.unmount();
  });

  it('reads the accounts from the daemon and marks a deleted one', async () => {
    const client = scripted({ [ACCOUNTS]: [account('gha_1', 'octocat')] });
    const mounted = await mount(<ProjectAccountLinks client={client} project={{ accounts: ['gha_9', 'gha_1'] }} />);
    await settleUntil(
      () => mounted.container.querySelector('[data-project-accounts="ready"]') !== null,
      'the links',
      interact,
    );
    expect(
      must(mounted.container.querySelector('[data-project-account="gha_9"]'), 'the deleted link').getAttribute(
        'data-project-account-removed',
      ),
    ).toBe('true');
    await mounted.unmount();

    const failing = scripted({ [ACCOUNTS]: refusal(503, 'git accounts are off') });
    const broken = await mount(<ProjectAccountLinks client={failing} project={{ accounts: ['gha_1'] }} />);
    await settleUntil(
      () => (broken.container.textContent ?? '').includes('git accounts are off'),
      'the failure',
      interact,
    );
    expect(broken.container.querySelector('[data-project-account-removed]')).toBeNull();
    await broken.unmount();
  });
});
