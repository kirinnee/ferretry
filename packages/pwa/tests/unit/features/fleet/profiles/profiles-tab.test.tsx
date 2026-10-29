import { afterEach, describe, expect, it } from 'bun:test';
import type { FleetProfileDraftView, FleetResolvedEntry } from '@ferretry/protocol';
import { ProfilesTab } from '../../../../../src/features/fleet/profiles/profiles-tab.tsx';
import { interact, type Mounted, mount } from '../../../../support/dom.ts';
import {
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

const must = <T,>(value: T | null | undefined, what = 'element'): T => {
  if (value === null || value === undefined) throw new Error(`missing ${what}`);
  return value;
};

const resolvedEntry = (overrides: Partial<FleetResolvedEntry>): FleetResolvedEntry => ({
  harness: 'claude',
  field: 'settings',
  key: 'permissions.defaultMode',
  value: 'acceptEdits',
  from: 'settings/Claude settings',
  overridden: [],
  ...overrides,
});

/** What the daemon answers for Default's contents: Claude settings overrides the instructions' key. */
const defaultPreview = (overrides: Partial<FleetProfileDraftView> = {}): FleetProfileDraftView => ({
  harnesses: [stack('claude'), stack('codex')],
  scope: { kind: 'scoped', scope: 'claude' },
  resolved: [
    resolvedEntry({ field: 'mcp', key: 'github', value: 'npx -y github', from: 'mcp/github' }),
    resolvedEntry({ overridden: [{ value: 'plan', from: 'instructions/Main instructions' }] }),
    resolvedEntry({ field: 'env', key: 'env.API_KEY', value: '‹hidden›', hidden: true }),
    resolvedEntry({ harness: 'codex', field: 'mcp', key: 'github', value: 'npx', from: 'mcp/github' }),
  ],
  ...overrides,
});

const rows = (root: ParentNode): string[] =>
  [...root.querySelectorAll('[data-profile-item]')].map(row => row.getAttribute('data-profile-item') ?? '');

const drag = async (target: Element, kind: 'dragstart' | 'dragover' | 'drop' | 'dragend'): Promise<void> => {
  await interact(async () => {
    target.dispatchEvent(new Event(kind, { bubbles: true, cancelable: true }));
    for (let turn = 0; turn < 20; turn += 1) await new Promise(resolve => setTimeout(resolve, 0));
  });
};

/** A full drag: pick `from` up, pass over `over`, drop there, let go. */
const dragTo = async (from: Element, over: Element): Promise<void> => {
  await drag(from, 'dragstart');
  await drag(over, 'dragover');
  await drag(over, 'drop');
  await drag(from, 'dragend');
};

const q = (root: ParentNode, selector: string): Element => must(root.querySelector(selector), selector);

describe('ProfilesTab — list', () => {
  it('leads each profile with its name, scope badge, size and what runs on it', async () => {
    const root = await open();
    expect(text(root, 'h3')).toBe('Profiles');
    expect(root.textContent).toContain('3 profiles');
    expect(text(root, '[data-profile-row="Default"] [data-component-badges]')).toBe('Claude only');
    expect(text(root, '[data-profile-row="Default"]')).toContain('4 items · 4 parts · used by 3 runtimes');
    expect(text(root, '[data-profile-row="Review"]')).toContain('used by 1 runtime');
  });

  it('offers a new profile on an empty machine', async () => {
    const root = await open(scriptedMachine({ catalog: studioCatalog({ profiles: profileCatalog([]) }) }));
    expect(root.textContent).toContain('No profiles yet');
    expect(root.textContent).toContain('A profile is a bag of components');
    await click(root, '[data-profile-new]');
    expect(root.querySelector('[data-profiles-page="new"]')).not.toBeNull();
  });

  it('shows Reading… first, and why when the read fails', async () => {
    mounted = await mount(
      <ProfilesTab {...tabProps(scriptedMachine(), { createClient: () => new Promise(() => undefined) })} />,
    );
    expect(mounted.container.textContent).toContain('Reading studio-mac’s profiles…');
    await mounted.unmount();
    const root = await open(scriptedMachine({ readFails: new Error('down') }));
    expect(root.textContent).toContain('did not answer');
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

describe('ProfilesTab — the profile page', () => {
  it('shows the contents in order with override chips, the library, its scope and where it is used', async () => {
    const machine = scriptedMachine({ preview: defaultPreview() });
    const root = await open(machine);
    await click(root, '[data-profile-row="Default"]');
    expect(text(root, 'h3')).toBe('Default');
    expect(rows(root)).toEqual([
      'instructions/Main instructions',
      'mcp/github',
      'settings/Claude settings',
      'modelSets/Claude models',
    ]);
    expect(text(root, '[data-profile-scope]')).toContain('Claude only');
    expect(text(root, '[data-profile-scope]')).toContain('derived from the contents');
    expect(text(root, '[data-profile-box]')).toContain('4 items · later overrides earlier');
    expect(text(root, '[data-profile-item="settings/Claude settings"] [data-override-chip]')).toBe(
      'overrides Main instructions · permissions.defaultMode',
    );
    expect(text(root, '[data-profile-item="settings/Claude settings"] [data-item-scope]')).toBe('Claude only');
    expect(machine.calls.find(call => call.path === '/v1/fleet/profiles/preview')?.body).toEqual({
      layers: ['instructions/Main instructions', 'mcp/github', 'settings/Claude settings', 'modelSets/Claude models'],
      editing: 'Default',
    });
    expect(text(root, '[data-library-add="mcp/github"]')).toBe('In profile');
    expect(q(root, '[data-library-add="mcp/github"]').getAttribute('aria-label')).toBe('github is in Default');
    expect(text(root, '[data-library-add="mcp/notes"]')).toBe('Add');
    expect(root.querySelector('[data-library-item="profile/Default"]')).toBeNull();
    expect(root.querySelector('[data-profile-includer="Agent work"]')?.textContent).toContain('Contains Default');
    const runtimes = [...root.querySelectorAll('[data-catalog-link]')].map(link => link.textContent);
    expect(runtimes).toEqual([
      'claude-agentRuntime · through Agent work',
      'claude-defaultRuntime',
      'claude-reviewRuntime · through Review',
    ]);
    expect(text(root, '[data-change-submit]')).toBe('Save changes');
    expect(q(root, '[data-change-submit]').hasAttribute('disabled')).toBe(true);
    await click(root, '[data-profile-includer="Agent work"]');
    expect(text(root, 'h3')).toBe('Agent work');
    await click(root, '[data-catalog-back]');
    expect(root.querySelector('[data-profiles-page="list"]')).not.toBeNull();
  });

  it('adds with the library’s Add, reorders with ↑ / ↓ keeping focus, removes with ✕, and saves ONE change', async () => {
    const machine = scriptedMachine({ preview: defaultPreview() });
    const root = await open(machine);
    await click(root, '[data-profile-row="Default"]');
    await click(root, '[data-library-add="mcp/notes"]');
    expect(rows(root).at(-1)).toBe('mcp/notes');
    expect(text(root, '[data-profile-said]')).toBe('Added notes at position 5 of 5.');
    expect(text(root, '[data-library-add="mcp/notes"]')).toBe('In profile');
    expect(machine.calls.filter(call => call.path === '/v1/fleet/profiles/preview')).toHaveLength(2);

    await click(root, '[data-profile-item="mcp/notes"] [data-item-move="up"]');
    expect(rows(root).indexOf('mcp/notes')).toBe(3);
    expect(document.activeElement?.closest('[data-profile-item]')?.getAttribute('data-profile-item')).toBe('mcp/notes');
    expect(text(root, '[data-profile-said]')).toBe('Moved notes to position 4 of 5.');
    await click(root, '[data-profile-item="mcp/notes"] [data-item-move="down"]');
    expect(rows(root).at(-1)).toBe('mcp/notes');
    // At the end, focus stays on the button that still works.
    expect(document.activeElement?.getAttribute('data-item-move')).toBe('up');
    await click(root, '[data-profile-item="instructions/Main instructions"] [data-item-move="up"]');
    expect(rows(root)[0]).toBe('instructions/Main instructions');

    await click(root, '[data-profile-item="mcp/github"] [data-item-remove]');
    expect(rows(root)).not.toContain('mcp/github');
    expect(text(root, '[data-profile-said]')).toBe('Removed github.');
    expect(root.textContent).toContain('Unsaved: new sessions keep the saved contents');

    await submit(root);
    expect(stagedChanges(machine)).toEqual([
      {
        kind: 'profile.put',
        name: 'Default',
        layers: ['instructions/Main instructions', 'settings/Claude settings', 'modelSets/Claude models', 'mcp/notes'],
        create: false,
      },
    ]);
    expect(text(root, '[data-profiles-saved]')).toBe('Saved. New sessions use the new contents.');
  });

  it('keeps the last resolved values on screen while a second edit is still being read', async () => {
    const machine = scriptedMachine({ preview: defaultPreview() });
    const props = tabProps(machine);
    let release: (() => void) | undefined;
    let hold: Promise<void> | undefined;
    mounted = await mountSettled(
      <ProfilesTab
        {...props}
        createClient={async connection => {
          const client = await props.createClient(connection);
          return {
            ...client,
            request: async (path, schema, init) => {
              if (hold !== undefined && path === '/v1/fleet/profiles/preview') await hold;
              return client.request(path, schema, init);
            },
          };
        }}
      />,
    );
    const root = mounted.container;
    await click(root, '[data-profile-row="Default"]');
    hold = new Promise<void>(resolve => {
      release = resolve;
    });
    await click(root, '[data-library-add="mcp/notes"]');
    await click(root, '[data-profile-item="mcp/notes"] [data-item-remove]');
    await click(root, '[data-profile-view="resolved"]');
    expect(root.querySelector('[data-resolved-row="permissions.defaultMode"]')).not.toBeNull();
    release?.();
    await settle();
    expect(root.querySelector('[data-resolved-row="permissions.defaultMode"]')).not.toBeNull();
    expect(machine.calls.filter(call => call.path === '/v1/fleet/profiles/preview')).toHaveLength(3);
  });

  it('discards an edit back to the saved contents', async () => {
    const root = await open(scriptedMachine({ preview: defaultPreview() }));
    await click(root, '[data-profile-row="Default"]');
    expect(root.querySelector('[data-profile-discard]')).toBeNull();
    await click(root, '[data-profile-item="mcp/github"] [data-item-remove]');
    await click(root, '[data-profile-discard]');
    expect(rows(root)).toContain('mcp/github');
    expect(text(root, '[data-profile-said]')).toBe('Changes discarded.');
  });

  it('drags a library item in where the line is, reorders by drag, and drags a row out to remove it', async () => {
    const root = await open(scriptedMachine({ preview: defaultPreview() }));
    await click(root, '[data-profile-row="Default"]');
    const target = q(root, '[data-profile-item="settings/Claude settings"]');
    await drag(q(root, '[data-library-item="mcp/notes"]'), 'dragstart');
    await drag(target, 'dragover');
    expect(target.className).toContain('shadow-');
    await drag(target, 'drop');
    expect(rows(root)).toEqual([
      'instructions/Main instructions',
      'mcp/github',
      'mcp/notes',
      'settings/Claude settings',
      'modelSets/Claude models',
    ]);
    expect(text(root, '[data-profile-said]')).toBe('Added notes at position 3 of 5.');

    // Reorder: the first row dropped on the list's end goes last.
    await dragTo(q(root, '[data-profile-item="instructions/Main instructions"]'), q(root, '[data-profile-contents]'));
    expect(rows(root).at(-1)).toBe('instructions/Main instructions');
    expect(text(root, '[data-profile-said]')).toBe('Moved Main instructions to position 5 of 5.');
    await dragTo(q(root, '[data-profile-item="modelSets/Claude models"]'), q(root, '[data-profile-item="mcp/github"]'));
    expect(rows(root)[0]).toBe('modelSets/Claude models');

    // Out: a row dragged onto the library is taken out.
    const row = q(root, '[data-profile-item="mcp/notes"]');
    await drag(row, 'dragstart');
    const library = q(root, '[data-profile-library]');
    expect(library.className).toContain('outline-dashed');
    await drag(library, 'dragover');
    await drag(library, 'drop');
    expect(rows(root)).not.toContain('mcp/notes');
    await drag(row, 'dragend');

    // A drag over the list with nothing picked up is ignored, and so is a drop on the library.
    await drag(q(root, '[data-profile-contents]'), 'dragover');
    await drag(library, 'drop');
    await drag(q(root, '[data-profile-contents]'), 'drop');
    expect(rows(root)).toHaveLength(4);
  });

  it('refuses a drop that would mix Claude-only with Codex-only content, naming the culprits', async () => {
    const catalog = studioCatalog({
      profiles: profileCatalog([
        ...profileCatalog().profiles,
        profile('Codex', ['mcp/github'], { scope: { kind: 'scoped', scope: 'codex' } }),
      ]),
    });
    const root = await open(scriptedMachine({ catalog, preview: defaultPreview() }));
    await click(root, '[data-profile-row="Default"]');
    await dragTo(q(root, '[data-library-item="profile/Codex"]'), q(root, '[data-profile-contents]'));
    expect(text(root, '[data-catalog-note="refused"]')).toContain(
      'Refused: Codex is Codex only, but Default is Claude only because of Claude settings. A profile can’t mix Claude-only and Codex-only content.',
    );
    expect(rows(root)).not.toContain('profile/Codex');
    await click(root, '[data-refusal-dismiss]');
    expect(root.querySelector('[data-catalog-note="refused"]')).toBeNull();
    // A profile that contains this one cannot go in it either.
    await click(root, '[data-library-add="profile/Review"]');
    expect(text(root, '[data-catalog-note="refused"]')).toContain('Default would contain itself');
    // A successful add clears it.
    await click(root, '[data-library-add="mcp/notes"]');
    expect(root.querySelector('[data-catalog-note="refused"]')).toBeNull();
  });

  it('filters the library by search and by kind', async () => {
    const root = await open(scriptedMachine({ preview: defaultPreview() }));
    await click(root, '[data-profile-row="Default"]');
    const library = q(root, '[data-profile-library]');
    await type(library, '[data-library-search]', 'not');
    expect(
      [...library.querySelectorAll('[data-library-item]')].map(row => row.getAttribute('data-library-item')),
    ).toEqual(['mcp/notes']);
    await type(library, '[data-library-search]', 'zzz');
    expect(library.textContent).toContain('No components match.');
    await type(library, '[data-library-search]', '');
    await choose(library, '[data-library-kind]', 'profile');
    expect(library.querySelectorAll('[data-library-item]')).toHaveLength(2);
  });

  it('shows the Resolved view: each final value, where it came from, overridden ones struck through', async () => {
    const root = await open(scriptedMachine({ preview: defaultPreview() }));
    await click(root, '[data-profile-row="Default"]');
    await click(root, '[data-profile-view="resolved"]');
    expect(q(root, '[data-profile-view="resolved"]').getAttribute('aria-pressed')).toBe('true');
    expect(root.querySelector('[data-profile-contents]')).toBeNull();
    const table = q(root, '[data-resolved="claude"]');
    expect(table.querySelector('[data-resolved-harness]')).toBeNull();
    const row = q(table, '[data-resolved-row="permissions.defaultMode"]');
    expect(row.textContent).toBe(
      'permissions.defaultModeacceptEditsoverrode planfrom Claude settingsMain instructions',
    );
    expect(row.querySelectorAll('s')).toHaveLength(2);
    expect(text(table, '[data-resolved-row="github"]')).toContain('MCP server · github');
    expect(text(table, '[data-resolved-row="env.API_KEY"]')).toContain('‹hidden›');
    await click(root, '[data-profile-view="list"]');
    expect(root.querySelector('[data-profile-contents]')).not.toBeNull();
  });

  it('switches Resolved between the tools of a Generic profile, and says when the machine is too old', async () => {
    const machine = scriptedMachine({
      preview: defaultPreview({ scope: { kind: 'scoped', scope: 'generic' } }),
      catalog: studioCatalog({ profiles: profileCatalog([profile('Shared', ['mcp/github'])]) }),
    });
    const root = await open(machine);
    await click(root, '[data-profile-row="Shared"]');
    await click(root, '[data-profile-view="resolved"]');
    expect(root.querySelector('[data-resolved="claude"]')).not.toBeNull();
    await click(root, '[data-resolved-harness="codex"]');
    expect(text(root, '[data-resolved="codex"]')).toContain('npx');
    // Every item out: nothing resolves, and nothing is asked.
    await click(root, '[data-profile-view="list"]');
    await click(root, '[data-profile-item="mcp/github"] [data-item-remove]');
    await click(root, '[data-profile-view="resolved"]');
    expect(root.textContent).toContain('Nothing resolves yet');
    await click(root, '[data-profile-view="list"]');
    expect(root.textContent).toContain('Tap Add to put components in.');
    expect(q(root, '[data-change-submit]').hasAttribute('disabled')).toBe(true);
    await click(root, '[data-profile-discard]');
    machine.preview = defaultPreview({ resolved: undefined });
    await click(root, '[data-profile-item="mcp/github"] [data-item-remove]');
    await click(root, '[data-library-add="mcp/github"]');
    await click(root, '[data-profile-view="resolved"]');
    expect(text(root, '[data-resolved="unavailable"]')).toContain('too old to show the resolved values');
  });

  it('says when the overrides cannot be read, retries, and holds Save on the daemon’s refusal', async () => {
    const machine = scriptedMachine();
    const root = await open(machine);
    await click(root, '[data-profile-row="Default"]');
    expect(text(root, '[data-profile-preview-failed]')).toContain('studio-mac did not answer');
    machine.preview = defaultPreview({ refusal: 'no MCP server ghost exists on this machine' });
    await click(root, '[data-profile-preview-retry]');
    expect(text(root, '[data-catalog-note="draft-refused"]')).toContain('no MCP server ghost exists on this machine');
    await click(root, '[data-profile-item="mcp/github"] [data-item-remove]');
    expect(q(root, '[data-change-submit]').hasAttribute('disabled')).toBe(true);
  });

  it('reads a profile written before scopes as Mixed and will not save it until it is one tool’s', async () => {
    const sentence =
      "Profile Old can't be both Claude only and Codex only: settings claude is Claude only and settings codex is Codex only.";
    const catalog = studioCatalog({
      profiles: profileCatalog([
        profile('Codex', ['mcp/github'], { scope: { kind: 'scoped', scope: 'codex' } }),
        profile('Old', ['settings/Claude settings', 'profile/Codex'], { scope: { kind: 'mixed', sentence } }),
      ]),
      runtimes: runtimeCatalog([]),
    });
    const root = await open(scriptedMachine({ catalog, preview: defaultPreview() }));
    expect(text(root, '[data-profile-row="Old"] [data-component-badges]')).toBe('Mixed');
    await click(root, '[data-profile-row="Old"]');
    expect(text(root, '[data-catalog-note="mixed"]')).toContain(sentence);
    expect(text(root, '[data-profile-scope]')).toContain('Mixed');
    expect(root.textContent).toContain('Nothing uses this profile yet.');
    await click(root, '[data-profile-item="profile/Codex"] [data-item-move="up"]');
    expect(q(root, '[data-change-submit]').hasAttribute('disabled')).toBe(true);
    await click(root, '[data-profile-item="profile/Codex"] [data-item-remove]');
    expect(text(root, '[data-profile-scope]')).toContain('Claude only');
    expect(q(root, '[data-change-submit]').hasAttribute('disabled')).toBe(false);
  });

  it('draws an item the catalogue does not know as written', async () => {
    const catalog = studioCatalog({ profiles: profileCatalog([profile('Lonely', ['widgets/x', 'mcp/unknown'])]) });
    const root = await open(scriptedMachine({ catalog, preview: defaultPreview() }));
    await click(root, '[data-profile-row="Lonely"]');
    expect(text(root, '[data-profile-item="widgets/x"]')).toContain('Unknownwidgets/x');
    expect(text(root, '[data-profile-item="mcp/unknown"]')).toContain('MCPunknown');
  });

  it('opens the profile’s file as YAML and reads the catalogue again after an edit there', async () => {
    const machine = scriptedMachine({ preview: defaultPreview() });
    const root = await open(machine);
    await click(root, '[data-profile-row="Default"]');
    expect(text(root, '[data-profile-file]')).toContain('config/profiles/Default.yaml');
    await click(root, '[data-profile-yaml]');
    expect(document.querySelector('[data-config-editor="profiles/Default.yaml"]')).not.toBeNull();
    expect(machine.calls.some(call => call.path === '/v1/config/file?path=profiles%2FDefault.yaml')).toBe(true);
    await click(document, '[data-config-cancel]');
    expect(document.querySelector('[data-config-editor]')).toBeNull();
  });
});

describe('ProfilesTab — a new profile', () => {
  it('names it, fills it, and saves it as a new profile, then opens it', async () => {
    const machine = scriptedMachine({ preview: defaultPreview({ scope: { kind: 'scoped', scope: 'generic' } }) });
    const root = await open(machine);
    await click(root, '[data-profile-new]');
    expect(text(root, 'h3')).toBe('New profile');
    expect(text(root, '[data-change-submit]')).toBe('Save profile');
    expect(q(root, '[data-change-submit]').hasAttribute('disabled')).toBe(true);
    expect(root.querySelector('[data-profile-file]')).toBeNull();
    expect(text(root, '[data-profile-box]')).toContain('this profile');
    await type(root, '[data-profile-name]', 'Default');
    expect(root.textContent).toContain('You already have a profile called Default.');
    await type(root, '[data-profile-name]', 'Docs');
    expect(text(root, '[data-profile-box]')).toContain('Docs');
    await click(root, '[data-library-add="profile/Default"]');
    await click(root, '[data-library-add="mcp/notes"]');
    machine.onApply = current => {
      current.catalog = studioCatalog({
        profiles: profileCatalog([...profileCatalog().profiles, profile('Docs', ['profile/Default', 'mcp/notes'])]),
      });
    };
    await submit(root);
    expect(stagedChanges(machine)).toEqual([
      { kind: 'profile.put', name: 'Docs', layers: ['profile/Default', 'mcp/notes'], create: true },
    ]);
    expect(text(root, 'h3')).toBe('Docs');
    expect(text(root, '[data-profiles-saved]')).toBe('Profile Docs saved.');
  });

  it('cancels back to the list, and Back does too', async () => {
    const root = await open();
    await click(root, '[data-profile-new]');
    await click(root, '[data-profile-cancel]');
    expect(root.querySelector('[data-profiles-page="list"]')).not.toBeNull();
    await click(root, '[data-profile-new]');
    await click(root, '[data-catalog-back]');
    expect(root.querySelector('[data-profiles-page="list"]')).not.toBeNull();
  });

  it('on a phone, adds from the picker sheet, saying there why something is refused', async () => {
    const root = await open(scriptedMachine({ preview: defaultPreview() }));
    await click(root, '[data-profile-row="Default"]');
    await click(root, '[data-profile-pick]');
    const picker = q(document, '[data-profile-picker]');
    expect(text(picker, 'h2')).toBe('Add to Default');
    await type(picker, '[data-library-search]', 'notes');
    await click(picker, '[data-library-add="mcp/notes"]');
    expect(rows(root).at(-1)).toBe('mcp/notes');
    expect(text(picker, '[data-library-add="mcp/notes"]')).toBe('Added');
    await type(picker, '[data-library-search]', '');
    await click(picker, '[data-library-add="profile/Agent work"]');
    expect(text(picker, '[data-catalog-note="picker-refused"]')).toContain('would contain itself');
    await click(picker, '[data-picker-done]');
    await settle();
  });

  it('holds Save while the machine is offline', async () => {
    const root = await open(scriptedMachine({ preview: defaultPreview() }), { online: false });
    await click(root, '[data-profile-row="Default"]');
    await click(root, '[data-profile-item="mcp/github"] [data-item-remove]');
    expect(q(root, '[data-change-submit]').hasAttribute('disabled')).toBe(true);
  });
});

describe('ProfilesTab — delete (E21)', () => {
  it('is blocked while another profile contains it; Remove from those first, then switch its runtime', async () => {
    const root = await open(scriptedMachine({ preview: defaultPreview() }));
    await click(root, '[data-profile-row="Default"]');
    await click(root, '[data-profile-delete]');
    const blocked = text(root, '[data-catalog-note="delete"]');
    expect(blocked).toContain('Default is in use, so it can’t be deleted');
    expect(blocked).toContain('It is inside Agent work and Review, and these runtimes use it: claude-default.');
    await click(root, '[data-profile-keep]');
    await click(root, '[data-profile-delete]');
    await click(root, '[data-profile-detach]');
    const moving = text(root, '[data-catalog-note="delete"]');
    expect(moving).toContain('Pick another profile for this runtime first');
    expect(moving).toContain('It is taken out of Agent work and Review first.');
    expect(moving).toContain('There is no other profile to move to yet.');
  });

  it('blocks deleting a profile only another profile contains, naming no runtime', async () => {
    const catalog = studioCatalog({
      profiles: profileCatalog([profile('Inner', ['mcp/github'], { baseFor: ['Outer'] })]),
      runtimes: runtimeCatalog([]),
    });
    const root = await open(scriptedMachine({ catalog, preview: defaultPreview() }));
    await click(root, '[data-profile-row="Inner"]');
    await click(root, '[data-profile-delete]');
    const blocked = text(root, '[data-catalog-note="delete"]');
    expect(blocked).toContain('Inner is in use, so it can’t be deleted');
    expect(blocked).toContain('It is inside Outer.');
    expect(blocked).not.toContain('these runtimes use it');
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
    const machine = scriptedMachine({ catalog, preview: defaultPreview() });
    const root = await open(machine);
    await click(root, '[data-profile-row="Old"]');
    await click(root, '[data-profile-delete]');
    expect(text(root, '[data-catalog-note="delete"]')).toContain('a, b move to:');
    expect([...root.querySelectorAll('[data-profile-switch] option')].map(option => option.textContent)).toEqual([
      'New · Generic',
      'Other · Generic',
    ]);
    await choose(root, '[data-profile-switch]', 'Other');
    const panel = q(root, '[data-catalog-note="delete"]');
    expect(text(panel, '[data-change-submit]')).toBe('Switch 2 runtimes and delete Old');
    machine.onApply = current => {
      current.catalog = studioCatalog({ profiles: profileCatalog([profile('Other', ['mcp/github'])]) });
    };
    await click(panel, '[data-change-submit]');
    expect(stagedChanges(machine)).toEqual([{ kind: 'profile.remove', name: 'Old', switchRuntimesTo: 'Other' }]);
    expect(text(root, '[data-profiles-saved]')).toBe('Deleted profile Old.');
    expect(root.querySelector('[data-profiles-page="list"]')).not.toBeNull();
  });

  it('confirms deleting a profile nothing uses, keeping its components, and says when it fails', async () => {
    const catalog = studioCatalog({
      profiles: profileCatalog([
        profile('Spare', ['mcp/github'], { usedBy: ['solo'] }),
        profile('Unused', ['mcp/github']),
      ]),
      runtimes: runtimeCatalog([runtime('solo', 'Spare')]),
    });
    const machine = scriptedMachine({ catalog, stage: new Error('down'), preview: defaultPreview() });
    const root = await open(machine);
    await click(root, '[data-profile-row="Spare"]');
    await click(root, '[data-profile-delete]');
    expect(text(root, '[data-catalog-note="delete"]')).toContain('solo moves to:');
    await click(root, '[data-profile-keep]');
    await click(root, '[data-catalog-back]');
    await click(root, '[data-profile-row="Unused"]');
    await click(root, '[data-profile-delete]');
    const panel = q(root, '[data-catalog-note="delete"]');
    expect(panel.textContent).toContain('Nothing uses it now. Its components stay saved.');
    await click(panel, '[data-change-submit]');
    expect(panel.querySelector('[data-change-refusal]')).not.toBeNull();
    expect(text(root, 'h3')).toBe('Unused');
  });
});
