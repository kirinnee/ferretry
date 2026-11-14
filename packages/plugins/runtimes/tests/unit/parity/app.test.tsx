/**
 * Runtimes' app half, parity with today's Runtimes, Profiles and Model sets surfaces and the composer's runtime picker
 * (docs/design/rebuild-parity.tsv, owner `runtimes`, kind S). One test per screen per state, its title naming every row
 * it proves.
 *
 * Each screen is proved by drawing it: the half the plugin builds is mounted (every surface lazy behind a Suspense
 * boundary, as the shell mounts it) over a scripted daemon client, and the test reads what it drew. A menu, dialog or
 * page behind an action is opened by a short scripted walk inside the same test. A screen that only shows in another
 * state (a runtime's own page, an empty list, a blocked delete) gets its own state and its own test.
 *
 * Today's Components tab drew six kinds behind a kinds page; Runtimes draws only the model sets, straight to their
 * list, so the model set screens stand in for today's component screens here. The tabs' own behaviour is in the suites
 * under `tests/unit/app/features/fleet/`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { interact, type Mounted, mount, must, settleUntil } from '@ferretry/app/testing';
import type { PanelProps, PluginClient, SettingsProps } from '@ferretry/kernel/manifest';
import { createElement, type FunctionComponent, Suspense } from 'react';
import app from '../../../app/index.ts';
import {
  type ComponentView,
  ComponentCatalogSchema,
  type ProfileDraftView,
  RuntimeCatalogSchema,
  type RuntimeView,
} from '../../../contract/index.ts';
import manifest from '../../../manifest.ts';
import { READS, RUNTIMES, runtime, scripted, stagedFrom, DATA } from '../app/features/fleet/account-support.ts';
import type { Call } from '../app/features/fleet/account-support.ts';
import {
  component,
  componentCatalog,
  models,
  profile,
  profileCatalog,
  runtimeCatalog,
  stack,
  studioCatalog,
} from '../app/features/fleet/components/catalog-fixture.ts';
import {
  click as clickSelector,
  type Machine,
  machineClient,
  scriptedMachine,
  TAB_PATH,
  text,
} from '../app/features/fleet/components/view-support.tsx';

/** Agent runtimes (the default's candidates), one plain runtime, on a machine whose default is `claude-default`. */
const LISTED: readonly RuntimeView[] = [
  runtime({ name: 'claude-default', agent: true }),
  runtime({
    name: 'claude-work',
    agent: true,
    credential: { id: 'claude-work', store: 'ferretry', label: 'work', status: 'ready' },
  }),
  runtime({
    name: 'codex-kirin',
    agent: true,
    harness: 'codex',
    credential: { id: 'codex', store: 'host', status: 'ready' },
  }),
  runtime({ name: 'claude-plain' }),
];

const catalogOf = (runtimes: readonly RuntimeView[]) => RuntimeCatalogSchema.parse({ ...RUNTIMES, runtimes });

/** A daemon that answers the machine's reads, plus whatever routes a test adds. */
const daemon = (
  runtimes: readonly RuntimeView[],
  extra: Record<string, unknown> = {},
  calls: Call[] = [],
): PluginClient =>
  scripted({ ...READS({ ...DATA, runtimes: catalogOf(runtimes) }), ...extra }, calls) as unknown as PluginClient;

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
  globalThis.window.location.hash = '';
  globalThis.history?.replaceState({}, '', '/');
});

/** Puts the address bar at `path` and `hash`. `mount` registers the DOM on first use, so an address set first needs one. */
const at = async (path: string, hash = ''): Promise<void> => {
  if (typeof window === 'undefined') await (await mount(<i />)).unmount();
  window.history.replaceState({}, '', path);
  window.location.hash = hash;
};

/** Mounts one of the half's surfaces as the shell does (inside Suspense), and waits for `ready`. */
const draw = async <Props extends object>(
  component: unknown,
  props: Props,
  ready: (root: HTMLElement) => boolean,
  what: string,
): Promise<HTMLElement> => {
  const element = createElement(
    Suspense,
    { fallback: null },
    createElement(component as FunctionComponent<Props>, props),
  );
  view = await mount(element);
  const root = view.container;
  await settleUntil(
    () => ready(root),
    () => `${what}; drew: ${root.textContent ?? ''}`,
    interact,
  );
  return root;
};

const drawTab = async (client: PluginClient, ready: string, hash = ''): Promise<HTMLElement> => {
  await at('/d/d1/settings/runtimes/runtimes', hash);
  const half = app.build?.({ manifest, client });
  return await draw<SettingsProps>(
    half?.settings.runtimes,
    {},
    root => root.querySelector(ready) !== null,
    `the Runtimes tab drew ${ready}`,
  );
};

