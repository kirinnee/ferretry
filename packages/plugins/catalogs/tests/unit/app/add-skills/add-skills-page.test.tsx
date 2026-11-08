import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { interact, mount, must } from '@ferretry/app/testing';
import { AddSkillsPage, type AddSkillsPageProps } from '../../../../app/features/add-skills/add-skills-page.tsx';
import type { RuntimeChoice } from '../../../../app/features/add-skills/add-skills-model.ts';
import { CatalogClientProvider } from '../../../../app/lib/client-context.tsx';
import { daemonConnection } from '../../../../app/lib/machine.ts';
import type { MemberSubscription } from '../../../../app/lib/member-keys.ts';
import { fakeClient } from '../support/catalog-client.ts';
import { INSTALL_ID, installPreview, installRecord } from '../support/catalog-views.ts';
import { click, settle, typeInto } from '../support/dom-form.ts';
import { testSubscription } from '../support/member-keys.ts';
import {
  deferred,
  failedAttempt,
  fakeMembers,
  type Members,
  okAttempt,
  refusedAttempt,
  type SharedItemFixture,
  sharedItemFixture,
} from '../support/shared-screens.ts';

beforeEach(() => {
  document.body.replaceChildren();
});

const q = (selector: string): HTMLElement | null => document.querySelector<HTMLElement>(selector);
const all = (selector: string): HTMLElement[] => [...document.querySelectorAll<HTMLElement>(selector)];
const text = (): string => document.body.textContent ?? '';

const loftId = `fy_daemon_${'r'.repeat(43)}`;
const alpha = daemonConnection({ daemonId: 'alpha' });
const NOW = new Date('2026-11-08T12:00:00.000Z');
const LATER = new Date('2026-11-08T12:05:00.000Z');

let shared: SharedItemFixture;
let studio: MemberSubscription;
let loft: MemberSubscription;
beforeAll(async () => {
  shared = await sharedItemFixture();
  studio = await testSubscription(shared.identity.daemonId, { ownLabel: 'Studio' });
  loft = await testSubscription(loftId, { ownLabel: 'Loft' });
});

const noInstalls = { 'GET /v1/catalog-installs': () => ({ installs: [] }) };
const place = { cwd: '/work/app', harness: 'claude' as const, runtime: 'box', scopes: ['user'] };
const projects = [{ name: 'app', path: '/work/app' }];
const runtimes: readonly RuntimeChoice[] = [{ id: 'box', wrapper: 'box', profile: 'default' }];

interface Opened {
  readonly fake: ReturnType<typeof fakeClient>;
  readonly members: ReturnType<typeof fakeMembers>;
  readonly view: Awaited<ReturnType<typeof mount>>;
  readonly moves: string[];
}

async function open(
  handlers: Parameters<typeof fakeMembers>[0],
  client: Parameters<typeof fakeClient>[0] = noInstalls,
  extra: Partial<AddSkillsPageProps> = {},
  throughProvider = false,
): Promise<Opened> {
  const fake = fakeClient(client);
  const members = fakeMembers(handlers);
  const moves: string[] = [];
  const page = (
    <AddSkillsPage
      connection={alpha}
      machineName="Studio laptop"
      ferret="f1"
      place={place}
      members={members.members}
      onBack={() => moves.push('back')}
      onSubscribe={() => moves.push('subscribe')}
      {...(throughProvider ? {} : { install: { createClient: fake.factory as never, projects } })}
      runtimes={runtimes}
      {...extra}
    />
  );
  const view = await mount(
    throughProvider ? <CatalogClientProvider client={fake.client}>{page}</CatalogClientProvider> : page,
  );
  await settle();
  return { fake, members, view, moves };
}

const browseOk = async () => okAttempt(shared.browse);
const two = (): Partial<Members> => ({ list: async () => [studio, loft], browse: browseOk });

afterEach(() => {
  document.body.replaceChildren();
});

