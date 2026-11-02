import { beforeEach, describe, expect, it } from 'bun:test';
import { FyHttpError } from '@ferretry/protocol/client';
import { DEFAULT_SHARING_TAB, SharingPage, SKILLS_USE_NOTE } from '../../../../src/features/sharing/sharing-page.tsx';
import type { SkillsCatalogLoader } from '../../../../src/features/skills/skills-api.ts';
import { daemonConnection } from '../../../../src/lib/daemon-connection.ts';
import { SHARING_TABS, type SharingTab } from '../../../../src/lib/pages/routes.ts';
import { fakeClient } from '../../../support/catalog-client.ts';
import { memberView, shareView } from '../../../support/catalog-sharing.ts';
import { ownedCatalog } from '../../../support/catalog-views.ts';
import { click, settle } from '../../../support/dom-form.ts';
import { mount } from '../../../support/dom.ts';
import { fakeMembers } from '../../../support/shared-screens.ts';

/** Earlier files in the same run can leave screens behind, and the queries here read the whole document. */
beforeEach(() => {
  document.body.replaceChildren();
});

const connection = daemonConnection({ daemonId: 'alpha', baseUrl: 'https://alpha.example.test', deviceId: 'token-a' });
const q = (selector: string): HTMLElement | null => document.querySelector<HTMLElement>(selector);
const text = (): string => document.body.textContent ?? '';

const loadSkills: SkillsCatalogLoader = async () => ({
  harness: 'claude',
  skills: [{ name: 'pdf-tools', description: 'Split PDFs.', scope: 'global', origin: 'claude' }],
});

async function open(tab: SharingTab | undefined, handlers: Parameters<typeof fakeClient>[0] = {}) {
  const fake = fakeClient({
    'GET /v1/catalogs': () => ({ catalogs: [ownedCatalog()] }),
    'GET /v1/catalog-members': () => ({ members: [memberView()] }),
    'GET /v1/catalog-shares': () => ({ shares: [shareView()] }),
    ...handlers,
  });
  const members = fakeMembers({ list: async () => [] });
  const navigated: string[] = [];
  const view = await mount(
    <SharingPage
      connection={connection}
      tab={tab}
      onNavigate={to => navigated.push(to)}
      members={members.members}
      machines={[]}
      createClient={fake.factory}
      loadSkills={loadSkills}
    />,
  );
  await settle();
  return { fake, view, navigated };
}

