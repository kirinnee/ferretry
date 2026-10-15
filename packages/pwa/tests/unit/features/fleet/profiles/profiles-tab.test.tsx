import { afterEach, describe, expect, it } from 'bun:test';
import { ProfilesTab } from '../../../../../src/features/fleet/profiles/profiles-tab.tsx';
import { type Mounted, mount } from '../../../../support/dom.ts';
import {
  CONFLICT,
  component,
  componentCatalog,
  instructions,
  profile,
  profileCatalog,
  runtime,
  runtimeCatalog,
  stack,
  studioCatalog,
} from '../components/catalog-fixture.ts';
import {
  choose,
  click,
  followHash,
  type Machine,
  mountSettled,
  scriptedMachine,
  settle,
  stagedChanges,
  submit,
  tabProps,
  text,
  tick,
  type,
} from '../components/view-support.tsx';

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  window.history.replaceState(null, '', '/');
});

const open = async (machine: Machine = scriptedMachine(), overrides: Parameters<typeof tabProps>[1] = {}) => {
  mounted = await mountSettled(<ProfilesTab {...tabProps(machine, overrides)} />);
  return mounted.container;
};

describe('ProfilesTab — list and page', () => {
  it('lists each profile with its layers, the runtimes it reaches and what builds on it', async () => {
    const root = await open();
    expect(text(root, 'h3')).toBe('Profiles');
    expect(root.textContent).toContain('3 profiles');
    expect(text(root, '[data-profile-row="Default"]')).toContain('4 layers · used by 3 runtimes · base for 2 profiles');
    expect(text(root, '[data-profile-row="Review"]')).toContain('2 layers · used by 1 runtime');
    expect(text(root, '[data-profile-row="Review"]')).not.toContain('base for');
  });

  it('shows the layers newest on top, what is skipped, conflicts and where it is used', async () => {
    const root = await open();
    await click(root, '[data-profile-row="Default"]');
    expect(text(root, 'h3')).toBe('Default');
    expect(root.textContent).toContain('Profile · 4 layers');
    const layers = [...root.querySelectorAll('[data-layer]')].map(layer => layer.getAttribute('data-layer'));
    expect(layers).toEqual([
      'modelSets/Claude models',
      'settings/Claude settings',
      'mcp/github',
      'instructions/Main instructions',
    ]);
    expect(root.textContent).toContain('Newest on top · newer layer wins');
    expect(root.textContent).toContain('is skipped on Codex');
    expect(root.textContent).toContain('No conflicts.');
    expect(root.querySelector('[data-profile-includer="Agent work"]')?.textContent).toContain('Builds on Default');
    const runtimes = [...root.querySelectorAll('[data-catalog-link]')].map(link => link.textContent);
    expect(runtimes).toEqual([
      'claude-agentRuntime · through Agent work',
      'claude-defaultRuntime',
      'claude-reviewRuntime · through Review',
    ]);
    expect(root.querySelector('[data-catalog-link]')?.getAttribute('href')).toBe(
      '#machines/studio-mac/runtimes/claude-agent',
    );
    await click(root, '[data-profile-includer="Agent work"]');
    expect(text(root, 'h3')).toBe('Agent work');
    const conflict = must(root.querySelector('[data-conflicts] li'));
    expect(conflict.querySelector('.font-mono')?.textContent).toBe('permissions.defaultMode');
    expect(conflict.textContent).toBe(CONFLICT.sentence.replaceAll('`', ''));
    expect(text(root, '[data-layer="profile/Default"]')).toContain('Profile · Default4 parts, used as a base');
    await click(root, '[data-catalog-back]');
    expect(root.querySelector('[data-profiles-page="list"]')).not.toBeNull();
  });

  it('says nothing uses a profile, draws an unknown layer as written, and a base it cannot find as no parts', async () => {
    const catalog = studioCatalog({
      profiles: profileCatalog([profile('Lonely', ['profile/Missing', 'widgets/x', 'mcp/unknown'])]),
      runtimes: runtimeCatalog([]),
    });
    const root = await open(scriptedMachine({ catalog }));
    await click(root, '[data-profile-row="Lonely"]');
    expect(root.textContent).toContain('Nothing uses this profile yet.');
    expect(text(root, '[data-layer="widgets/x"]')).toBe('2widgets/x');
    expect(text(root, '[data-layer="profile/Missing"]')).toContain('0 parts, used as a base');
    expect(text(root, '[data-layer="mcp/unknown"]')).toContain('MCP server · unknown');
  });

  it('offers to build the first profile on an empty machine', async () => {
    const root = await open(scriptedMachine({ catalog: studioCatalog({ profiles: profileCatalog([]) }) }));
    expect(root.textContent).toContain('No profiles yet');
    await click(root, '[data-profile-build]');
    expect(root.querySelector('[data-machine-stepper="build-profile"]')).not.toBeNull();
    expect(root.textContent).toContain('No profiles yet. Start from nothing.');
    expect(text(root, '[data-build-next]')).toBe('Next, start from nothing');
  });

  it('shows Reading… first, and why when the read fails', async () => {
    mounted = await mount(
      <ProfilesTab {...tabProps(scriptedMachine(), { createClient: () => new Promise(() => undefined) })} />,
    );
    expect(mounted.container.textContent).toContain('Reading studio-mac’s profiles…');
    await mounted.unmount();
    const root = await open(scriptedMachine({ readFails: new Error('down') }));
    expect(root.textContent).toContain('did not answer');
    expect(root.querySelector('[data-catalog-retry]')).not.toBeNull();
    await click(root, '[data-catalog-retry]');
  });

  it('opens the profile a link names, now and on a hash change', async () => {
    window.history.replaceState(null, '', '/#machines/studio-mac/profiles/Review');
    const root = await open();
    expect(text(root, 'h3')).toBe('Review');
    await followHash('#machines/studio-mac/profiles/Default');
    expect(text(root, 'h3')).toBe('Default');
    await followHash('#machines/studio-mac/profiles/Nope');
    expect(text(root, 'h3')).toBe('Profiles');
  });
});

