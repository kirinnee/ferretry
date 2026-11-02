import { beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import type { CatalogInstall } from '@ferretry/protocol';
import {
  ADD_SKILLS_TITLE,
  CLAUDE_LIVE,
  CLAUDE_RELOAD,
  NO_SKILLS_FOUND,
  NO_SUBSCRIPTIONS,
  PICK_A_PLACE,
} from '../../../../src/features/context-rail/add-skills-model.ts';
import { AddSkillsPage, type AddSkillsPageProps } from '../../../../src/features/context-rail/add-skills-page.tsx';
import { ONLINE_ONLY } from '../../../../src/features/shared/shared-model.ts';
import { daemonConnection } from '../../../../src/lib/daemon-connection.ts';
import type { MemberSubscription } from '../../../../src/lib/member-keys.ts';
import { type AppStore, StoreProvider } from '../../../../src/lib/store.tsx';
import { fakeClient } from '../../../support/catalog-client.ts';
import { crypto } from '../../../support/catalog-files.ts';
import { installRecord } from '../../../support/catalog-views.ts';
import { interact, mount } from '../../../support/dom.ts';
import { click, settle, typeInto } from '../../../support/dom-form.ts';
import { testSubscription } from '../../../support/member-keys.ts';
import {
  deferred,
  failedAttempt,
  fakeMembers,
  type Members,
  okAttempt,
  otherCatalogView,
  refusedAttempt,
  type SharedItemFixture,
  sharedItemFixture,
} from '../../../support/shared-screens.ts';
import { SKILLS, skill } from './context-rail-fixtures.ts';

type AddSkillsHost = Omit<AddSkillsPageProps, 'onNavigate' | 'loadInventory'>;

beforeEach(() => {
  document.body.replaceChildren();
});

const q = (selector: string): HTMLElement | null => document.querySelector<HTMLElement>(selector);
const all = (selector: string): HTMLElement[] => [...document.querySelectorAll<HTMLElement>(selector)];
const text = (): string => document.body.textContent ?? '';

const connection = daemonConnection({ daemonId: 'alpha', baseUrl: 'https://alpha.example.test', deviceId: 'token-a' });
const PROJECTS = [{ name: 'app', path: '/work/app' }];

let shared: SharedItemFixture;
let studio: MemberSubscription;
let lockedSub: MemberSubscription;
let downSub: MemberSubscription;
beforeAll(async () => {
  shared = await sharedItemFixture();
  studio = await testSubscription(shared.identity.daemonId, { ownLabel: 'Studio' });
  lockedSub = await testSubscription('fy_daemon_locked', { ownLabel: 'Locked guild' });
  downSub = await testSubscription('fy_daemon_down', { ownLabel: 'Sleeping lab' });
});

const entry = () => {
  const found = shared.entries.find(candidate => candidate.itemId === shared.skill.itemId);
  if (found === undefined) throw new Error('no skill entry');
  return found;
};

const chipOf = (catalogId: string): string => `[data-context-chip="${studio.daemonId}/${catalogId}"]`;

/** The record the machine holds once the skill is installed from Studio. */
const studioInstall = (target: CatalogInstall['target'], installId = `cin_${'a'.repeat(22)}`): CatalogInstall => {
  const base = installRecord('skill', 'pdf-tools');
  return {
    ...base,
    installId: installId as CatalogInstall['installId'],
    provenance: { ...base.provenance, publisher: shared.identity.daemonId, itemId: shared.skill.itemId },
    target,
  };
};

const PROJECT_TARGET = { scope: 'project', projectRoot: '/work/app', harness: 'claude' } as const;

const hostWith = (
  members: Members,
  routes: Parameters<typeof fakeClient>[0],
  extra: Partial<AddSkillsHost> = {},
): { host: AddSkillsHost; calls: ReturnType<typeof fakeClient>['calls'] } => {
  const fake = fakeClient({
    'GET /v1/fleet/runtimes': () => ({ runtimes: [{ id: 'rt-work', wrapper: 'claude-work', profile: 'default' }] }),
    'GET /v1/secrets': () => ({ v: 1, health: 'ready', secrets: [], references: [] }),
    'GET /v1/skills': () => ({ homes: [], projects: [], truncated: false }),
    'GET /v1/skill-installs/local': () => ({ installs: [] }),
    ...routes,
  });
  return {
    calls: fake.calls,
    host: {
      connection,
      machineName: 'alpha box',
      sessionId: 'sess-1',
      cwd: '/work/app/src',
      install: { createClient: fake.factory, crypto, projects: PROJECTS },
      members,
      ...extra,
    },
  };
};

const open = async (host: AddSkillsHost, inventory = SKILLS) => {
  const events: string[] = [];
  const view = await mount(
    <AddSkillsPage {...host} loadInventory={async () => inventory} onNavigate={to => events.push(to)} />,
  );
  await settle();
  await settle();
  return { view, events };
};

const browseOk = async () => okAttempt(shared.browse);
const rows = () => all('[data-add-skills-row]');

describe('the subscriptions list', () => {
  it('lists each skill under its catalog and publisher, with its version, Installed or Install', async () => {
    const { members } = fakeMembers({
      list: async () => [studio, lockedSub],
      browse: async sub =>
        sub.daemonId === studio.daemonId ? await browseOk() : failedAttempt('locked', 'Unlock first.'),
    });
    const { host } = hostWith(members, { 'GET /v1/catalog-installs': () => ({ installs: [] }) });
    const { view } = await open(host);
    expect(q('[data-add-skills-page] h1')?.textContent).toBe(ADD_SKILLS_TITLE);
    expect(rows()).toHaveLength(1);
    expect(q('[data-add-skills-catalog] h2')?.textContent).toBe("Kirin's catalog");
    expect(q('[data-add-skills-catalog]')?.textContent).toContain('from Studio · 1 skill');
    expect(rows()[0]?.textContent).toContain('v1');
    expect(q('[data-add-skills-install]')?.textContent).toContain('Install');
    expect(q('[data-add-skills-scope]')?.textContent).toContain(
      'Installs into this project (every session in this folder).',
    );
    await view.unmount();
  });

  it('shows Installed, not Install, for a skill this machine already holds', async () => {
    const { members } = fakeMembers({ list: async () => [studio], browse: browseOk });
    const { host } = hostWith(members, {
      'GET /v1/catalog-installs': () => ({ installs: [studioInstall(PROJECT_TARGET)] }),
    });
    const { view } = await open(host);
    expect(q('[data-add-skills-installed]')?.textContent).toBe('Installed');
    expect(q('[data-add-skills-install]')).toBeNull();
    await view.unmount();
  });

  it('shows Install when the install records cannot be read', async () => {
    const { members } = fakeMembers({ list: async () => [studio], browse: browseOk });
    const { host } = hostWith(members, {});
    const { view } = await open(host);
    expect(q('[data-add-skills-install]')).not.toBeNull();
    await view.unmount();
  });

  it('says it is reading until the subscriptions arrive, and says when there are none', async () => {
    const wait = deferred<MemberSubscription[]>();
    const { members } = fakeMembers({ list: async () => await wait.promise });
    const { host } = hostWith(members, { 'GET /v1/catalog-installs': () => ({ installs: [] }) });
    const { view } = await open(host);
    expect(text()).toContain('Reading your subscriptions…');
    wait.resolve([]);
    await settle();
    expect(q('[data-add-skills-empty]')?.textContent).toBe(NO_SUBSCRIPTIONS);
    await view.unmount();
  });

  it('says one line for a locked publisher, and unlocks then lists its skills', async () => {
    let unlocked = false;
    const { members, calls } = fakeMembers({
      list: async () => [studio],
      browse: async () => (unlocked ? okAttempt(shared.browse) : failedAttempt('locked', 'Unlock first.')),
      unlock: async () => {
        unlocked = true;
        return okAttempt(undefined as never);
      },
    });
    const { host } = hostWith(members, { 'GET /v1/catalog-installs': () => ({ installs: [] }) });
    const { view } = await open(host);
    expect(q('[data-add-skills-publisher] h2')?.textContent).toBe('Studio');
    expect(q('[data-add-skills-publisher] [data-add-skills-locked]')?.textContent).toContain('Locked. Unlock it');
    expect(rows()).toHaveLength(0);
    await click(q('[data-add-skills-unlock]'));
    await settle();
    await settle();
    expect(calls).toContain('unlock');
    expect(rows()).toHaveLength(1);
    expect(q('[data-add-skills-locked]')).toBeNull();
    await view.unmount();
  });

  it('shows Working… while an unlock is in flight, and says so when it is refused or fails', async () => {
    const hold = deferred<ReturnType<typeof refusedAttempt>>();
    let outcome: 'refused' | 'failed' = 'refused';
    const { members } = fakeMembers({
      list: async () => [studio],
      browse: async () => failedAttempt('locked', 'Unlock first.'),
      unlock: async () =>
        outcome === 'refused' ? ((await hold.promise) as never) : failedAttempt('other', 'No passkey here.'),
    });
    const { host } = hostWith(members, { 'GET /v1/catalog-installs': () => ({ installs: [] }) });
    const { view } = await open(host);
    await click(q('[data-add-skills-unlock]'));
    expect(q('[data-add-skills-unlock]')?.textContent).toBe('Working…');
    hold.resolve(refusedAttempt());
    await settle();
    expect(q('[data-add-skills-refused]')?.textContent).toContain('Refused this browser');
    await view.unmount();

    outcome = 'failed';
    const again = await open(host);
    await click(q('[data-add-skills-unlock]'));
    await settle();
    expect(q('[data-add-skills-failed]')?.textContent).toContain('No passkey here.');
    await again.view.unmount();
  });

  it('says a publisher is offline, can try again, and says a refused or failed one in one line', async () => {
    let up = false;
    const { members } = fakeMembers({
      list: async () => [studio, downSub, lockedSub],
      browse: async sub => {
        if (sub.daemonId === studio.daemonId) return up ? await browseOk() : failedAttempt('unreachable', 'Down.');
        if (sub.daemonId === downSub.daemonId) return refusedAttempt();
        return failedAttempt('other', 'Odd answer.');
      },
    });
    const { host } = hostWith(members, { 'GET /v1/catalog-installs': () => ({ installs: [] }) });
    const { view } = await open(host);
    expect(q('[data-add-skills-offline]')?.textContent).toContain(ONLINE_ONLY);
    expect(q('[data-add-skills-refused]')?.textContent).toContain('Refused this browser');
    expect(q('[data-add-skills-failed]')?.textContent).toContain('Odd answer.');
    up = true;
    await click(q('[data-add-skills-again]'));
    await settle();
    expect(rows()).toHaveLength(1);
    await view.unmount();
  });

  it('shows a subscription the browser already knows is refused without asking it', async () => {
    const refused = { ...downSub, status: 'refused' } as unknown as MemberSubscription;
    const { members, calls } = fakeMembers({ list: async () => [refused] });
    const { host } = hostWith(members, { 'GET /v1/catalog-installs': () => ({ installs: [] }) });
    const { view } = await open(host);
    expect(q('[data-add-skills-refused]')).not.toBeNull();
    expect(calls).not.toContain('browse');
    await view.unmount();
  });

  it('narrows by what is typed and says when nothing matches', async () => {
    const { members } = fakeMembers({ list: async () => [studio], browse: browseOk });
    const { host } = hostWith(members, { 'GET /v1/catalog-installs': () => ({ installs: [] }) });
    const { view } = await open(host);
    await typeInto(q('[data-add-skills-search]'), 'nothing like it');
    expect(rows()).toHaveLength(0);
    expect(q('[data-add-skills-none]')?.textContent).toBe(NO_SKILLS_FOUND);
    await typeInto(q('[data-add-skills-search]'), 'pdf');
    expect(rows()).toHaveLength(1);
    expect(q('[data-add-skills-none]')).toBeNull();
    await view.unmount();
  });

  it('does not say nothing matches while a publisher is still loading', async () => {
    const wait = deferred<ReturnType<typeof okAttempt<typeof shared.browse>>>();
    const { members } = fakeMembers({
      list: async () => [studio, lockedSub],
      browse: async sub => (sub.daemonId === studio.daemonId ? await browseOk() : await wait.promise),
    });
    const { host } = hostWith(members, { 'GET /v1/catalog-installs': () => ({ installs: [] }) });
    const { view } = await open(host);
    await typeInto(q('[data-add-skills-search]'), 'zzz');
    expect(q('[data-add-skills-none]')).toBeNull();
    expect(q(`[data-add-skills-publisher="${lockedSub.daemonId}"]`)?.textContent).toContain(
      'Locked guildReading your subscriptions…',
    );
    wait.resolve(okAttempt({ ...shared.browse, catalogs: [] }));
    await settle();
    await view.unmount();
  });

  it('leads to Sharing › Subscriptions', async () => {
    const { members } = fakeMembers({ list: async () => [] });
    const { host } = hostWith(members, { 'GET /v1/catalog-installs': () => ({ installs: [] }) });
    const { view, events } = await open(host);
    await click(q('[data-add-skills-subscribe]'));
    expect(events).toEqual(['/d/alpha/sharing/shared']);
    await view.unmount();
  });

  it('goes back to the session it was opened from', async () => {
    const { members } = fakeMembers({ list: async () => [studio], browse: browseOk });
    const { host } = hostWith(members, { 'GET /v1/catalog-installs': () => ({ installs: [] }) });
    const { view, events } = await open(host);
    await click(q('[data-add-skills-back]'));
    expect(events).toEqual(['/d/alpha/session/sess-1']);
    await view.unmount();
  });
});

describe('the session’s skills', () => {
  it('reads them from the machine when the host gives no reader', async () => {
    const { members } = fakeMembers({ list: async () => [studio], browse: browseOk });
    const { host } = hostWith(members, {
      'GET /v1/catalog-installs': () => ({ installs: [] }),
      'GET /v1/sessions/sess-1/skills/inventory': () => SKILLS,
    });
    const view = await mount(<AddSkillsPage {...host} onNavigate={() => undefined} />);
    await settle();
    await settle();
    expect(q('[data-add-skills-install]')).not.toBeNull();
    expect(q('[data-add-skills-scope]')?.textContent).not.toContain('could not be read');
    await view.unmount();
  });

  it('says nothing can be installed yet when they cannot be read', async () => {
    const { members } = fakeMembers({ list: async () => [studio], browse: browseOk });
    const { host } = hostWith(members, { 'GET /v1/catalog-installs': () => ({ installs: [] }) });
    const view = await mount(
      <AddSkillsPage
        {...host}
        loadInventory={async () => {
          throw new Error('offline');
        }}
        onNavigate={() => undefined}
      />,
    );
    await settle();
    await settle();
    expect(q('[data-add-skills-scope]')?.textContent).toContain('could not be read');
    expect(q('[data-add-skills-install]')?.hasAttribute('disabled')).toBe(true);
    await view.unmount();
  });
});

describe('which catalog a skill is from', () => {
  const twoCatalogs = () => okAttempt({ ...shared.browse, catalogs: [shared.view, otherCatalogView(shared)] });
  const chips = () => all('[data-context-chip]').map(chip => chip.textContent);

  it('groups the skills under each catalog, and filters to one with a chip', async () => {
    const { members } = fakeMembers({ list: async () => [studio], browse: async () => twoCatalogs() });
    const { host } = hostWith(members, { 'GET /v1/catalog-installs': () => ({ installs: [] }) });
    const { view } = await open(host);
    expect(all('[data-add-skills-catalog] h2').map(heading => heading.textContent)).toEqual([
      "Kirin's catalog",
      'Design catalog',
    ]);
    expect(rows()).toHaveLength(2);
    expect(chips()).toEqual(['All catalogs2', "Kirin's catalog1", 'Design catalog1']);

    await click(q(chipOf(shared.view.catalogId)));
    expect(all('[data-add-skills-catalog] h2').map(heading => heading.textContent)).toEqual(["Kirin's catalog"]);
    expect(rows()).toHaveLength(1);
    expect(q('[data-context-chip="all"]')?.getAttribute('aria-pressed')).toBe('false');

    await click(q('[data-context-chip="all"]'));
    expect(rows()).toHaveLength(2);
    await view.unmount();
  });

  it('counts each chip by what the search kept, and names a catalog that is nowhere else with its publisher', async () => {
    const { members } = fakeMembers({ list: async () => [studio], browse: async () => twoCatalogs() });
    const { host } = hostWith(members, { 'GET /v1/catalog-installs': () => ({ installs: [] }) });
    const { view } = await open(host);
    await typeInto(q('[data-add-skills-search]'), 'ocr-tools');
    expect(chips()).toEqual(['All catalogs1', "Kirin's catalog0", 'Design catalog1']);
    await typeInto(q('[data-add-skills-search]'), 'pdf-tools');
    expect(chips()).toEqual(['All catalogs1', "Kirin's catalog1", 'Design catalog0']);
    await view.unmount();
  });

  it('draws no catalog filter when only one catalog lists skills', async () => {
    const { members } = fakeMembers({ list: async () => [studio], browse: browseOk });
    const { host } = hostWith(members, { 'GET /v1/catalog-installs': () => ({ installs: [] }) });
    const { view } = await open(host);
    expect(q('[data-context-chips]')).toBeNull();
    await view.unmount();
  });
});

describe('Refresh', () => {
  it('reads every subscription again and shows a skill the publisher added since', async () => {
    let browsed = 0;
    const { members } = fakeMembers({
      list: async () => [studio],
      browse: async () => {
        browsed += 1;
        return browsed === 1
          ? await browseOk()
          : okAttempt({ ...shared.browse, catalogs: [shared.view, otherCatalogView(shared)] });
      },
    });
    const { host } = hostWith(members, { 'GET /v1/catalog-installs': () => ({ installs: [] }) });
    const { view } = await open(host);
    expect(rows()).toHaveLength(1);
    expect(q('[data-add-skills-refresh]')?.textContent).toBe('Refresh');
    await click(q('[data-add-skills-refresh]'));
    await settle();
    await settle();
    expect(browsed).toBe(2);
    expect(rows()).toHaveLength(2);
    expect(text()).toContain('ocr-tools');
    expect(q('[data-add-skills-updated]')?.textContent).toBe('Updated just now');
    expect(q('[data-add-skills-refresh]')?.textContent).toBe('Refresh');
    await view.unmount();
  });

  it('keeps the skills on screen and says Refreshing… while it reads', async () => {
    const hold = deferred<ReturnType<typeof okAttempt<typeof shared.browse>>>();
    let browsed = 0;
    const { members } = fakeMembers({
      list: async () => [studio],
      browse: async () => {
        browsed += 1;
        return browsed === 1 ? await browseOk() : await hold.promise;
      },
    });
    const { host } = hostWith(members, { 'GET /v1/catalog-installs': () => ({ installs: [] }) });
    const { view } = await open(host);
    await click(q('[data-add-skills-refresh]'));
    expect(q('[data-add-skills-refresh]')?.textContent).toBe('Refreshing…');
    expect((q('[data-add-skills-refresh]') as HTMLButtonElement).disabled).toBe(true);
    expect(rows()).toHaveLength(1);
    expect(text()).not.toContain('Reading your subscriptions…');
    hold.resolve(await browseOk());
    await settle();
    expect(q('[data-add-skills-refresh]')?.textContent).toBe('Refresh');
    await view.unmount();
  });

  it('shows a skill installed since as Installed', async () => {
    const { members } = fakeMembers({ list: async () => [studio], browse: browseOk });
    let installed = false;
    const { host } = hostWith(members, {
      'GET /v1/catalog-installs': () => ({ installs: installed ? [studioInstall(PROJECT_TARGET)] : [] }),
    });
    const { view } = await open(host);
    expect(q('[data-add-skills-install]')).not.toBeNull();
    installed = true;
    await click(q('[data-add-skills-refresh]'));
    await settle();
    expect(q('[data-add-skills-installed]')).not.toBeNull();
    await view.unmount();
  });

  it('falls back to All when a refresh drops the catalog the filter was on', async () => {
    let both = true;
    const { members } = fakeMembers({
      list: async () => [studio],
      browse: async () =>
        okAttempt({ ...shared.browse, catalogs: both ? [shared.view, otherCatalogView(shared)] : [shared.view] }),
    });
    const { host } = hostWith(members, { 'GET /v1/catalog-installs': () => ({ installs: [] }) });
    const { view } = await open(host);
    await click(q(chipOf(otherCatalogView(shared).catalogId)));
    expect(rows()).toHaveLength(1);
    both = false;
    await click(q('[data-add-skills-refresh]'));
    await settle();
    expect(rows()).toHaveLength(1);
    expect(text()).toContain('pdf-tools');
    await view.unmount();
  });
});

const touch = (type: string, y: number): Event => {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'touches', { value: [{ clientY: y }] });
  return event;
};