const settle = async (): Promise<void> => {
  await interact(async () => {
    for (let turn = 0; turn < 6; turn += 1) await new Promise(resolve => setTimeout(resolve, 0));
  });
};

const click = async (element: Element): Promise<void> => {
  await interact(() => (element as HTMLElement).click());
  await settle();
};

describe('the Runtimes Settings tab the half builds', () => {
  it('S-0210 S-0539 S-0206 S-0200 S-0208 S-0199 the Runtimes tab list draws its count, default control and a row per runtime, and each ⋯ action opens its menu or dialog', async () => {
    expect(manifest.ui?.settings?.find(tab => tab.id === 'runtimes')?.label).toBe('Runtimes');
    const ferrets = [
      { id: 's-1', name: 'Fisher', harness: 'claude-code' },
      { id: 's-2', name: 'Otter', harness: 'claude-code' },
    ];
    const staged = (call: Call) => ({
      ...stagedFrom(call),
      summary: 'Remove runtime',
      consequences: [
        '2 ferrets are running on it. They keep running, but restarting them later needs another runtime. Its past sessions stay in history.',
      ],
      preview: { kind: 'apply', operations: [], documents: [], runtimes: [], runningSessions: ferrets },
    });
    const root = await drawTab(daemon(LISTED, { 'POST /v1/runtimes/proposals': staged }), '[data-runtimes-tab]');

    // S-0210 and S-0539: the tab itself, with its count, Add runtime, one row per runtime and the default control.
    expect(text(root, '[data-runtimes-count]')).toBe('4 runtimes on studio-mac');
    expect([...root.querySelectorAll('[data-runtime-row]')].map(row => row.getAttribute('data-runtime-row'))).toEqual([
      'claude-default',
      'claude-work',
      'codex-kirin',
      'claude-plain',
    ]);
    expect(text(root, '[data-add-runtime]')).toBe('Add runtime');
    expect(text(root, '[data-runtime-card="claude-default"] [data-runtime-default-badge]')).toBe('Default');
    const control = must(root.querySelector('[data-default-runtime]'), 'the default runtime control');
    expect(control.textContent).toContain('Default for new agents');
    expect(text(control, '[data-default-runtime-hint]')).toBe('Used when a start names no runtime.');
    const select = must(control.querySelector<HTMLSelectElement>('[data-default-runtime-select]'), 'the select');
    expect([...select.options].map(option => option.value)).toEqual(['claude-default', 'claude-work', 'codex-kirin']);
    expect(select.value).toBe('claude-default');
    expect(control.querySelector('[data-change-submit]')).toBeNull();
    // Picking another one shows the apply panel, never a save by itself.
    await interact(() => {
      select.value = 'claude-work';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await settle();
    expect(text(control, '[data-change-submit]')).toBe('Save default runtime');
    expect(text(control, '[data-default-runtime-undo]')).toBe('Keep claude-default');

    // S-0206: the ⋯ menu on a row offers Make default, Rename and a destructive Remove.
    const trigger = must(
      root.querySelector<HTMLButtonElement>('[data-runtime-card="claude-work"] [data-runtime-actions]'),
      'the ⋯ button on claude-work',
    );
    expect(trigger.getAttribute('aria-label')).toBe('Actions for claude-work');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    await click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    const menu = must(document.querySelector('[role="menu"]'), 'the actions menu');
    expect(menu.getAttribute('aria-label')).toBe('Actions for claude-work');
    const items = new Map(
      [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')].map(item => [
        item.getAttribute('data-menu-key'),
        item,
      ]),
    );
    expect([...items.keys()]).toEqual(['make-default', 'rename', 'remove']);
    expect(items.get('make-default')?.textContent).toBe('Make default');
    expect(items.get('rename')?.textContent).toBe('Rename');
    expect(items.get('remove')?.textContent).toBe('Remove');
    expect(items.get('remove')?.className).toContain('text-err');
    // Escape closes the menu, as the shared menu's keyboard contract says.
    await interact(() => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      );
    });
    await settle();
    expect(document.querySelector('[role="menu"]')).toBeNull();

    // S-0208 and S-0200: Rename opens the dialog frame (a modal with its title and a scrim that closes it) and its fields.
    await click(must(root.querySelector('[data-runtime-card="codex-kirin"] [data-runtime-actions]'), 'the ⋯ button'));
    await click(must(document.querySelector('[role="menu"] [data-menu-key="rename"]'), 'Rename in the menu'));
    const dialog = must(document.querySelector('[data-runtime-dialog="rename"]'), 'the rename dialog');
    expect(dialog.getAttribute('role')).toBe('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(text(dialog, 'h2')).toBe('Rename codex-kirin');
    expect(must(document.querySelector('[data-runtime-dialog-scrim]'), 'the scrim').getAttribute('aria-label')).toBe(
      'Close without renaming',
    );
    const input = must(dialog.querySelector<HTMLInputElement>('[data-runtime-rename-input]'), 'the name field');
    expect(input.value).toBe('codex-kirin');
    expect(text(dialog, '[data-runtime-rename-notes]')).toContain('nothing restarts');
    expect(text(dialog, '[data-runtime-rename-notes]')).toContain('--agent codex-kirin still works');
    expect(text(dialog, '[data-change-submit]')).toBe('Rename');
    expect(text(dialog, '[data-runtime-dialog-cancel]')).toBe('Cancel');
    await click(must(dialog.querySelector('[data-runtime-dialog-cancel]'), 'Cancel'));
    expect(document.querySelector('[data-runtime-dialog]')).toBeNull();

    // S-0199: Remove lists the ferrets running on the runtime and offers to move them first.
    await click(must(root.querySelector('[data-runtime-card="codex-kirin"] [data-runtime-actions]'), 'the ⋯ button'));
    await click(must(document.querySelector('[role="menu"] [data-menu-key="remove"]'), 'Remove in the menu'));
    await settleUntil(
      () => document.querySelector('[data-runtime-remove-impact]') !== null,
      () => `the remove dialog read what runs; drew: ${document.body.textContent ?? ''}`,
      interact,
    );
    const removal = must(document.querySelector('[data-runtime-dialog="remove"]'), 'the remove dialog');
    expect(text(removal, 'h2')).toBe('Remove codex-kirin?');
    expect(text(removal, '[data-runtime-remove-impact]')).toContain('2 ferrets are running on it.');
    expect([...removal.querySelectorAll('[data-runtime-running] li')].map(row => row.textContent)).toEqual([
      'Fisher' + 'Claude Code',
      'Otter' + 'Claude Code',
    ]);
    const target = must(removal.querySelector<HTMLSelectElement>('[data-runtime-move-target]'), 'the move target');
    expect([...target.options].map(option => option.value)).toEqual([
      '',
      'claude-default',
      'claude-work',
      'claude-plain',
    ]);
    expect(text(removal, '[data-runtime-dialog-cancel]')).toBe('Cancel');
    expect(must(removal.querySelector('[data-change-submit]'), 'the Remove button').textContent).toContain('Remove');
  });
});