describe('S-0010 the Add skills page lists the skills of every subscribed catalog, grouped, with a filter and Refresh', () => {
  it('groups each catalog’s skills under its name and publisher, skills only, and filters by catalog', async () => {
    const { view } = await open(two());
    expect(q('h1')?.textContent).toBe('Add skills');
    expect(q('[data-add-skills-scope]')?.textContent).toBe(
      'Installs into this project (every ferret in this folder). You can pick another place when you install.',
    );
    const groups = all('[data-add-skills-catalog]');
    expect(groups).toHaveLength(2);
    expect(groups[0]?.querySelector('h2')?.textContent).toBe("Kirin's catalog");
    expect(groups[0]?.textContent).toContain('from Studio · 1 skill');
    expect(groups[1]?.textContent).toContain('from Loft · 1 skill');
    // The catalog's MCP item is not a skill.
    expect(text()).not.toContain('acme-mcp');
    const chips = all('[data-context-filter-chip], [role="radio"], button[aria-pressed]').map(chip => chip.textContent);
    expect(chips.join(' ')).toContain("Kirin's catalog (Studio)");
    const chip = all('button').find(button => button.textContent?.includes("Kirin's catalog (Loft)"));
    await click(chip ?? null);
    expect(all('[data-add-skills-catalog]')).toHaveLength(1);
    expect(q('[data-add-skills-catalog]')?.textContent).toContain('from Loft');
    await view.unmount();
  });

  it('narrows by the words typed, and says when nothing matches', async () => {
    const { view } = await open(two());
    await typeInto(q('[data-add-skills-search]'), 'ocr');
    expect(all('[data-add-skills-row]')).toHaveLength(2);
    await typeInto(q('[data-add-skills-search]'), 'nothing like this');
    expect(all('[data-add-skills-row]')).toHaveLength(0);
    expect(q('[data-add-skills-none]')?.textContent).toBe('No subscribed skill matches that.');
    await view.unmount();
  });

  it('Refresh reads every subscription again and says when', async () => {
    const times = [NOW, LATER];
    let browses = 0;
    const { view, members } = await open(
      { list: async () => [studio], browse: async () => (browses++, okAttempt(shared.browse)) },
      noInstalls,
      { clock: { now: () => times.shift() ?? LATER, ticker: () => () => undefined } },
    );
    expect(q('[data-add-skills-updated]')?.textContent).toBe('Updated just now');
    await click(q('[data-add-skills-refresh]'));
    await settle();
    expect(browses).toBe(2);
    expect(members.calls.filter(call => call === 'list')).toHaveLength(2);
    await view.unmount();
  });

  it('a publisher that did not answer is named in one line, and the list on screen stays', async () => {
    let round = 0;
    const { view } = await open({
      list: async () => [studio],
      browse: async () => (round++ === 0 ? okAttempt(shared.browse) : failedAttempt('unreachable', 'offline')),
    });
    await click(q('[data-add-skills-refresh]'));
    await settle();
    expect(q('[data-add-skills-updated]')?.textContent).toBe('Could not reach Studio, so the list may be out of date.');
    expect(all('[data-add-skills-row]')).toHaveLength(1);
    await view.unmount();
  });

  it('reads again when the tab comes back, and not while a read is under way', async () => {
    let browses = 0;
    const gate = deferred<void>();
    const { view } = await open({
      list: async () => [studio],
      browse: async () => {
        browses += 1;
        if (browses === 2) await gate.promise;
        return okAttempt(shared.browse);
      },
    });
    document.dispatchEvent(new Event('visibilitychange'));
    await settle();
    expect(browses).toBe(2);
    document.dispatchEvent(new Event('visibilitychange'));
    await settle();
    expect(browses).toBe(2);
    gate.resolve();
    await settle();
    await view.unmount();
  });

  it('pulling down from the top reads again; a short pull does not', async () => {
    let browses = 0;
    const { view } = await open({
      list: async () => [studio],
      browse: async () => (browses++, okAttempt(shared.browse)),
    });
    const body = must(q('[data-add-skills-body]'), 'the body');
    const touch = (type: string) => new Event(type, { bubbles: true }) as Event & { touches: { clientY: number }[] };
    const fire = async (type: string, y: number) => {
      const event = touch(type);
      event.touches = type === 'touchend' ? [] : [{ clientY: y }];
      await interact(() => body.dispatchEvent(event));
    };
    await fire('touchstart', 0);
    await fire('touchmove', 30);
    expect(q('[data-add-skills-pull]')?.getAttribute('data-add-skills-pull')).toBe('pulling');
    await fire('touchend', 30);
    expect(browses).toBe(1);
    await fire('touchstart', 0);
    await fire('touchmove', 90);
    expect(q('[data-add-skills-pull]')?.getAttribute('data-add-skills-pull')).toBe('armed');
    await fire('touchend', 90);
    await settle();
    expect(browses).toBe(2);
    await view.unmount();
  });

  it('says it is reading, then that no catalog is subscribed to, and offers the link', async () => {
    const gate = deferred<readonly MemberSubscription[]>();
    const { view, moves } = await open({ list: async () => await gate.promise });
    expect(text()).toContain('Reading your subscriptions…');
    gate.resolve([]);
    await settle();
    expect(q('[data-add-skills-empty]')?.textContent).toContain('You do not subscribe to any catalog yet.');
    expect(q('[data-add-skills-search]')).toBeNull();
    await click(q('[data-add-skills-subscribe]'));
    await click(q('[data-add-skills-back]'));
    expect(moves).toEqual(['subscribe', 'back']);
    await view.unmount();
  });
});

