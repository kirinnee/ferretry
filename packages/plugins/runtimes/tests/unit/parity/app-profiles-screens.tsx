/**
 * Runtimes' Profiles and Model sets Settings tabs, parity with today's Profiles and Components surfaces
 * (docs/design/rebuild-parity.tsv, owner `runtimes`, kind S).
 *
 * Each surface is proved by drawing it: the half the shell builds is mounted (every tab lazy behind a Suspense
 * boundary, as the shell mounts it) over a scripted machine, and the test reads what it drew. A page behind an action
 * (a profile's page, the delete panel, a model set's form) is opened by clicking to it. The tabs' own behaviour is in
 * the suites under `tests/unit/app/features/fleet/`.
 *
 * Today's Components tab drew six kinds behind a kinds page; Runtimes draws only the model sets, straight to their
 * list, so the model set screens stand in for today's component screens here.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { interact, type Mounted, mount, must, settleUntil } from '@ferretry/app/testing';
import type { PluginClient, SettingsProps } from '@ferretry/kernel/manifest';
import { createElement, type FunctionComponent, Suspense } from 'react';
import app from '../../../app/index.ts';
import { type ComponentView, ComponentCatalogSchema, type ProfileDraftView } from '../../../contract/index.ts';
import manifest from '../../../manifest.ts';
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
  click,
  type Machine,
  machineClient,
  scriptedMachine,
  TAB_PATH,
  text,
} from '../app/features/fleet/components/view-support.tsx';

let view: Mounted | null = null;

beforeEach(() => window.history.replaceState(null, '', TAB_PATH));
afterEach(async () => {
  await view?.unmount();
  view = null;
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
const draw = async (tab: 'profiles' | 'model-sets', machine: Machine, ready: string): Promise<HTMLElement> => {
  const client = { ...machineClient(machine), subscribe: () => () => undefined } as unknown as PluginClient;
  const half = app.build?.({ manifest, client });
  const element = createElement(
    Suspense,
    { fallback: null },
    createElement(half?.settings[tab] as FunctionComponent<SettingsProps>, {}),
  );
  view = await mount(element);
  const root = view.container;
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
  it('S-0529 S-0181 S-0182 the Profiles tab is declared in Settings, and draws the machine host around the profiles page', async () => {
    expect(manifest.ui?.settings?.find(tab => tab.id === 'profiles')).toMatchObject({
      id: 'profiles',
      label: 'Profiles',
    });
    const root = await draw('profiles', studio(), '[data-profiles-page]');
    // The surface: the machine host the tab sits in, and the tab inside it.
    const host = q(root, '[data-machine-settings]');
    expect(host.querySelector('[data-profiles-page]')).not.toBeNull();
    // The tab: the profiles page, on its list.
    expect(q(root, '[data-profiles-page]').getAttribute('data-profiles-page')).toBe('list');
    expect(text(root, 'h3')).toBe('Profiles');
  });

  it('S-0140 the Profiles list leads with its heading, a New profile button and a row per profile with its scope and use', async () => {
    const root = await draw('profiles', studio(), '[data-profile-row]');
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
    const root = await draw('profiles', machine, '[data-profiles-empty]');
    expect(text(root, '[data-profiles-empty] h3')).toBe('No profiles yet');
    expect(root.textContent).toContain('A profile is a bag of components');
    await click(root, '[data-profile-new]');
    expect(q(root, '[data-profiles-page]').getAttribute('data-profiles-page')).toBe('new');
    expect(text(root, 'h3')).toBe('New profile');
  });

  it('S-0090 a profile opens to its page: its name, contents, where it is used and a Delete profile button', async () => {
    const root = await draw('profiles', studio(), '[data-profile-row="Default"]');
    await click(root, '[data-profile-row="Default"]');
    expect(q(root, '[data-profiles-page]').getAttribute('data-profiles-page')).toBe('detail');
    expect(text(root, 'h3')).toBe('Default');
    expect([...root.querySelectorAll('[data-profile-item]')].map(row => row.getAttribute('data-profile-item'))).toEqual(
      ['instructions/Main instructions', 'mcp/github', 'settings/Claude settings', 'modelSets/Claude models'],
    );
    expect(root.textContent).toContain('Where it is used');
    expect(text(root, '[data-profile-includer="Agent work"]')).toContain('Contains Default');
    expect(text(root, '[data-profile-includer="Review"]')).toContain('Contains Default');
    expect(text(root, '[data-profile-delete]')).toBe('Delete profile…');
    // Back is the way to the list.
    await click(root, '[data-catalog-back]');
    expect(q(root, '[data-profiles-page]').getAttribute('data-profiles-page')).toBe('list');
  });

  it('S-0136 a profile’s page draws the component library beside its contents, with Add on what is not in the profile', async () => {
    const root = await draw('profiles', studio(), '[data-profile-row="Default"]');
    await click(root, '[data-profile-row="Default"]');
    const library = q(root, '[data-profile-library]');
    expect(library.getAttribute('aria-label')).toBe('Component library');
    expect(text(library, 'h4')).toBe('Library');
    expect(library.querySelector('[data-library-search]')).not.toBeNull();
    expect(library.querySelector('[data-library-kind]')).not.toBeNull();
    // What the profile already holds says so; what it does not hold offers Add.
    expect(text(library, '[data-library-add="mcp/github"]')).toBe('In profile');
    expect(text(library, '[data-library-add="mcp/notes"]')).toBe('Add');
    expect(library.textContent).toContain('Drag into the profile, or drag a profile item back here to remove it.');
  });

  it('S-0087 Delete profile opens the delete panel for a profile nothing uses, with its confirm button and Keep it', async () => {
    const machine = studio({
      catalog: studioCatalog({
        profiles: profileCatalog([profile('Unused', ['mcp/github'])]),
        runtimes: runtimeCatalog([]),
      }),
    });
    const root = await draw('profiles', machine, '[data-profile-row="Unused"]');
    await click(root, '[data-profile-row="Unused"]');
    expect(root.querySelector('[data-catalog-note="delete"]')).toBeNull();
    await click(root, '[data-profile-delete]');
    const panel = q(root, '[data-catalog-note="delete"]');
    expect(panel.textContent).toContain('Delete Unused?');
    expect(panel.textContent).toContain('Nothing uses it now. Its components stay saved. This can’t be undone.');
    expect(text(panel, '[data-change-submit]')).toBe('Delete Unused');
    expect(text(panel, '[data-profile-keep]')).toBe('Keep it');
    await click(root, '[data-profile-keep]');
    expect(root.querySelector('[data-catalog-note="delete"]')).toBeNull();
    expect(root.querySelector('[data-profile-delete]')).not.toBeNull();
  });

  it('S-0087 the delete panel for a profile another profile contains is blocked, naming who has it and offering Remove from those first', async () => {
    const root = await draw('profiles', studio(), '[data-profile-row="Default"]');
    await click(root, '[data-profile-row="Default"]');
    await click(root, '[data-profile-delete]');
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
  it('S-0062 S-0063 the Model sets tab is declared in Settings, and draws the machine host around the model sets page', async () => {
    expect(manifest.ui?.settings?.find(tab => tab.id === 'model-sets')).toMatchObject({
      id: 'model-sets',
      label: 'Model sets',
    });
    const root = await draw('model-sets', studio(), '[data-model-sets-tab]');
    // The surface: the machine host the tab sits in, and the tab inside it.
    expect(q(root, '[data-machine-settings]').querySelector('[data-model-sets-tab]')).not.toBeNull();
    // The tab: the model sets page, on its list.
    expect(q(root, '[data-model-sets-tab]').getAttribute('data-components-page')).toBe('list');
    expect(text(root, 'h3')).toBe('Model sets');
  });

  it('S-0139 the Model sets list leads with its heading, a New model set button and a row per set with its use', async () => {
    const root = await draw('model-sets', studio({ catalog: withModelSets(used()) }), '[data-component-row]');
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
    const root = await draw('model-sets', studio({ catalog: withModelSets() }), '[data-model-sets-tab]');
    expect(text(root, 'h3')).toBe('Model sets');
    expect(root.textContent).toContain('None saved yet.');
    expect(root.querySelector('[data-component-row]')).toBeNull();
    expect(text(root, '[data-component-new="modelSets"]')).toBe('+ New model set');
  });

  it('S-0089 a model set opens to its page: its name, badges, models with the default marked, who uses it, Edit and Delete', async () => {
    const root = await draw('model-sets', studio({ catalog: withModelSets(used()) }), '[data-component-row]');
    await click(root, '[data-component-row="modelSets/Claude models"]');
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
    await click(root, '[data-catalog-back]');
    expect(q(root, '[data-model-sets-tab]').getAttribute('data-components-page')).toBe('list');
  });

  it('S-0086 Delete opens the delete panel for a model set nothing uses, with its confirm button and Keep it', async () => {
    const root = await draw('model-sets', studio({ catalog: withModelSets(spare) }), '[data-component-row]');
    await click(root, '[data-component-row="modelSets/Spare"]');
    expect(root.querySelector('[data-catalog-note="delete"]')).toBeNull();
    await click(root, '[data-component-delete]');
    const panel = q(root, '[data-catalog-note="delete"]');
    expect(panel.textContent).toContain('Delete Spare?');
    expect(panel.textContent).toContain('Nothing uses it now. This can’t be undone.');
    expect(text(panel, '[data-change-submit]')).toBe('Delete Spare');
    expect(text(panel, '[data-component-keep]')).toBe('Keep it');
    await click(root, '[data-component-keep]');
    expect(root.querySelector('[data-catalog-note="delete"]')).toBeNull();
  });

  it('S-0086 the delete panel for a model set a profile has as a layer is blocked, naming the profiles and offering Remove from those first', async () => {
    const root = await draw('model-sets', studio({ catalog: withModelSets(used()) }), '[data-component-row]');
    await click(root, '[data-component-row="modelSets/Claude models"]');
    await click(root, '[data-component-delete]');
    const panel = q(root, '[data-catalog-note="delete"]');
    expect(panel.textContent).toContain('Claude models is in use, so it can’t be deleted');
    expect(panel.textContent).toContain('Profile · Default');
    expect(panel.textContent).toContain('Through those, 2 runtimes use it: claude-default, claude-review.');
    expect(text(panel, '[data-component-detach]')).toBe('Remove from those first');
    expect(text(panel, '[data-component-keep]')).toBe('Keep it');
    expect(panel.querySelector('[data-change-submit]')).toBeNull();
  });

  it('S-0105 New model set opens the form page: a name, the models to list, Save held until it is valid, and Cancel', async () => {
    const root = await draw('model-sets', studio(), '[data-component-new="modelSets"]');
    await click(root, '[data-component-new="modelSets"]');
    expect(q(root, '[data-model-sets-tab]').getAttribute('data-components-page')).toBe('new');
    expect(text(root, 'h3')).toBe('New model set');
    expect(q(root, '[data-component-field="name"]')).toBeInstanceOf(HTMLInputElement);
    expect(q(root, '[data-component-field="body"]')).toBeInstanceOf(HTMLTextAreaElement);
    expect(text(root, '[data-change-submit]')).toBe('Save');
    expect(q(root, '[data-change-submit]').hasAttribute('disabled')).toBe(true);
    expect(text(root, '[data-component-cancel]')).toBe('Cancel');
    await click(root, '[data-component-cancel]');
    expect(q(root, '[data-model-sets-tab]').getAttribute('data-components-page')).toBe('list');
  });

  it('S-0105 Edit opens the form page of a model set: its name kept, its models filled in, and Save for all where several use it', async () => {
    const wide = used({ usedBy: { profiles: ['A', 'B', 'C'], runtimes: ['x', 'y', 'z'] } });
    const root = await draw('model-sets', studio({ catalog: withModelSets(wide) }), '[data-component-row]');
    await click(root, '[data-component-row="modelSets/Claude models"]');
    await click(root, '[data-component-edit]');
    expect(q(root, '[data-model-sets-tab]').getAttribute('data-components-page')).toBe('edit');
    expect(text(root, 'h3')).toBe('Edit Claude models');
    expect(q(root, '[data-component-field="name"]').hasAttribute('disabled')).toBe(true);
    expect(q(root, '[data-component-field="body"]').textContent).toBe('claude-opus-5\nclaude-sonnet-5');
    expect(text(root, '[data-catalog-note="used"]')).toContain('Used by 3 profiles and 3 runtimes');
    expect(text(root, '[data-change-submit]')).toBe('Save for all');
    await click(root, '[data-component-cancel]');
    expect(text(root, 'h3')).toBe('Claude models');
  });
});