describe('a runtime page on the Runtimes tab', () => {
  it('S-0209 S-0221 a runtime page draws its sections: credential, profile, model set, fixed layer and Launch', async () => {
    const root = await drawTab(
      daemon(RUNTIMES.runtimes),
      '[data-runtime-page]',
      '#machines/studio-mac/runtimes/claude-agent',
    );

    // S-0209: the page itself, its name, back link, actions and Launch.
    const page = must(root.querySelector('[data-runtime-page="claude-agent"]'), 'the runtime page');
    expect(text(page, 'h3')).toBe('claude-agent');
    expect(text(page, '[data-page-back]')).toBe('Runtimes');
    expect(page.textContent).toContain('Agent runtime');
    expect(page.querySelector('[data-runtime-rename="claude-agent"]')).not.toBeNull();
    expect(page.querySelector('[data-runtime-remove="claude-agent"]')).not.toBeNull();
    expect(page.querySelector('[data-runtimes-tab]')).toBeNull();
    expect(must(page.querySelector('[data-runtime-launch]'), 'Launch').getAttribute('href')).toBe(
      '/d/d1/new?agent=claude-agent',
    );
    expect(
      must(page.querySelector('[data-runtime-credential]'), 'the credential').getAttribute('data-runtime-credential'),
    ).toBe('claude-personal');
    expect(page.querySelector('[data-runtime-profile="Agent work"]')).not.toBeNull();

    // S-0221: the section headings the page is built from.
    const headings = [...page.querySelectorAll('section h4')].map(heading => heading.textContent?.trim());
    expect(headings.slice(-4)).toEqual(['Credential', 'Profile', 'Model set', 'Fixed layer']);
    expect(text(page, '[data-runtime-fixed-layer]')).toContain('permissions.defaultMode = auto');
  });
});