describe('S-0255 a skill row names the skill, its version and summary, and offers Install or says Installed', () => {
  it('shows Install for a skill not installed here and Installed for one that is', async () => {
    const installed = {
      ...installRecord('skill', 'pdf-tools'),
      provenance: {
        ...installPreview().provenance,
        publisher: shared.identity.daemonId,
        itemId: shared.skill.itemId,
        kind: 'skill' as const,
        name: 'pdf-tools',
      },
    };
    const { view } = await open(two(), { 'GET /v1/catalog-installs': () => ({ installs: [installed] }) });
    const rows = all('[data-add-skills-row]');
    expect(rows[0]?.textContent).toContain('pdf-tools');
    expect(rows[0]?.textContent).toContain('v1');
    expect(rows[0]?.textContent).toContain('Split, merge and OCR PDFs');
    expect(rows[0]?.querySelector('[data-add-skills-installed]')?.textContent).toBe('Installed');
    expect(rows[0]?.querySelector('[data-add-skills-install]')).toBeNull();
    expect(rows[1]?.querySelector('[data-add-skills-install]')?.textContent).toContain('Install');
    await view.unmount();
  });
});

describe('S-0262 the page reads the machine through the client the shell built for it', () => {
  it('lists installs through the daemon-bound client when the host names none, and places nothing without a project', async () => {
    const { view, fake } = await open(
      { list: async () => [studio], browse: browseOk },
      noInstalls,
      { place: { ...place, cwd: undefined, runtime: undefined }, install: undefined },
      true,
    );
    expect(fake.calls.map(call => call.path)).toContain('/v1/catalog-installs');
    expect(q('[data-add-skills-scope]')?.textContent).toBe('You will pick where to install it.');
    await view.unmount();
  });

  it('puts this account first when the ferret has no project and the host names its runtime', async () => {
    const { view } = await open({ list: async () => [studio], browse: browseOk }, noInstalls, {
      place: { ...place, cwd: '/elsewhere' },
      install: { createClient: (async () => fakeClient(noInstalls).client) as never, projects },
    });
    expect(q('[data-add-skills-scope]')?.textContent).toContain('this account (every ferret on box)');
    await view.unmount();
  });
});