const comeBack = async (state: 'visible' | 'hidden'): Promise<void> => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  await interact(() => document.dispatchEvent(new Event('visibilitychange')));
  await settle();
  await settle();
};

describe('a skill the publisher adds while the page is open', () => {
  const growing = () => {
    let added = false;
    const { members } = fakeMembers({
      list: async () => [studio],
      browse: async () =>
        okAttempt({ ...shared.browse, catalogs: added ? [shared.view, otherCatalogView(shared)] : [shared.view] }),
    });
    return { members, add: () => (added = true) };
  };

  it('is read again when the person comes back to the tab, with no button pressed', async () => {
    const { members, add } = growing();
    const { host } = hostWith(members, { 'GET /v1/catalog-installs': () => ({ installs: [] }) });
    const { view } = await open(host);
    expect(rows()).toHaveLength(1);
    add();
    await comeBack('hidden');
    expect(rows()).toHaveLength(1);
    await comeBack('visible');
    expect(rows()).toHaveLength(2);
    expect(text()).toContain('ocr-tools');
    await view.unmount();
  });

  it('is not read a second time on top of a read that is still under way', async () => {
    const hold = deferred<ReturnType<typeof okAttempt<typeof shared.browse>>>();
    let browsed = 0;
    const { members } = fakeMembers({
      list: async () => [studio],
      browse: async () => {
        browsed += 1;
        return browsed === 1 ? await browseOk() : await hold.promise;
      },
    });
    const { host } = hostWith(members, { 'GET /v1/catalog-installs': () => ({ installs: [] }) });
    const { view } = await open(host);
    await click(q('[data-add-skills-refresh]'));
    await comeBack('visible');
    expect(browsed).toBe(2);
    hold.resolve(await browseOk());
    await settle();
    await view.unmount();
  });

  it('is read again when the page opens, because nothing from an earlier visit is kept', async () => {
    const { members, add } = growing();
    const { host } = hostWith(members, { 'GET /v1/catalog-installs': () => ({ installs: [] }) });
    const first = await open(host);
    expect(rows()).toHaveLength(1);
    await first.view.unmount();
    add();
    const second = await open(host);
    expect(rows()).toHaveLength(2);
    await second.view.unmount();
  });
});