describe('the runtime picker above the composer', () => {
  it('S-0207 the runtime-picker panel draws the model choices as a menu with the current one checked, focused first, and moved by the arrow keys, Home, End and Enter', async () => {
    expect(manifest.ui?.panels?.find(entry => entry.id === 'runtime-picker')?.slot).toBe('composer.tools');
    const catalog = {
      harness: 'claude-code',
      source: 'wrapper-inventory',
      choices: [
        { value: 'claude-opus-5', label: 'Opus 5', description: 'The big one', isDefault: true, reasoningEfforts: [] },
        { value: 'claude-sonnet-5', label: 'Sonnet 5', reasoningEfforts: [] },
        { value: 'claude-haiku-5', label: 'Haiku 5', reasoningEfforts: [] },
      ],
    };
    const ferret = {
      config: { id: 's-1', harness: 'claude-code', model: 'claude-sonnet-5' },
      state: { status: 'running', promptReady: true },
    };
    const calls: Call[] = [];
    const client = scripted(
      {
        'GET /v1/ferrets/:ferretId': ferret,
        'GET /v1/ferrets/:id/runtime-models': catalog,
        'POST /v1/ferrets/:id/runtime': {},
      },
      calls,
    ) as unknown as PluginClient;
    await at('/d/d1/chat/s-1');
    const half = app.build?.({ manifest, client });
    const root = await draw<PanelProps>(
      half?.panels['runtime-picker'],
      { subject: 's-1' } as PanelProps,
      node => node.querySelector('[role="menu"]') !== null,
      'the runtime picker menu',
    );
    expect(root.querySelector('[data-runtime-picker="s-1"]')).not.toBeNull();
    const menu = must(root.querySelector('[role="menu"]'), 'the model menu');
    expect(menu.getAttribute('aria-label')).toBe('Switch claude-code model in place');
    const choices = [...menu.querySelectorAll<HTMLElement>('[role="menuitemradio"]')];
    expect(choices.map(choice => choice.getAttribute('aria-label'))).toEqual([
      'Switch model in place to Opus 5',
      'Switch model in place to Sonnet 5, current',
      'Switch model in place to Haiku 5',
    ]);
    expect(choices.map(choice => choice.getAttribute('aria-checked'))).toEqual(['false', 'true', 'false']);
    expect(choices[0]?.textContent).toContain('The big one');

    // The keyboard contract: focus lands on the current value, the tab stop roves with focus, arrows and Home/End
    // only move focus (never choose), and Enter chooses.
    const labelOf = (element: Element | null) => element?.getAttribute('aria-label');
    expect(choices.map(choice => choice.getAttribute('tabindex'))).toEqual(['-1', '0', '-1']);
    expect(labelOf(document.activeElement)).toBe(labelOf(choices[1] ?? null));
    const press = async (key: string) => {
      await interact(() => {
        document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
      });
    };
    await press('ArrowDown');
    expect(document.activeElement).toBe(choices[2] ?? null);
    expect(choices.map(choice => choice.getAttribute('tabindex'))).toEqual(['-1', '-1', '0']);
    await press('ArrowDown');
    expect(document.activeElement).toBe(choices[0] ?? null);
    await press('ArrowUp');
    expect(document.activeElement).toBe(choices[2] ?? null);
    await press('Home');
    expect(document.activeElement).toBe(choices[0] ?? null);
    await press('End');
    expect(document.activeElement).toBe(choices[2] ?? null);
    expect(calls.some(call => call.route === 'POST /v1/ferrets/:id/runtime')).toBe(false);
    await press('Home');
    await press('Enter');
    await settle();
    const switches = calls.filter(call => call.route === 'POST /v1/ferrets/:id/runtime');
    expect(switches).toHaveLength(1);
    expect(JSON.stringify(switches[0]?.body)).toContain('claude-opus-5');
  });
});

// ---- the Profiles and Model sets tabs ----

let profilesView: Mounted | null = null;

beforeEach(() => window.history.replaceState(null, '', TAB_PATH));
afterEach(async () => {
  await profilesView?.unmount();
  profilesView = null;
  window.history.replaceState(null, '', '/');
});

/** What the daemon answers for a profile's contents: nothing overridden. */
const preview = (): ProfileDraftView => ({
  harnesses: [stack('claude-code'), stack('codex')],
  scope: { kind: 'scoped', scope: 'claude-code' },
  resolved: [],
});

/** The scripted machine, with the draft preview a profile's page asks for. */
const studio = (overrides: Partial<Machine> = {}): Machine => scriptedMachine({ preview: preview(), ...overrides });

/** Builds the half over `machine`, as the shell does, and draws one of its Settings tabs until `ready` holds. */
const drawProfilesTab = async (
  tab: 'profiles' | 'model-sets',
  machine: Machine,
  ready: string,
): Promise<HTMLElement> => {
  const client = { ...machineClient(machine), subscribe: () => () => undefined } as unknown as PluginClient;
  const half = app.build?.({ manifest, client });
  const element = createElement(
    Suspense,
    { fallback: null },
    createElement(half?.settings[tab] as FunctionComponent<SettingsProps>, {}),
  );
  profilesView = await mount(element);
  const root = profilesView.container;
  await settleUntil(
    () => root.querySelector(ready) !== null,
    () => `the ${tab} tab drew ${ready}; drew: ${root.textContent ?? ''}`,
    interact,
  );
  return root;
};

