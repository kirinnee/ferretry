/**
 * The Add skills screen and its way in, one test per screen state (owner decision !A468). Catalogs owns the page (the
 * catalogs group only); Skills offers the `skills.add` slot and Catalogs contributes “+ Add skills” to it.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { ScreenHrefProvider } from '@ferretry/app';
import { mount, noteClientDaemon, RouterProvider, settleUntil, interact } from '@ferretry/app/testing';
import { SKILLS_ADD_SLOT } from '@ferretry/plugin-skills/contract';
import { type FunctionComponent, Suspense } from 'react';
import { AddSkillsPage } from '../../../app/features/add-skills/add-skills-page.tsx';
import half from '../../../app/index.ts';
import { placeQuery } from '../../../app/lib/add-skills-address.ts';
import { CatalogClientProvider } from '../../../app/lib/client-context.tsx';
import { daemonConnection } from '../../../app/lib/machine.ts';
import type { MemberSubscription } from '../../../app/lib/member-keys.ts';
import manifest from '../../../manifest.ts';
import { fakeClient } from '../app/support/catalog-client.ts';
import { installPreview, installRecord } from '../app/support/catalog-views.ts';
import { click, settle } from '../app/support/dom-form.ts';
import { testSubscription } from '../app/support/member-keys.ts';
import { fakeMembers, okAttempt, type SharedItemFixture, sharedItemFixture } from '../app/support/shared-screens.ts';

const q = (selector: string): HTMLElement | null => document.querySelector<HTMLElement>(selector);
const all = (selector: string): HTMLElement[] => [...document.querySelectorAll<HTMLElement>(selector)];

let shared: SharedItemFixture;
let studio: MemberSubscription;
let loft: MemberSubscription;
beforeAll(async () => {
  shared = await sharedItemFixture();
  studio = await testSubscription(shared.identity.daemonId, { ownLabel: 'Studio' });
  loft = await testSubscription(`fy_daemon_${'r'.repeat(43)}`, { ownLabel: 'Loft' });
});
beforeEach(() => document.body.replaceChildren());
afterEach(() => document.body.replaceChildren());

const place = { cwd: '/work/app', harness: 'claude' as const, runtime: 'box', scopes: ['user'] };
const props = { ferret: 'f1', folder: '/work/app', harness: 'codex' as const, runtime: 'box', scopes: ['project'] };

describe('the Add skills page', () => {
  it('S-0010 S-0255 S-0262 lists every subscribed catalog’s skills, grouped, each row with name, version, summary and Install or Installed, for this machine’s ferret', async () => {
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
    const fake = fakeClient({ 'GET /v1/catalog-installs': () => ({ installs: [installed] }) });
    const members = fakeMembers({ list: async () => [studio, loft], browse: async () => okAttempt(shared.browse) });
    const view = await mount(
      <AddSkillsPage
        connection={daemonConnection({ daemonId: 'alpha' })}
        machineName="Studio laptop"
        ferret="f1"
        place={place}
        members={members.members}
        onBack={() => undefined}
        onSubscribe={() => undefined}
        install={{ createClient: fake.factory as never, projects: [{ name: 'app', path: '/work/app' }] }}
        runtimes={[{ id: 'box', wrapper: 'box', profile: 'default' }]}
      />,
    );
    await settle();
    // S-0010: the heading, where it installs, one group per catalog with its publisher, skills only, and a filter
    expect(q('h1')?.textContent).toBe('Add skills');
    expect(q('[data-add-skills-scope]')?.textContent).toContain('Installs into this project');
    const groups = all('[data-add-skills-catalog]');
    expect(groups).toHaveLength(2);
    expect(groups[0]?.textContent).toContain('from Studio · 1 skill');
    expect(groups[1]?.textContent).toContain('from Loft · 1 skill');
    expect(document.body.textContent).not.toContain('acme-mcp');
    expect(q('[data-add-skills-search]')).not.toBeNull();
    // S-0255: a row names the skill, its version and summary; Installed where it is, Install where it is not
    const rows = all('[data-add-skills-row]');
    expect(rows[0]?.textContent).toContain('pdf-tools');
    expect(rows[0]?.textContent).toContain('v1');
    expect(rows[0]?.textContent).toContain('Split, merge and OCR PDFs');
    expect(rows[0]?.querySelector('[data-add-skills-installed]')?.textContent).toBe('Installed');
    expect(rows[1]?.querySelector('[data-add-skills-install]')?.textContent).toContain('Install');
    // S-0262: it read the installs through the client the shell built for this machine
    expect(fake.calls.map(call => call.path)).toContain('/v1/catalog-installs');
    await view.unmount();
  });

  it('S-0262 with the host naming no install client, the page reads installs through the daemon-bound client of the app’s client context', async () => {
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
    const fake = fakeClient({ 'GET /v1/catalog-installs': () => ({ installs: [installed] }) });
    const members = fakeMembers({ list: async () => [studio], browse: async () => okAttempt(shared.browse) });
    const view = await mount(
      <CatalogClientProvider client={fake.client}>
        <AddSkillsPage
          connection={daemonConnection({ daemonId: 'alpha' })}
          machineName="Studio laptop"
          ferret="f1"
          place={place}
          members={members.members}
          onBack={() => undefined}
          onSubscribe={() => undefined}
        />
      </CatalogClientProvider>,
    );
    await settle();
    // No `install` prop at all: the installs read went to the context's client, and its answer drew "Installed".
    expect(fake.calls.map(call => call.path)).toContain('/v1/catalog-installs');
    expect(all('[data-add-skills-row]')[0]?.querySelector('[data-add-skills-installed]')?.textContent).toBe(
      'Installed',
    );
    // And no project is known to the page, so it does not claim to install into one.
    expect(q('[data-add-skills-scope]')?.textContent).not.toContain('/work/app');
    await view.unmount();
  });
});

describe('the way in to the Add skills page', () => {
  it('S-0388 S-0304 the manifest declares the screen under a ferret and one panel in skills.add, which draws “+ Add skills” and goes to the page with the place', async () => {
    expect(manifest.ui?.screens?.find(screen => screen.id === 'add-skills')?.path).toBe('ferrets/:ferret/add-skills');
    expect(manifest.ui?.panels).toEqual([{ slot: SKILLS_ADD_SLOT, id: 'add-skills', order: 10 }] as never);
    const client = { call: async () => ({}) } as never;
    noteClientDaemon(client, 'alpha');
    const built = half.build?.({ manifest: half.manifest, client });
    expect(Object.keys(built?.panels ?? {})).toEqual(['add-skills']);
    const Panel = built?.panels?.['add-skills'] as unknown as FunctionComponent<Record<string, unknown>>;
    const view = await mount(
      <RouterProvider>
        <Suspense fallback={null}>
          <ScreenHrefProvider
            href={(daemon, plugin, screen, params) => `/d/${daemon}/${plugin}/${screen}/${params?.ferret}`}
          >
            <Panel {...props} subject="f1" />
          </ScreenHrefProvider>
        </Suspense>
      </RouterProvider>,
    );
    await settleUntil(() => q('[data-context-add-skills]') !== null, 'the button', interact);
    expect(q('[data-context-add-skills]')?.textContent).toBe('+ Add skills');
    await click(q('[data-context-add-skills]'));
    await settle();
    expect(`${globalThis.location.pathname}${globalThis.location.search}`).toBe(
      `/d/alpha/catalogs/add-skills/f1${placeQuery(props)}`,
    );
    await view.unmount();
  });
});