describe('S-0304 the page installs through the existing review and says where the skill landed', () => {
  const skillInstall = (target: Record<string, unknown>) => ({
    ...installRecord('skill', 'pdf-tools'),
    installId: INSTALL_ID,
    provenance: {
      ...installPreview().provenance,
      publisher: shared.identity.daemonId,
      itemId: shared.skill.itemId,
      kind: 'skill' as const,
      name: 'pdf-tools',
    },
    target,
  });

  async function install(
    target: Record<string, unknown>,
    harness: 'claude' | 'codex' = 'claude',
    scopes: string[] = ['project'],
  ) {
    let listed = 0;
    const opened = await open(
      {
        list: async () => [studio],
        browse: browseOk,
        openItem: async () => okAttempt({ item: shared.skill, opened: shared.opened, entry: shared.entries[0]! }),
      },
      { 'GET /v1/catalog-installs': () => ({ installs: listed++ < 2 ? [] : [skillInstall(target)] }) },
      { place: { ...place, harness, scopes } },
    );
    await click(q('[data-add-skills-install]'));
    await settle();
    expect(q('[data-catalog-sheet="shared-item"] h3')?.textContent).toBe('pdf-tools');
    await click(q('button[aria-label="Close pdf-tools"]'));
    await settle();
    return opened;
  }

  it('says it is active now when the ferret reads the project it went into', async () => {
    const { view } = await install({ scope: 'project', projectRoot: '/work/app', harness: 'claude' });
    expect(q('[data-add-skills-landed]')?.textContent).toBe(
      'Installed pdf-tools in this project (every ferret in this folder). It is active in this ferret now.',
    );
    expect(q('[data-add-skills-installed]')).not.toBeNull();
    await view.unmount();
  });

  it('says a reload may be needed when it made the skills folder, and that Codex reads it next time', async () => {
    const first = await install({ scope: 'project', projectRoot: '/work/app', harness: 'claude' }, 'claude', ['user']);
    expect(q('[data-add-skills-landed]')?.textContent).toContain('/reload-skills');
    await first.view.unmount();
    const second = await install({ scope: 'project', projectRoot: '/work/app', harness: 'codex' }, 'codex');
    expect(q('[data-add-skills-landed]')?.textContent).toContain('from the next ferret you start');
    await second.view.unmount();
  });

  it('says the ferret does not read a place it was installed to elsewhere', async () => {
    const { view } = await install({ scope: 'runtime', runtime: 'other', profile: 'default' });
    expect(q('[data-add-skills-landed]')?.textContent).toBe(
      'Installed pdf-tools on the account other. This ferret does not read that place, so it is not active here.',
    );
    await view.unmount();
  });

  it('says nothing when the sheet was closed without installing', async () => {
    const { view } = await open({
      list: async () => [studio],
      browse: browseOk,
      openItem: async () => okAttempt({ item: shared.skill, opened: shared.opened, entry: shared.entries[0]! }),
    });
    await click(q('[data-add-skills-install]'));
    await settle();
    await click(q('button[aria-label="Close pdf-tools"]'));
    await settle();
    expect(q('[data-add-skills-landed]')).toBeNull();
    await view.unmount();
  });

  it('keeps what it knows when the machine cannot list installs after the sheet closes', async () => {
    let listed = 0;
    const { view } = await open(
      {
        list: async () => [studio],
        browse: browseOk,
        openItem: async () => okAttempt({ item: shared.skill, opened: shared.opened, entry: shared.entries[0]! }),
      },
      {
        'GET /v1/catalog-installs': () => {
          if (listed++ >= 2) throw new Error('gone');
          return { installs: [] };
        },
      },
    );
    await click(q('[data-add-skills-install]'));
    await settle();
    await click(q('button[aria-label="Close pdf-tools"]'));
    await settle();
    expect(q('[data-add-skills-landed]')).toBeNull();
    await view.unmount();
  });

  it('says why an item could not be opened, and sends a refused key to the refused note', async () => {
    const failed = await open({
      list: async () => [studio],
      browse: browseOk,
      openItem: async () => failedAttempt('gone', 'That item is gone.'),
    });
    await click(q('[data-add-skills-install]'));
    await settle();
    expect(text()).toContain('That item is gone.');
    await failed.view.unmount();
    const refused = await open({
      list: async () => [studio],
      browse: browseOk,
      openItem: async () => refusedAttempt(),
    });
    await click(q('[data-add-skills-install]'));
    await settle();
    expect(q('[data-add-skills-refused]')?.textContent).toContain('Refused this browser.');
    await refused.view.unmount();
  });
});