const q = (root: ParentNode, selector: string): HTMLElement =>
  must(root.querySelector<HTMLElement>(selector), selector);

describe('the Profiles tab', () => {
  it('S-0529 S-0182 S-0140 the Profiles tab is declared in Settings, and its list leads with its heading, a New profile button and a row per profile with its scope and use', async () => {
    expect(manifest.ui?.settings?.find(tab => tab.id === 'profiles')).toMatchObject({
      id: 'profiles',
      label: 'Profiles',
    });
    const root = await drawProfilesTab('profiles', studio(), '[data-profile-row]');
    // S-0529 and S-0182: the tab, the profiles page on its list.
    expect(q(root, '[data-profiles-page]').getAttribute('data-profiles-page')).toBe('list');
    // S-0140: the list's heading, count, New profile button and one row per profile.
    expect(text(root, 'h3')).toBe('Profiles');
    expect(root.textContent).toContain('3 profiles');
    expect(text(root, '[data-profile-new]')).toBe('+ New profile');
    expect([...root.querySelectorAll('[data-profile-row]')].map(row => row.getAttribute('data-profile-row'))).toEqual([
      'Agent work',
      'Default',
      'Review',
    ]);
    expect(text(root, '[data-profile-row="Default"] [data-component-badges]')).toBe('Claude only');
    expect(text(root, '[data-profile-row="Default"]')).toContain('4 items · 4 parts · used by 3 runtimes');
  });

  it('S-0140 the Profiles list says there are none yet on an empty machine, and offers a New profile that opens the editor', async () => {
    const machine = studio({ catalog: studioCatalog({ profiles: profileCatalog([]), runtimes: runtimeCatalog([]) }) });
    const root = await drawProfilesTab('profiles', machine, '[data-profiles-empty]');
    expect(text(root, '[data-profiles-empty] h3')).toBe('No profiles yet');
    expect(root.textContent).toContain('A profile is a bag of components');
    await clickSelector(root, '[data-profile-new]');
    expect(q(root, '[data-profiles-page]').getAttribute('data-profiles-page')).toBe('new');
    expect(text(root, 'h3')).toBe('New profile');
  });

  it('S-0090 S-0136 a profile opens to its page: its name, contents, where it is used, a Delete profile button and the component library beside its contents', async () => {
    const root = await drawProfilesTab('profiles', studio(), '[data-profile-row="Default"]');
    await clickSelector(root, '[data-profile-row="Default"]');
    expect(q(root, '[data-profiles-page]').getAttribute('data-profiles-page')).toBe('detail');
    expect(text(root, 'h3')).toBe('Default');
    expect([...root.querySelectorAll('[data-profile-item]')].map(row => row.getAttribute('data-profile-item'))).toEqual(
      ['instructions/Main instructions', 'mcp/github', 'settings/Claude settings', 'modelSets/Claude models'],
    );
    expect(root.textContent).toContain('Where it is used');
    expect(text(root, '[data-profile-includer="Agent work"]')).toContain('Contains Default');
    expect(text(root, '[data-profile-includer="Review"]')).toContain('Contains Default');
    expect(text(root, '[data-profile-delete]')).toBe('Delete profile…');
    // S-0136: the component library beside the contents, with Add on what is not in the profile.
    const library = q(root, '[data-profile-library]');
    expect(library.getAttribute('aria-label')).toBe('Component library');
    expect(text(library, 'h4')).toBe('Library');
    expect(library.querySelector('[data-library-search]')).not.toBeNull();
    expect(library.querySelector('[data-library-kind]')).not.toBeNull();
    // What the profile already holds says so; what it does not hold offers Add.
    expect(text(library, '[data-library-add="mcp/github"]')).toBe('In profile');
    expect(text(library, '[data-library-add="mcp/notes"]')).toBe('Add');
    expect(library.textContent).toContain('Drag into the profile, or drag a profile item back here to remove it.');
    // Back is the way to the list.
    await clickSelector(root, '[data-catalog-back]');
    expect(q(root, '[data-profiles-page]').getAttribute('data-profiles-page')).toBe('list');
  });

  it('S-0087 Delete profile opens the delete panel for a profile nothing uses, with its confirm button and Keep it', async () => {
    const machine = studio({
      catalog: studioCatalog({
        profiles: profileCatalog([profile('Unused', ['mcp/github'])]),
        runtimes: runtimeCatalog([]),
      }),
    });
    const root = await drawProfilesTab('profiles', machine, '[data-profile-row="Unused"]');
    await clickSelector(root, '[data-profile-row="Unused"]');
    expect(root.querySelector('[data-catalog-note="delete"]')).toBeNull();
    await clickSelector(root, '[data-profile-delete]');
    const panel = q(root, '[data-catalog-note="delete"]');
    expect(panel.textContent).toContain('Delete Unused?');
    expect(panel.textContent).toContain('Nothing uses it now. Its components stay saved. This can’t be undone.');
    expect(text(panel, '[data-change-submit]')).toBe('Delete Unused');
    expect(text(panel, '[data-profile-keep]')).toBe('Keep it');
    await clickSelector(root, '[data-profile-keep]');
    expect(root.querySelector('[data-catalog-note="delete"]')).toBeNull();
    expect(root.querySelector('[data-profile-delete]')).not.toBeNull();
  });

  it('S-0087 the delete panel for a profile another profile contains is blocked, naming who has it and offering Remove from those first', async () => {
    const root = await drawProfilesTab('profiles', studio(), '[data-profile-row="Default"]');
    await clickSelector(root, '[data-profile-row="Default"]');
    await clickSelector(root, '[data-profile-delete]');
    const panel = q(root, '[data-catalog-note="delete"]');
    expect(panel.textContent).toContain('Default is in use, so it can’t be deleted');
    expect(panel.textContent).toContain(
      'It is inside Agent work and Review, and these runtimes use it: claude-default.',
    );
    expect(text(panel, '[data-profile-detach]')).toBe('Remove from those first');
    expect(text(panel, '[data-profile-keep]')).toBe('Keep it');
    expect(panel.querySelector('[data-change-submit]')).toBeNull();
  });
});