describe('the lock notice and the other notes sit in their own section', () => {
  it('names the publisher in a section of its own, in the order of the subscriptions, and hides it while a catalog is chosen', async () => {
    const { members } = fakeMembers({
      list: async () => [studio, lockedSub],
      browse: async sub =>
        sub.daemonId === studio.daemonId
          ? okAttempt({ ...shared.browse, catalogs: [shared.view, otherCatalogView(shared)] })
          : failedAttempt('locked', 'Unlock first.'),
    });
    const { host } = hostWith(members, { 'GET /v1/catalog-installs': () => ({ installs: [] }) });
    const { view } = await open(host);
    const sections = all('[data-add-skills-catalogs] > section').map(
      section => section.querySelector('h2')?.textContent,
    );
    expect(sections).toEqual(["Kirin's catalog", 'Design catalog', 'Locked guild']);
    const locked = q(`[data-add-skills-publisher="${lockedSub.daemonId}"]`);
    expect(locked?.querySelector('[data-add-skills-unlock]')).not.toBeNull();
    expect(text()).not.toContain('Locked guild is locked');
    await click(q(chipOf(shared.view.catalogId)));
    expect(q('[data-add-skills-publisher]')).toBeNull();
    await view.unmount();
  });
});

describe('Refresh says what it did', () => {
  const clockAt = (start: number) => {
    let at = start;
    return {
      set: (next: number) => (at = next),
      clock: { now: () => new Date(at), ticker: () => () => undefined },
    };
  };

  it('says Updated just now, then how long ago, beside the button', async () => {
    const { members } = fakeMembers({ list: async () => [studio], browse: browseOk });
    const { set, clock } = clockAt(Date.parse('2026-11-01T10:00:00Z'));
    const { host } = hostWith(members, { 'GET /v1/catalog-installs': () => ({ installs: [] }) }, { clock });
    const { view } = await open(host);
    expect(q('[data-add-skills-updated]')?.textContent).toBe('Updated just now');
    set(Date.parse('2026-11-01T10:04:00Z'));
    await click(q('[data-add-skills-refresh]'));
    await settle();
    expect(q('[data-add-skills-updated]')?.textContent).toBe('Updated just now');
    await view.unmount();
  });

  it('shows the age once time has passed since the last read', async () => {
    const { members } = fakeMembers({ list: async () => [studio], browse: browseOk });
    let tick: () => void = () => undefined;
    let at = Date.parse('2026-11-01T10:00:00Z');
    const clock = {
      now: () => new Date(at),
      ticker: (onTick: () => void) => {
        tick = onTick;
        return () => undefined;
      },
    };
    const { host } = hostWith(members, { 'GET /v1/catalog-installs': () => ({ installs: [] }) }, { clock });
    const { view } = await open(host);
    at += 5 * 60_000;
    await interact(() => tick());
    expect(q('[data-add-skills-updated]')?.textContent).toBe('Updated 5m ago');
    await view.unmount();
  });

  it('shows a spinner and no status text while it reads', async () => {
    const hold = deferred<ReturnType<typeof okAttempt<typeof shared.browse>>>();
    let browsed = 0;
    const { members } = fakeMembers({
      list: async () => [studio],
      browse: async () => (++browsed === 1 ? await browseOk() : await hold.promise),
    });
    const { host } = hostWith(members, { 'GET /v1/catalog-installs': () => ({ installs: [] }) });
    const { view } = await open(host);
    await click(q('[data-add-skills-refresh]'));
    expect(q('[data-add-skills-refresh] svg')?.getAttribute('class')).toContain('animate-spin');
    expect(q('[data-add-skills-updated]')?.textContent).toBe('');
    hold.resolve(await browseOk());
    await settle();
    expect(q('[data-add-skills-refresh] svg')?.getAttribute('class') ?? '').not.toContain('animate-spin');
    await view.unmount();
  });

  it('says in plain words which publisher did not answer, and keeps the skills it had', async () => {
    let up = true;
    const { members } = fakeMembers({
      list: async () => [studio, downSub, lockedSub],
      browse: async sub => {
        if (sub.daemonId === studio.daemonId) return up ? await browseOk() : failedAttempt('unreachable', 'Down.');
        if (sub.daemonId === downSub.daemonId)
          return up ? failedAttempt('locked', 'Locked.') : failedAttempt('other', 'Odd.');
        return up ? failedAttempt('locked', 'Locked.') : failedAttempt('unreachable', 'Down.');
      },
    });
    const { host } = hostWith(members, { 'GET /v1/catalog-installs': () => ({ installs: [] }) });
    const { view } = await open(host);
    expect(q('[data-add-skills-updated]')?.textContent).toBe('Updated just now');
    up = false;
    await click(q('[data-add-skills-refresh]'));
    await settle();
    expect(q('[data-add-skills-updated]')?.textContent).toBe(
      'Could not reach Studio, Sleeping lab and Locked guild, so the list may be out of date.',
    );
    expect(rows()).toHaveLength(1);
    await view.unmount();
  });
});