describe('S-0262 each publisher says in one line what it could not list', () => {
  it('shows locked with Unlock, then the skills once unlocked; and a failed unlock says why', async () => {
    let locked = true;
    let unlocks = 0;
    const { view } = await open({
      list: async () => [studio],
      browse: async () =>
        locked ? failedAttempt('locked', 'Unlock with your passkey first.') : okAttempt(shared.browse),
      unlock: async () => {
        unlocks += 1;
        if (unlocks === 1) return failedAttempt('ceremony', 'The passkey did not work.');
        if (unlocks === 2) return refusedAttempt();
        locked = false;
        return okAttempt('ok');
      },
    });
    expect(q('[data-add-skills-locked]')).not.toBeNull();
    await click(q('[data-add-skills-unlock]'));
    await settle();
    expect(q('[data-add-skills-failed]')?.textContent).toBe('The passkey did not work.');
    locked = true;
    await click(q('[data-add-skills-refresh]'));
    await settle();
    await click(q('[data-add-skills-unlock]'));
    await settle();
    expect(q('[data-add-skills-refused]')).not.toBeNull();
    await view.unmount();
  });

  it('shows offline with Try again, which asks again, and a refused subscription asks nothing', async () => {
    let browses = 0;
    const { view } = await open({
      list: async () => [studio, { ...loft, status: 'refused' }],
      browse: async () => (browses++ === 0 ? failedAttempt('unreachable', 'down') : okAttempt(shared.browse)),
    });
    expect(q('[data-add-skills-offline]')?.textContent).toContain('Try again');
    expect(q(`[data-add-skills-publisher="${loftId}"] [data-add-skills-refused]`)).not.toBeNull();
    await click(q('[data-add-skills-again]'));
    await settle();
    expect(all('[data-add-skills-row]')).toHaveLength(1);
    expect(browses).toBe(2);
    await view.unmount();
  });

  it('hides a publisher’s note once the list is narrowed to one catalog', async () => {
    const third = await testSubscription(`fy_daemon_${'t'.repeat(43)}`, { ownLabel: 'Third' });
    const { view } = await open({
      list: async () => [studio, loft, third],
      browse: async (sub: MemberSubscription) =>
        sub.daemonId === loftId ? failedAttempt('gone', 'It is gone.') : okAttempt(shared.browse),
    });
    expect(q(`[data-add-skills-publisher="${loftId}"]`)).not.toBeNull();
    await click(all('button').find(button => button.textContent?.includes('(Third)')) ?? null);
    expect(q(`[data-add-skills-publisher="${loftId}"]`)).toBeNull();
    await view.unmount();
  });

  it('keeps a publisher’s note out of a single-catalog view', async () => {
    const { view } = await open({
      list: async () => [studio, loft],
      browse: async (sub: MemberSubscription) =>
        sub.daemonId === loftId ? failedAttempt('gone', 'It is gone.') : okAttempt(shared.browse),
    });
    expect(q(`[data-add-skills-publisher="${loftId}"]`)?.textContent).toContain('It is gone.');
    await view.unmount();
  });
});