describe('ProfilesTab — delete (E21)', () => {
  it('is blocked while it is a base; Remove from those first, then switch its runtime and delete', async () => {
    const machine = scriptedMachine();
    const root = await open(machine);
    await click(root, '[data-profile-row="Default"]');
    await click(root, '[data-profile-delete]');
    const blocked = text(root, '[data-catalog-note="delete"]');
    expect(blocked).toContain('Default is in use, so it can’t be deleted');
    expect(blocked).toContain('It is the base of Agent work and Review, and these runtimes use it: claude-default.');
    await click(root, '[data-profile-keep]');
    await click(root, '[data-profile-delete]');
    await click(root, '[data-profile-detach]');
    const moving = text(root, '[data-catalog-note="delete"]');
    expect(moving).toContain('Pick another profile for this runtime first');
    expect(moving).toContain('It is taken out of Agent work and Review first.');
    // Profiles built on it are not offered: they include it.
    expect([...root.querySelectorAll('[data-profile-switch] option')].map(option => option.textContent)).toEqual([]);
    expect(moving).toContain('There is no other profile to move to yet.');
  });

  it('moves the runtimes on it to the profile picked and deletes it', async () => {
    const catalog = studioCatalog({
      profiles: profileCatalog([
        profile('Old', ['mcp/github'], { usedBy: ['a', 'b'] }),
        profile('New', ['mcp/github']),
        profile('Other', ['mcp/github']),
      ]),
      runtimes: runtimeCatalog([runtime('a', 'Old'), runtime('b', 'Old')]),
    });
    const machine = scriptedMachine({ catalog });
    const root = await open(machine);
    await click(root, '[data-profile-row="Old"]');
    await click(root, '[data-profile-delete]');
    expect(text(root, '[data-catalog-note="delete"]')).toContain('Pick another profile for these runtimes first');
    expect(text(root, '[data-catalog-note="delete"]')).toContain('a, b move to:');
    await choose(root, '[data-profile-switch]', 'Other');
    expect(text(root, '[data-change-submit]')).toBe('Switch 2 runtimes and delete Old');
    machine.onApply = current => {
      current.catalog = studioCatalog({ profiles: profileCatalog([profile('Other', ['mcp/github'])]) });
    };
    await submit(root);
    expect(stagedChanges(machine)).toEqual([{ kind: 'profile.remove', name: 'Old', switchRuntimesTo: 'Other' }]);
    expect(text(root, '[data-profiles-saved]')).toBe('Deleted profile Old.');
    expect(root.querySelector('[data-profiles-page="list"]')).not.toBeNull();
  });

  it('confirms deleting a profile nothing uses, keeping its components', async () => {
    const catalog = studioCatalog({
      profiles: profileCatalog([
        profile('Spare', ['mcp/github'], { usedBy: ['solo'] }),
        profile('Unused', ['mcp/github']),
      ]),
      runtimes: runtimeCatalog([runtime('solo', 'Spare')]),
    });
    const machine = scriptedMachine({ catalog, stage: new Error('down') });
    const root = await open(machine);
    await click(root, '[data-profile-row="Spare"]');
    await click(root, '[data-profile-delete]');
    expect(text(root, '[data-catalog-note="delete"]')).toContain('Pick another profile for this runtime first');
    expect(text(root, '[data-catalog-note="delete"]')).toContain('solo moves to:');
    await click(root, '[data-profile-keep]');
    await click(root, '[data-catalog-back]');
    await click(root, '[data-profile-row="Unused"]');
    await click(root, '[data-profile-delete]');
    expect(text(root, '[data-catalog-note="delete"]')).toContain('Nothing uses it now. Its components stay saved.');
    await submit(root);
    expect(root.querySelector('[data-change-refusal]')).not.toBeNull();
    expect(text(root, 'h3')).toBe('Unused');
  });
});