/** A model set the profiles and runtimes reach, as the daemon would say it. */
const used = (overrides: Partial<ComponentView> = {}): ComponentView =>
  component({
    ...models,
    usedBy: { profiles: ['Default', 'Review'], runtimes: ['claude-default', 'claude-review'] },
    ...overrides,
  });

/** The catalogue with exactly these model sets. */
const withModelSets = (...sets: ComponentView[]) =>
  studioCatalog({
    components: ComponentCatalogSchema.parse({
      format: 'present',
      kinds: componentCatalog().kinds.map(group =>
        group.kind === 'modelSets' ? { ...group, components: sets } : group,
      ),
    }),
  });

/** A model set no profile has as a layer, so it can be deleted without a block. */
const spare = component({ ...models, reference: 'modelSets/Spare', name: 'Spare' });

describe('the Model sets tab', () => {
  it('S-0063 S-0139 the Model sets tab is declared in Settings, and its list leads with its heading, a New model set button and a row per set with its use', async () => {
    expect(manifest.ui?.settings?.find(tab => tab.id === 'model-sets')).toMatchObject({
      id: 'model-sets',
      label: 'Model sets',
    });
    const root = await drawProfilesTab(
      'model-sets',
      studio({ catalog: withModelSets(used()) }),
      '[data-component-row]',
    );
    // S-0063: the tab, the model sets page on its list.
    expect(q(root, '[data-model-sets-tab]').getAttribute('data-components-page')).toBe('list');
    // S-0139: the list's heading, description, New model set button and a row per set with its use.
    expect(text(root, 'h3')).toBe('Model sets');
    expect(root.textContent).toContain('Model sets description.');
    expect(text(root, '[data-component-new="modelSets"]')).toBe('+ New model set');
    expect(root.querySelectorAll('[data-component-row]')).toHaveLength(1);
    expect(text(root, '[data-component-row="modelSets/Claude models"]')).toContain('Claude models');
    expect(text(root, '[data-component-row="modelSets/Claude models"]')).toContain('Used by 2 profiles, 2 runtimes');
    // Only model sets live here: no other kind is listed.
    expect(root.textContent).not.toContain('Main instructions');
  });

  it('S-0139 the Model sets list says none are saved yet when the machine has no model set, and still offers New model set', async () => {
    const root = await drawProfilesTab('model-sets', studio({ catalog: withModelSets() }), '[data-model-sets-tab]');
    expect(text(root, 'h3')).toBe('Model sets');
    expect(root.textContent).toContain('None saved yet.');
    expect(root.querySelector('[data-component-row]')).toBeNull();
    expect(text(root, '[data-component-new="modelSets"]')).toBe('+ New model set');
  });

  it('S-0089 a model set opens to its page: its name, badges, models with the default marked, who uses it, Edit and Delete', async () => {
    const root = await drawProfilesTab(
      'model-sets',
      studio({ catalog: withModelSets(used()) }),
      '[data-component-row]',
    );
    await clickSelector(root, '[data-component-row="modelSets/Claude models"]');
    expect(q(root, '[data-model-sets-tab]').getAttribute('data-components-page')).toBe('detail');
    expect(text(root, 'h3')).toBe('Claude models');
    expect(root.textContent).toContain('Content');
    expect(root.textContent).toContain('claude-opus-5');
    expect(root.textContent).toContain('claude-sonnet-5Default');
    expect(root.textContent).toContain('Used by 2 profiles and 2 runtimes.');
    expect(q(root, '[data-catalog-link]').getAttribute('href')).toBe(
      '/d/d1/settings/runtimes/profiles#machines/studio-mac/profiles/Default',
    );
    expect(text(root, '[data-component-edit]')).toBe('Edit');
    expect(text(root, '[data-component-delete]')).toBe('Delete…');
    await clickSelector(root, '[data-catalog-back]');
    expect(q(root, '[data-model-sets-tab]').getAttribute('data-components-page')).toBe('list');
  });

  it('S-0086 Delete opens the delete panel for a model set nothing uses, with its confirm button and Keep it', async () => {
    const root = await drawProfilesTab('model-sets', studio({ catalog: withModelSets(spare) }), '[data-component-row]');
    await clickSelector(root, '[data-component-row="modelSets/Spare"]');
    expect(root.querySelector('[data-catalog-note="delete"]')).toBeNull();
    await clickSelector(root, '[data-component-delete]');
    const panel = q(root, '[data-catalog-note="delete"]');
    expect(panel.textContent).toContain('Delete Spare?');
    expect(panel.textContent).toContain('Nothing uses it now. This can’t be undone.');
    expect(text(panel, '[data-change-submit]')).toBe('Delete Spare');
    expect(text(panel, '[data-component-keep]')).toBe('Keep it');
    await clickSelector(root, '[data-component-keep]');
    expect(root.querySelector('[data-catalog-note="delete"]')).toBeNull();
  });

  it('S-0086 the delete panel for a model set a profile has as a layer is blocked, naming the profiles and offering Remove from those first', async () => {
    const root = await drawProfilesTab(
      'model-sets',
      studio({ catalog: withModelSets(used()) }),
      '[data-component-row]',
    );
    await clickSelector(root, '[data-component-row="modelSets/Claude models"]');
    await clickSelector(root, '[data-component-delete]');
    const panel = q(root, '[data-catalog-note="delete"]');
    expect(panel.textContent).toContain('Claude models is in use, so it can’t be deleted');
    expect(panel.textContent).toContain('Profile · Default');
    expect(panel.textContent).toContain('Through those, 2 runtimes use it: claude-default, claude-review.');
    expect(text(panel, '[data-component-detach]')).toBe('Remove from those first');
    expect(text(panel, '[data-component-keep]')).toBe('Keep it');
    expect(panel.querySelector('[data-change-submit]')).toBeNull();
  });

  it('S-0105 New model set opens the form page: a name, the models to list, Save held until it is valid, and Cancel', async () => {
    const root = await drawProfilesTab('model-sets', studio(), '[data-component-new="modelSets"]');
    await clickSelector(root, '[data-component-new="modelSets"]');
    expect(q(root, '[data-model-sets-tab]').getAttribute('data-components-page')).toBe('new');
    expect(text(root, 'h3')).toBe('New model set');
    expect(q(root, '[data-component-field="name"]')).toBeInstanceOf(HTMLInputElement);
    expect(q(root, '[data-component-field="body"]')).toBeInstanceOf(HTMLTextAreaElement);
    expect(text(root, '[data-change-submit]')).toBe('Save');
    expect(q(root, '[data-change-submit]').hasAttribute('disabled')).toBe(true);
    expect(text(root, '[data-component-cancel]')).toBe('Cancel');
    await clickSelector(root, '[data-component-cancel]');
    expect(q(root, '[data-model-sets-tab]').getAttribute('data-components-page')).toBe('list');
  });

  it('S-0105 Edit opens the form page of a model set: its name kept, its models filled in, and Save for all where several use it', async () => {
    const wide = used({ usedBy: { profiles: ['A', 'B', 'C'], runtimes: ['x', 'y', 'z'] } });
    const root = await drawProfilesTab('model-sets', studio({ catalog: withModelSets(wide) }), '[data-component-row]');
    await clickSelector(root, '[data-component-row="modelSets/Claude models"]');
    await clickSelector(root, '[data-component-edit]');
    expect(q(root, '[data-model-sets-tab]').getAttribute('data-components-page')).toBe('edit');
    expect(text(root, 'h3')).toBe('Edit Claude models');
    expect(q(root, '[data-component-field="name"]').hasAttribute('disabled')).toBe(true);
    expect(q(root, '[data-component-field="body"]').textContent).toBe('claude-opus-5\nclaude-sonnet-5');
    expect(text(root, '[data-catalog-note="used"]')).toContain('Used by 3 profiles and 3 runtimes');
    expect(text(root, '[data-change-submit]')).toBe('Save for all');
    await clickSelector(root, '[data-component-cancel]');
    expect(text(root, 'h3')).toBe('Claude models');
  });
});