describe('pull to refresh', () => {
  const pull = async (scroller: HTMLElement, distance: number): Promise<void> => {
    await interact(() => scroller.dispatchEvent(touch('touchstart', 100)));
    await interact(() => scroller.dispatchEvent(touch('touchmove', 100 + distance)));
  };

  it('shows a hint while pulling and runs the same refresh when pulled far enough', async () => {
    let browsed = 0;
    const { members } = fakeMembers({
      list: async () => [studio],
      browse: async () => {
        browsed += 1;
        return await browseOk();
      },
    });
    const { host } = hostWith(members, { 'GET /v1/catalog-installs': () => ({ installs: [] }) });
    const { view } = await open(host);
    const body = q('[data-add-skills-body]') as HTMLElement;
    await pull(body, 20);
    expect(q('[data-add-skills-pull]')?.getAttribute('data-add-skills-pull')).toBe('pulling');
    expect(q('[data-add-skills-pull]')?.textContent).toBe('Pull down to refresh');
    await interact(() => body.dispatchEvent(touch('touchend', 0)));
    expect(browsed).toBe(1);
    await pull(body, 80);
    expect(q('[data-add-skills-pull]')?.getAttribute('data-add-skills-pull')).toBe('armed');
    expect(q('[data-add-skills-pull]')?.textContent).toBe('Release to refresh');
    await interact(() => body.dispatchEvent(touch('touchend', 0)));
    await settle();
    await settle();
    expect(browsed).toBe(2);
    expect(q('[data-add-skills-pull]')).toBeNull();
    expect(q('[data-add-skills-updated]')?.textContent).toBe('Updated just now');
    await view.unmount();
  });
});