describe('ProfilesTab — Build a profile and Edit layers (§4.5, E18, E19)', () => {
  it('builds a profile from two bases and a component, reviews the conflict, names it and opens it', async () => {
    const machine = scriptedMachine({
      preview: { harnesses: [stack('claude', { conflicts: [CONFLICT] }), stack('codex', { conflicts: [CONFLICT] })] },
    });
    const root = await open(machine);
    await click(root, '[data-profile-build]');
    expect(text(root, '#machine-stepper-title')).toBe('Build a profile');
    expect(text(root, '[data-stepper-position]')).toBe('Step 1 of 8 · Start from');
    await tick(root, '[data-build-base="Review"]');
    await tick(root, '[data-build-base="Default"]');
    expect(text(root, '[data-build-order]')).toContain('Default · wins');
    await click(root, '[aria-label="Move Default earlier"]');
    expect(text(root, '[data-build-order]')).toContain('Review · wins');
    await click(root, '[aria-label="Move Default later"]');
    await tick(root, '[data-build-base="Review"]');
    await tick(root, '[data-build-base="Agent work"]');
    await click(root, '[data-build-next]');

    expect(text(root, '[data-stepper-position]')).toBe('Step 2 of 8 · Instructions');
    expect(text(root, '[data-build-next]')).toBe('Skip, add no instructions');
    await tick(root, '[data-build-pick="instructions/Main instructions"]');
    expect(text(root, '[data-build-next]')).toBe('Next');
    await tick(root, '[data-build-pick="instructions/Main instructions"]');
    await tick(root, '[data-build-pick="instructions/Main instructions"]');
    await click(root, '[data-build-next]');
    await click(root, '[data-build-next]');
    await click(root, '[data-build-next]');
    await click(root, '[data-build-next]');
    expect(text(root, '[data-stepper-position]')).toBe('Step 6 of 8 · Model set');
    expect(root.querySelector<HTMLInputElement>('[data-build-pick=""] input')?.checked).toBe(true);
    await tick(root, '[data-build-pick="modelSets/Claude models"]');
    await tick(root, '[data-build-pick=""]');
    await click(root, '[data-build-next]');

    expect(text(root, '[data-stepper-position]')).toBe('Step 7 of 8 · Review layers');
    const layers = [...root.querySelectorAll('[data-layer]')].map(layer => layer.getAttribute('data-layer'));
    expect(layers).toEqual(['instructions/Main instructions', 'profile/Agent work', 'profile/Default']);
    expect(text(root, '[data-conflicts]')).toContain('permissions.defaultMode');
    expect(root.querySelectorAll('[data-conflicts] li')).toHaveLength(1);
    const preview = machine.calls.find(call => call.path === '/v1/fleet/profiles/preview');
    expect(preview?.body).toEqual({
      layers: ['profile/Default', 'profile/Agent work', 'instructions/Main instructions'],
    });
    await click(root, '[data-build-next]');

    expect(text(root, '[data-stepper-position]')).toBe('Step 8 of 8 · Name');
    expect(root.textContent).toContain('3 layers.');
    expect(root.textContent).not.toContain('You go back to choosing a profile');
    await typeName(root, 'Default');
    expect(root.textContent).toContain('You already have a profile called Default.');
    await typeName(root, 'Docs');
    machine.onApply = current => {
      current.catalog = studioCatalog({
        profiles: profileCatalog([...profileCatalog().profiles, profile('Docs', ['profile/Default'])]),
      });
    };
    await submit(root);
    expect(stagedChanges(machine)).toEqual([
      {
        kind: 'profile.put',
        name: 'Docs',
        layers: ['profile/Default', 'profile/Agent work', 'instructions/Main instructions'],
        create: true,
      },
    ]);
    expect(root.querySelector('[data-machine-stepper]')).toBeNull();
    expect(text(root, 'h3')).toBe('Docs');
    expect(text(root, '[data-profiles-saved]')).toBe('Profile Docs saved.');
  });

  it('cannot review an empty stack, and says when the conflicts cannot be read or a layer is refused', async () => {
    const machine = scriptedMachine();
    const root = await open(machine);
    await click(root, '[data-profile-build]');
    for (let step = 0; step < 6; step += 1) await click(root, '[data-build-next]');
    expect(text(root, '[data-catalog-note="empty"]')).toContain('This profile has no layers yet');
    expect(root.querySelector<HTMLButtonElement>('[data-build-next]')?.disabled).toBe(true);
    await click(root, '[data-stepper-back]');
    await tick(root, '[data-build-pick="modelSets/Claude models"]');
    await click(root, '[data-build-next]');
    expect(root.textContent).toContain('did not answer, so the conflicts cannot be shown yet');
    machine.preview = { harnesses: [], refusal: 'no profile Ghost exists on this machine' };
    await click(root, '[data-catalog-retry]');
    expect(text(root, '[data-catalog-note="refused"]')).toBe('no profile Ghost exists on this machine');
    expect(root.querySelector<HTMLButtonElement>('[data-build-next]')?.disabled).toBe(true);
  });

  it('creates a missing component in place, picks it and saves it for reuse (E17)', async () => {
    const machine = scriptedMachine();
    const root = await open(machine);
    await click(root, '[data-profile-build]');
    await click(root, '[data-build-next]');
    await click(root, '[data-build-create="instructions"]');
    expect(root.querySelector('[data-build-create="instructions"]')).toBeNull();
    expect(root.querySelector<HTMLButtonElement>('[data-build-next]')?.disabled).toBe(true);
    await click(root, '[data-build-create-cancel]');
    await click(root, '[data-build-create="instructions"]');
    await typeField(root, '[data-component-field="name"]', 'Team rules');
    await typeField(root, '[data-component-field="body"]', 'Be kind.');
    machine.onApply = current => {
      current.catalog = studioCatalog({
        components: componentCatalog({
          instructions: [component({ ...instructions, reference: 'instructions/Team rules', name: 'Team rules' })],
        }),
      });
    };
    await submit(root);
    expect(stagedChanges(machine)[0]).toMatchObject({ kind: 'component.put', name: 'Team rules', create: true });
    expect(root.querySelector<HTMLInputElement>('[data-build-pick="instructions/Team rules"] input')?.checked).toBe(
      true,
    );
    await click(root, '[data-stepper-cancel]');
    expect(text(root, '[data-stepper-saved]')).toBe('Instructions Team rules');
    await click(root, '[data-stepper-keep]');
    expect(text(root, '[data-stepper-position]')).toBe('Step 2 of 8 · Instructions');
  });

  it('edits a profile’s layers: itself and what includes it would include itself, and it saves under its name', async () => {
    const machine = scriptedMachine({ preview: { harnesses: [stack('claude'), stack('codex')] } });
    const root = await open(machine);
    await click(root, '[data-profile-row="Default"]');
    await click(root, '[data-profile-edit]');
    expect(text(root, '#machine-stepper-title')).toBe('Edit Default');
    await settle();
    const loops = [...root.querySelectorAll('[data-build-loop]')].map(loop =>
      loop.closest('[data-build-base]')?.getAttribute('data-build-base'),
    );
    expect(loops).toEqual(['Agent work', 'Default', 'Review']);
    expect(root.querySelector<HTMLInputElement>('[data-build-base="Default"] input')?.disabled).toBe(true);
    await click(root, '[data-build-next]');
    expect(
      root.querySelector<HTMLInputElement>('[data-build-pick="instructions/Main instructions"] input')?.checked,
    ).toBe(true);
    for (let step = 0; step < 6; step += 1) await click(root, '[data-build-next]');
    expect(root.textContent).toContain('Saving the new layers of Default.');
    expect(text(root, '[data-change-submit]')).toBe('Save changes');
    await submit(root);
    expect(stagedChanges(machine)).toEqual([
      {
        kind: 'profile.put',
        name: 'Default',
        layers: ['instructions/Main instructions', 'mcp/github', 'settings/Claude settings', 'modelSets/Claude models'],
        create: false,
      },
    ]);
    expect(text(root, '[data-profiles-saved]')).toBe('Saved. New sessions use the new layers.');
    expect(text(root, 'h3')).toBe('Default');
  });

  it('pauses on an offline machine and stops when the person leaves', async () => {
    const root = await open(scriptedMachine(), { online: false });
    await click(root, '[data-profile-build]');
    expect(root.querySelector('[data-stepper-paused]')).not.toBeNull();
    await click(root, '[data-stepper-cancel]');
    expect(text(root, '[data-stepper-confirm]')).toContain('No profile is created.');
    await click(root, '[data-stepper-stop]');
    expect(root.querySelector('[data-machine-stepper]')).toBeNull();
    expect(text(root, 'h3')).toBe('Profiles');
  });

  it('edits a profile the catalogue no longer has as a fresh draft', async () => {
    const machine = scriptedMachine();
    const root = await open(machine);
    await click(root, '[data-profile-row="Review"]');
    machine.catalog = studioCatalog({ profiles: profileCatalog([profile('Default', ['mcp/github'])]) });
    await click(root, '[data-profile-edit]');
    expect(root.querySelectorAll('[data-build-base] input:checked')).toHaveLength(0);
    await click(root, '[data-build-next]');
    await tick(root, '[data-build-pick="instructions/Main instructions"]');
  });
});

const must = <T,>(value: T | null | undefined): T => {
  if (value === null || value === undefined) throw new Error('missing');
  return value;
};

const typeField = type;

const typeName = (root: ParentNode, value: string) => typeField(root, '[data-build-name]', value);