describe('SharingPage', () => {
  it('opens on My catalogs when the address names no tab', async () => {
    expect(DEFAULT_SHARING_TAB).toBe('catalogs');
    const { view } = await open(undefined);
    expect(q('[data-sharing]')?.getAttribute('data-sharing')).toBe('catalogs');
    expect(q('[data-catalogs-list]')?.textContent).toContain('Team skills');
    expect(q('[data-catalogs-people]')).toBeNull();
    await view.unmount();
  });

  it('has one heading and four tabs in the order of the address list, marking the open one', async () => {
    const { view } = await open('shared');
    expect(document.querySelectorAll('h1')).toHaveLength(1);
    expect(q('h1')?.textContent).toBe('Sharing');
    const tabs = [...document.querySelectorAll<HTMLElement>('[data-sharing-tab]')];
    expect(tabs.map(tab => tab.getAttribute('data-sharing-tab'))).toEqual([...SHARING_TABS]);
    expect(tabs.map(tab => tab.textContent)).toEqual(['My catalogs', 'Shared with me', 'People', 'Skills']);
    expect(tabs.map(tab => tab.getAttribute('aria-current'))).toEqual([null, 'page', null, null]);
    await view.unmount();
  });

  it('puts the tab in the address when one is tapped', async () => {
    const { view, navigated } = await open('catalogs');
    for (const id of SHARING_TABS) await click(q(`[data-sharing-tab="${id}"]`));
    expect(navigated).toEqual(SHARING_TABS.map(id => `/d/alpha/sharing/${id}`));
    await view.unmount();
  });

  it('shows Shared with me as a tab of this page, with no page of its own and no way home', async () => {
    const { view } = await open('shared');
    expect(q('[data-sharing]')?.getAttribute('data-sharing')).toBe('shared');
    expect(text()).toContain('Shared with me');
    expect(document.querySelectorAll('h1')).toHaveLength(1);
    expect(q('[data-shared-home]')).toBeNull();
    await view.unmount();
  });

  it('puts the paste field and Install from a file at the top of Shared with me only', async () => {
    const { view } = await open('shared');
    const entry = q('[data-sharing-body] [data-catalog-add-entry]');
    expect(entry).not.toBeNull();
    expect(entry?.querySelector('[data-catalog-link-input]')).not.toBeNull();
    expect(entry?.nextElementSibling?.getAttribute('data-shared-page')).toBe('');
    expect(entry?.querySelector('[data-catalog-more]')).not.toBeNull();
    await view.unmount();
    for (const tab of ['people', 'skills'] as const) {
      const other = await open(tab);
      expect(q('[data-catalog-add-entry]')).toBeNull();
      await other.view.unmount();
    }
  });

  it('lists the people with what each one reads', async () => {
    const { view, fake } = await open('people');
    expect(q(`[data-members-person="${memberView().label}"]`)).not.toBeNull();
    expect(q('[data-members-back]')).toBeNull();
    expect(fake.calls.map(call => call.path)).toContain('/v1/catalogs');
    await view.unmount();
  });

  it('says Sharing is off on the People tab', async () => {
    const { view } = await open('people', {
      'GET /v1/catalogs': () => {
        throw new FyHttpError('no', 403, 'grant_device_not_granted');
      },
    });
    expect(q('[data-sharing-off]')).not.toBeNull();
    await view.unmount();
  });

  it('shows another failure on People and reads again on Try again', async () => {
    let broken = true;
    const { view } = await open('people', {
      'GET /v1/catalogs': () => {
        if (broken) throw new FyHttpError('boom', 500, 'x');
        return { catalogs: [ownedCatalog()] };
      },
    });
    expect(q('[data-catalog-failure]')).not.toBeNull();
    broken = false;
    await click(q('[data-catalog-preview-again]'));
    await settle();
    expect(q('[data-catalog-failure]')).toBeNull();
    expect(q(`[data-members-person="${memberView().label}"]`)).not.toBeNull();
    await view.unmount();
  });

  it('says it is reading people while the catalogs have not come', async () => {
    let release: (value: unknown) => void = () => undefined;
    const gate = new Promise(resolve => {
      release = resolve;
    });
    const fake = fakeClient({
      'GET /v1/catalogs': async () => await gate,
      'GET /v1/catalog-members': () => ({ members: [] }),
      'GET /v1/catalog-shares': () => ({ shares: [] }),
    });
    const view = await mount(
      <SharingPage
        connection={connection}
        tab="people"
        onNavigate={() => undefined}
        members={fakeMembers({}).members}
        machines={[]}
        createClient={fake.factory}
      />,
    );
    expect(text()).toContain('Reading people');
    release({ catalogs: [] });
    await settle();
    await view.unmount();
  });

  it('lists this machine’s skills, and a Use in chat tap says where skills are used', async () => {
    const { view } = await open('skills');
    expect(q('[data-sharing]')?.getAttribute('data-sharing')).toBe('skills');
    expect(text()).toContain('pdf-tools');
    await click(document.querySelector<HTMLElement>('button[aria-label="Use /pdf-tools in chat"]'));
    await settle();
    expect(text()).toContain(SKILLS_USE_NOTE);
    await view.unmount();
  });

  it('draws the Skills tab rows with one ⋯ that publishes, from the same catalogs read', async () => {
    const { view, fake } = await open('skills', { 'GET /v1/catalog-installs': () => ({ installs: [] }) });
    const row = q('[data-catalog-item-row="pdf-tools"]');
    expect(row?.querySelector('[data-row-share]')).toBeNull();
    expect(row?.querySelector('[data-row-add]')).toBeNull();
    await click(row?.querySelector<HTMLElement>('[data-row-more]') ?? null);
    await settle();
    expect([...document.querySelectorAll('[role="menuitem"]')].map(node => node.textContent)).toContain(
      'Publish in another catalog…',
    );
    expect(fake.calls.some(call => call.path === '/v1/catalogs')).toBe(true);
    await view.unmount();
  });

  it('reads the machine’s own skills when no loader is injected', async () => {
    const view = await mount(
      <SharingPage
        connection={connection}
        tab="skills"
        onNavigate={() => undefined}
        members={fakeMembers({}).members}
        machines={[]}
      />,
    );
    await settle();
    expect(q('[data-sharing]')?.getAttribute('data-sharing')).toBe('skills');
    await view.unmount();
  });
});