describe('the search box', () => {
  it('has a search icon and the placeholder Search skills', async () => {
    const { members } = fakeMembers({ list: async () => [studio], browse: browseOk });
    const { host } = hostWith(members, { 'GET /v1/catalog-installs': () => ({ installs: [] }) });
    const { view } = await open(host);
    expect(q('[data-add-skills-search]')?.getAttribute('placeholder')).toBe('Search skills');
    expect(q('[data-add-skills-search]')?.parentElement?.querySelector('svg')).not.toBeNull();
    expect(q('label[for]')?.textContent).toBe('Search skills');
    await view.unmount();
  });
});

describe('Install from the sheet', () => {
  const installsSequence = (...lists: CatalogInstall[][]) => {
    let at = 0;
    return () => ({ installs: lists[Math.min(at++, lists.length - 1)] ?? [] });
  };

  it('opens the review, seeds this project, and says where it landed when closed', async () => {
    const { members } = fakeMembers({
      list: async () => [studio],
      browse: browseOk,
      openItem: async () => okAttempt({ item: shared.skill, opened: shared.opened, entry: entry() }),
    });
    const { host } = hostWith(members, {
      // first read opens the sheet, second is the snapshot before opening, third the read after closing
      'GET /v1/catalog-installs': installsSequence([], [], [studioInstall(PROJECT_TARGET)]),
    });
    const { view, events } = await open(host);
    await click(q('[data-add-skills-install]'));
    await settle();
    expect(q('[data-catalog-sheet="shared-item"] h3')?.textContent).toBe('pdf-tools');

    await click(q('[data-shared-install-button]'));
    await settle();
    expect((q('[data-catalog-scope]') as HTMLSelectElement).value).toBe('project');
    expect((q('[data-catalog-project]') as HTMLSelectElement).value).toBe('/work/app');

    await click(q('button[aria-label="Close Install on a machine"]'));
    await click(q('button[aria-label="Close pdf-tools"]'));
    await settle();
    expect(q('[data-add-skills-page]')).not.toBeNull();
    expect(q('[data-add-skills-landed]')?.textContent).toBe(
      `Installed pdf-tools in this project (every session in this folder). ${CLAUDE_LIVE}`,
    );
    expect(events).toEqual([]);
    expect(q('[data-add-skills-installed]')).not.toBeNull();
    await view.unmount();
  });

  it('says /reload-skills may be needed when the session saw no skill of that kind', async () => {
    const { members } = fakeMembers({
      list: async () => [studio],
      browse: browseOk,
      openItem: async () => okAttempt({ item: shared.skill, opened: shared.opened, entry: entry() }),
    });
    const { host } = hostWith(members, {
      'GET /v1/catalog-installs': installsSequence([], [], [studioInstall(PROJECT_TARGET)]),
    });
    const { view } = await open(host, { ...SKILLS, skills: [skill({ name: 'floop', scope: 'ferretry' })] });
    await click(q('[data-add-skills-install]'));
    await settle();
    await click(q('button[aria-label="Close pdf-tools"]'));
    await settle();
    expect(q('[data-add-skills-landed]')?.textContent).toContain(CLAUDE_RELOAD);
    await view.unmount();
  });

  it('says nothing landed when the person closed the review without installing', async () => {
    const { members } = fakeMembers({
      list: async () => [studio],
      browse: browseOk,
      openItem: async () => okAttempt({ item: shared.skill, opened: shared.opened, entry: entry() }),
    });
    const { host } = hostWith(members, { 'GET /v1/catalog-installs': () => ({ installs: [] }) });
    const { view, events } = await open(host);
    await click(q('[data-add-skills-install]'));
    await settle();
    await click(q('button[aria-label="Close pdf-tools"]'));
    await settle();
    expect(q('[data-add-skills-landed]')).toBeNull();
    expect(events).toEqual([]);
    await view.unmount();
  });

  it('says nothing landed when the install records cannot be read afterwards', async () => {
    const { members } = fakeMembers({
      list: async () => [studio],
      browse: browseOk,
      openItem: async () => okAttempt({ item: shared.skill, opened: shared.opened, entry: entry() }),
    });
    let reads = 0;
    const { host } = hostWith(members, {
      'GET /v1/catalog-installs': () => {
        reads += 1;
        if (reads > 2) throw new Error('machine went away');
        return { installs: [] };
      },
    });
    const { view, events } = await open(host);
    await click(q('[data-add-skills-install]'));
    await settle();
    await click(q('button[aria-label="Close pdf-tools"]'));
    await settle();
    expect(q('[data-add-skills-landed]')).toBeNull();
    expect(events).toEqual([]);
    await view.unmount();
  });

  it('seeds this account when the session has no folder in a project', async () => {
    const { members } = fakeMembers({
      list: async () => [studio],
      browse: browseOk,
      openItem: async () => okAttempt({ item: shared.skill, opened: shared.opened, entry: entry() }),
    });
    const { host } = hostWith(
      members,
      { 'GET /v1/catalog-installs': () => ({ installs: [] }) },
      { cwd: '/tmp/elsewhere' },
    );
    const { view } = await open(host);
    expect(q('[data-add-skills-scope]')?.textContent).toContain(
      'Installs into this account (every session on claude-work).',
    );
    await click(q('[data-add-skills-install]'));
    await settle();
    await click(q('[data-shared-install-button]'));
    await settle();
    expect((q('[data-catalog-scope]') as HTMLSelectElement).value).toBe('runtime');
    expect((q('[data-catalog-runtime]') as HTMLSelectElement).value).toBe('rt-work');
    await view.unmount();
  });

  it('asks the person to pick when neither the project nor the runtime is known', async () => {
    const { members } = fakeMembers({ list: async () => [studio], browse: browseOk });
    const { host } = hostWith(
      members,
      {
        'GET /v1/catalog-installs': () => ({ installs: [] }),
        'GET /v1/fleet/runtimes': () => {
          throw new Error('offline');
        },
      },
      { cwd: undefined },
    );
    const { view } = await open(host);
    expect(q('[data-add-skills-scope]')?.textContent).toBe(PICK_A_PLACE);
    await view.unmount();
  });

  it('shows Working… on the row while the item opens', async () => {
    const hold = deferred<ReturnType<typeof refusedAttempt>>();
    const { members } = fakeMembers({
      list: async () => [studio],
      browse: browseOk,
      openItem: async () => (await hold.promise) as never,
    });
    const { host } = hostWith(members, { 'GET /v1/catalog-installs': () => ({ installs: [] }) });
    const { view } = await open(host);
    await click(q('[data-add-skills-install]'));
    expect(q('[data-add-skills-install]')?.textContent).toContain('Working…');
    hold.resolve(refusedAttempt());
    await settle();
    expect(q('[data-add-skills-refused]')).not.toBeNull();
    await view.unmount();
  });

  it('says why the item could not be opened', async () => {
    const { members } = fakeMembers({
      list: async () => [studio],
      browse: browseOk,
      openItem: async () => failedAttempt('other', 'The publisher did not answer.'),
    });
    const { host } = hostWith(members, { 'GET /v1/catalog-installs': () => ({ installs: [] }) });
    const { view } = await open(host);
    await click(q('[data-add-skills-install]'));
    await settle();
    expect(text()).toContain('The publisher did not answer.');
    expect(q('[data-add-skills-install]')).not.toBeNull();
    await view.unmount();
  });
});