describe('the machine-setup views the half builds (the first run’s steps and Export settings)', () => {
  it('S-0024 Agent controls draws the five switches and the default runtime, and Save appears once one is flipped', async () => {
    await at('/d/d1/onboarding/steps');
    const half = app.build?.({ manifest, client: daemon(LISTED) });
    const root = await draw<PanelProps>(
      half?.panels['onboarding-controls'],
      { subject: 'runtimes.controls' } as PanelProps,
      r => r.querySelector('[data-default-runtime]') !== null,
      'the Agent controls step drew its switches and the default runtime',
    );
    expect(root.querySelectorAll('[data-switch-row]').length).toBe(5);
    expect(text(root, '[data-setup-section="agent-control"] h4')).toBe('What agents may control');
    expect(root.querySelector('[data-change-submit]')).toBeNull();
    const ferretry = must(
      root.querySelector('[data-switch-row="Ferretry settings"] [role="switch"]'),
      'the Ferretry settings switch',
    );
    expect(ferretry.getAttribute('aria-checked')).toBe('false');
    await click(ferretry);
    expect(ferretry.getAttribute('aria-checked')).toBe('true');
    expect(text(root, '[data-change-submit]')).toBe('Save what agents may control');
    // The step draws only for its own subject.
    await view?.unmount();
    view = null;
    const other = await draw<PanelProps>(
      half?.panels['onboarding-controls'],
      { subject: 'runtimes.start' } as PanelProps,
      () => true,
      'a step that is not its own draws nothing',
    );
    expect(other.querySelector('[data-onboarding-step-body]')).toBeNull();
  });

  it('S-0101 Export settings reads the files one by one, carries the valid ones and names the one it left out', async () => {
    const saved: string[] = [];
    const real = { create: URL.createObjectURL, revoke: URL.revokeObjectURL };
    URL.createObjectURL = (blob: Blob | MediaSource) => {
      saved.push(String((blob as Blob).size));
      return 'blob:setup-export';
    };
    URL.revokeObjectURL = () => undefined;
    try {
      await at('/d/d1/settings/runtimes/transfer');
      const half = app.build?.({
        manifest,
        client: daemon(LISTED, {
          'GET /v1/config/status': {
            files: [
              { path: 'warden.yaml', state: 'ok' },
              { path: 'logins/work.yaml', state: 'invalid' },
            ],
          },
          'GET /v1/config/file': (call: Call) => ({
            path: call.query?.['path'],
            exists: true,
            text: `# ${call.query?.['path']}\n`,
            etag: 'e',
            issues: [],
          }),
        }),
      });
      const root = await draw<SettingsProps>(
        half?.settings['transfer'],
        {},
        r => r.querySelector('[data-export-run]') !== null,
        'the Export & copy tab drew Export settings',
      );
      expect(text(root, '#export-settings-heading')).toBe('Export settings');
      await click(must(root.querySelector('[data-export-run]'), 'the Export settings button'));
      await settleUntil(
        () => root.querySelector('[data-setup-section="export-manifest"]') !== null,
        () => `the export ran; drew: ${root.textContent ?? ''}`,
        interact,
      );
      const listing = text(root, '[data-setup-section="export-manifest"]');
      expect(listing).toContain('config/warden.yaml');
      expect(listing).toContain('secrets: none');
      expect(listing).not.toContain('logins/work.yaml');
      expect(text(root, '[data-setup-note="export-left-out"]')).toContain('logins/work.yaml');
      expect(saved.length).toBe(1);
    } finally {
      URL.createObjectURL = real.create;
      URL.revokeObjectURL = real.revoke;
    }
  });

  it('Copy settings from another machine asks to pair one first when this browser has no other machine', async () => {
    await at('/d/d1/settings/runtimes/transfer');
    const half = app.build?.({ manifest, client: daemon(LISTED) });
    const root = await draw<SettingsProps>(
      half?.settings['transfer'],
      {},
      r => r.querySelector('[data-copy-source]') !== null,
      'the Export & copy tab drew the Copy source step',
    );
    expect(text(root, '[data-copy-no-sources]')).toContain('Pair another machine first');
    expect(must(root.querySelector('[data-copy-read]'), 'the Review button').hasAttribute('disabled')).toBe(true);
  });
});
