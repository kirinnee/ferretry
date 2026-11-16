import { beforeEach, describe, expect, it } from 'bun:test';
import { DaemonCallError } from '@ferretry/app';
import type { SkillEntry } from '../../../../app/lib/machine-skills.ts';
import { DEFAULT_SHARING_TAB, SharingPage } from '../../../../app/features/sharing/sharing-page.tsx';
import type { MachineSkillEntriesLoader } from '../../../../app/lib/machine-skills.ts';
import { daemonConnection } from '../../../../app/lib/machine.ts';
import { SHARING_TABS, type SharingTab } from '../../../../app/lib/routes.ts';
import { fakeClient } from '../support/catalog-client.ts';
import { memberView, shareView } from '../support/catalog-sharing.ts';
import { ownedCatalog } from '../support/catalog-views.ts';
import { click, settle } from '../support/dom-form.ts';
import { mount } from '@ferretry/app/testing';
import { fakeMembers } from '../support/shared-screens.ts';

/** Earlier files in the same run can leave screens behind, and the queries here read the whole document. */
beforeEach(() => {
  document.body.replaceChildren();
});

const connection = daemonConnection({ daemonId: 'alpha' });
const q = (selector: string): HTMLElement | null => document.querySelector<HTMLElement>(selector);
const text = (): string => document.body.textContent ?? '';

const machineSkill: SkillEntry = {
  name: 'lint-fix',
  description: 'Fix the lint the way the team does.',
  harness: 'claude',
  scope: 'user',
  path: '/fy/home/.claude/skills/lint-fix/SKILL.md',
  runtimes: ['claude-work'],
};
const loadMachineSkills: MachineSkillEntriesLoader = async () => [machineSkill];

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
      loadMachineSkills={loadMachineSkills}
    />,
  );
  await settle();
  return { fake, view, navigated };
}

describe('SharingPage', () => {
  it('opens on Subscriptions when the address names no tab', async () => {
    expect(DEFAULT_SHARING_TAB).toBe('shared');
    const { view } = await open(undefined);
    expect(q('[data-sharing]')?.getAttribute('data-sharing')).toBe('shared');
    expect(q('[data-catalogs-list]')).toBeNull();
    await view.unmount();
  });

  it('shows the catalogs this machine publishes on My catalogs', async () => {
    const { view } = await open('catalogs');
    expect(q('[data-sharing]')?.getAttribute('data-sharing')).toBe('catalogs');
    expect(q('[data-catalogs-list]')?.textContent).toContain('Team skills');
    expect(q('[data-catalogs-people]')).toBeNull();
    await view.unmount();
  });

  it('has one heading and three tabs in the order of the address list, marking the open one', async () => {
    const { view } = await open('shared');
    expect(document.querySelectorAll('h1')).toHaveLength(1);
    expect(q('h1')?.textContent).toBe('Sharing');
    const tabs = [...document.querySelectorAll<HTMLElement>('[data-sharing-tab]')];
    expect(tabs.map(tab => tab.getAttribute('data-sharing-tab'))).toEqual([...SHARING_TABS]);
    expect(tabs.map(tab => tab.textContent)).toEqual(['Subscriptions', 'My catalogs', 'People']);
    expect(tabs.map(tab => tab.getAttribute('aria-current'))).toEqual(['page', null, null]);
    await view.unmount();
  });

  it('puts the tab in the address when one is tapped', async () => {
    const { view, navigated } = await open('catalogs');
    for (const id of SHARING_TABS) await click(q(`[data-sharing-tab="${id}"]`));
    expect(navigated).toEqual(SHARING_TABS.map(id => `/d/alpha/sharing/${id}`));
    await view.unmount();
  });

  it('shows Subscriptions as a tab of this page, with no page of its own and no way home', async () => {
    const { view } = await open('shared');
    expect(q('[data-sharing]')?.getAttribute('data-sharing')).toBe('shared');
    expect(text()).toContain('Subscriptions');
    expect(document.querySelectorAll('h1')).toHaveLength(1);
    expect(q('[data-shared-home]')).toBeNull();
    await view.unmount();
  });

  it('puts the subscribe field and Install from a file at the top of Subscriptions only', async () => {
    const { view } = await open('shared');
    const entry = q('[data-sharing-body] [data-catalog-add-entry]');
    expect(entry).not.toBeNull();
    expect(entry?.querySelector('[data-catalog-link-input]')).not.toBeNull();
    expect(entry?.nextElementSibling?.getAttribute('data-shared-page')).toBe('');
    expect(entry?.querySelector('[data-catalog-more]')).not.toBeNull();
    await view.unmount();
    for (const tab of ['people', 'catalogs'] as const) {
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
        throw new DaemonCallError(403, 'grant_device_not_granted', 'no');
      },
    });
    expect(q('[data-sharing-off]')).not.toBeNull();
    await view.unmount();
  });

  it('shows another failure on People and reads again on Try again', async () => {
    let broken = true;
    const { view } = await open('people', {
      'GET /v1/catalogs': () => {
        if (broken) throw new DaemonCallError(500, 'x', 'boom');
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

  it('publishes from My catalogs: + Publish skills lists this machine’s skills from the loader it was given', async () => {
    const { view } = await open('catalogs', {
      'GET /v1/catalogs?sourceState=1': () => ({ catalogs: [ownedCatalog()] }),
    });
    await click(q('[data-catalog-open="Team skills"]'));
    await settle();
    await click(q('[data-catalog-publish-skills]'));
    await settle();
    expect(q('[data-catalog-sheet="publish-skills"]')).not.toBeNull();
    expect(q('[data-publish-skill="lint-fix"]')?.textContent).toContain('account claude-work');
    await view.unmount();
  });
});