describe('the app store as the default source', () => {
  it('reads the subscriptions and the known projects from the store', async () => {
    const { members } = fakeMembers({ list: async () => [studio], browse: browseOk });
    const { host } = hostWith(members, { 'GET /v1/catalog-installs': () => ({ installs: [] }) });
    const { members: _members, install, ...rest } = host;
    const storeHost: AddSkillsHost = { ...rest, install: { ...(install ?? {}), projects: undefined } };
    const store = {
      members,
      projects: { subscribe: () => () => undefined, slice: () => 1, projects: () => PROJECTS },
    } as unknown as AppStore;
    const view = await mount(
      <StoreProvider store={store}>
        <AddSkillsPage {...storeHost} loadInventory={async () => SKILLS} onNavigate={() => undefined} />
      </StoreProvider>,
    );
    await settle();
    await settle();
    expect(rows()).toHaveLength(1);
    expect(q('[data-add-skills-scope]')?.textContent).toContain('this project');
    await view.unmount();
  });

  it('uses the host’s own members and projects when given only one of them', async () => {
    const { members } = fakeMembers({ list: async () => [studio], browse: browseOk });
    const { host } = hostWith(members, { 'GET /v1/catalog-installs': () => ({ installs: [] }) });
    const store = {
      members: fakeMembers({}).members,
      projects: { subscribe: () => () => undefined, slice: () => 1, projects: () => [] },
    } as unknown as AppStore;
    const view = await mount(
      <StoreProvider store={store}>
        <AddSkillsPage
          {...host}
          install={{ ...host.install, projects: undefined }}
          loadInventory={async () => SKILLS}
          onNavigate={() => undefined}
        />
      </StoreProvider>,
    );
    await settle();
    await settle();
    expect(rows()).toHaveLength(1);
    expect(q('[data-add-skills-scope]')?.textContent).toContain('this account');
    await view.unmount();
  });
});
