import { afterEach, describe, expect, it } from 'bun:test';
import { FleetComponentCatalogSchema } from '@ferretry/protocol';
import { FyHttpError } from '@ferretry/protocol/client';
import { ComponentsSurface, ComponentsTab } from '../../../../../src/features/fleet/components/components-tab.tsx';
import { DaemonConnectionStore } from '../../../../../src/lib/connections.ts';
import { daemonConnection } from '../../../../../src/lib/daemon-connection.ts';
import { type AppStore, StoreProvider } from '../../../../../src/lib/store.tsx';
import { type Mounted, mount } from '../../../../support/dom.ts';
import {
  claudeSettings,
  component,
  componentCatalog,
  github,
  hooks,
  instructions,
  models,
  notes,
  studioCatalog,
} from './catalog-fixture.ts';
import {
  choose,
  click,
  followHash,
  type Machine,
  mountSettled,
  scriptedMachine,
  stagedChanges,
  submit,
  tabProps,
  text,
  type,
} from './view-support.tsx';

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  window.history.replaceState(null, '', '/');
});

const open = async (machine: Machine = scriptedMachine(), overrides: Parameters<typeof tabProps>[1] = {}) => {
  mounted = await mountSettled(<ComponentsTab {...tabProps(machine, overrides)} />);
  return mounted.container;
};

const toDetail = async (root: HTMLElement, kind: string, reference: string) => {
  await click(root, `[data-component-kind="${kind}"]`);
  await click(root, `[data-component-row="${reference}"]`);
};

describe('ComponentsTab — reading', () => {
  it('lists the six kinds with their counts and opens a kind’s list with badges and use', async () => {
    const root = await open();
    expect(text(root, 'h3')).toBe('Components');
    expect(root.querySelectorAll('[data-component-kind]')).toHaveLength(6);
    expect(text(root, '[data-component-kind="mcp"]')).toContain('MCP servers');
    expect(text(root, '[data-component-kind="mcp"]')).toContain('2');
    await click(root, '[data-component-kind="mcp"]');
    expect(text(root, 'h3')).toBe('MCP servers');
    expect(text(root, '[data-component-row="mcp/github"]')).toContain('Used by 2 profiles, 2 runtimes');
    expect(text(root, '[data-component-row="mcp/notes"]')).toContain('Check this path on studio-mac');
    await click(root, '[data-catalog-back]');
    expect(root.querySelector('[data-components-page="kinds"]')).not.toBeNull();
  });

  it('says a kind has none yet, and falls back to its own words for a kind the daemon did not list', async () => {
    const catalog = studioCatalog({
      components: FleetComponentCatalogSchema.parse({
        format: 'version-2',
        kinds: componentCatalog()
          .kinds.filter(group => group.kind !== 'hooks')
          .map(group => (group.kind === 'skills' ? { ...group, components: [] } : group)),
      }),
    });
    const root = await open(scriptedMachine({ catalog }));
    expect(text(root, '[data-component-kind="hooks"]')).toContain('Hooks');
    await click(root, '[data-component-kind="hooks"]');
    expect(text(root, 'h3')).toBe('Hooks');
    expect(root.textContent).toContain('None saved yet.');
    await click(root, '[data-catalog-back]');
    await click(root, '[data-component-kind="skills"]');
    expect(root.textContent).toContain('None saved yet.');
  });

  it('says why when the catalogue cannot be read, and reads again on Try again', async () => {
    const machine = scriptedMachine({ readFails: new FyHttpError('nope', 403, 'grant_refused') });
    const root = await open(machine);
    expect(text(root, '[data-catalog-note="read-failed"]')).toContain('did not share its setup: nope');
    machine.readFails = undefined;
    await click(root, '[data-catalog-retry]');
    expect(root.querySelector('[data-component-kind]')).not.toBeNull();
    const offline = await open(scriptedMachine({ readFails: new Error('down') }));
    expect(offline.textContent).toContain('did not answer');
  });

  it('shows Reading… until the catalogue answers', async () => {
    mounted = await mount(
      <ComponentsTab {...tabProps(scriptedMachine(), { createClient: () => new Promise(() => undefined) })} />,
    );
    expect(mounted.container.textContent).toContain('Reading studio-mac’s components…');
  });
});

describe('ComponentsTab — a component’s page', () => {
  it('shows an MCP server’s command, environment, warnings, the path to check and who uses it', async () => {
    const root = await open();
    await toDetail(root, 'mcp', 'mcp/notes');
    expect(text(root, 'h3')).toBe('notes');
    expect(text(root, '[data-catalog-note="warning"]')).toContain('Command not found: uvx');
    expect(text(root, '[data-catalog-note="path"]')).toContain('Check this path on studio-mac');
    expect(text(root, '[data-catalog-note="path"]')).toContain('/Users/other/Notes');
    expect(root.textContent).toContain('uvx notes-mcp --vault /Users/other/Notes');
    expect(root.textContent).toContain('Used by 0 profiles and 0 runtimes.');
    await click(root, '[data-component-edit-path]');
    expect(text(root, 'h3')).toBe('Edit notes');
    await click(root, '[data-catalog-back]');
    await click(root, '[data-catalog-back]');
    await click(root, '[data-component-row="mcp/github"]');
    expect(root.textContent).toContain('Ferretry adapts this for each harness');
    expect(root.textContent).toContain('In Ferretry’s secret store · never shown');
    expect(root.textContent).toContain('info');
    const links = [...root.querySelectorAll('[data-catalog-link]')].map(link => link.textContent);
    expect(links[0]).toContain('Has it as a layer');
    expect(links[1]).toContain('Gets it through a base profile');
    expect(root.querySelector('[data-catalog-link]')?.getAttribute('href')).toBe(
      '#machines/studio-mac/profiles/Default',
    );
  });

  it('shows skills with partial support, settings with a hidden value and flags, models with the default', async () => {
    const root = await open();
    await toDetail(root, 'skills', 'skills/My skills');
    expect(text(root, '[data-catalog-note="partial"]')).toContain('Partly supported on Codex');
    expect(root.textContent).toContain('release-notes');
    await click(root, '[data-catalog-back]');
    await click(root, '[data-catalog-back]');
    await toDetail(root, 'settings', 'settings/Claude settings');
    expect(root.textContent).toContain('Hidden · never shown');
    expect(root.textContent).toContain('permissions.defaultMode');
    expect(root.textContent).toContain('--verbose');
    expect(root.textContent).toContain('env.API_KEY');
    expect(root.textContent).not.toContain('Ferretry adapts this');
    await click(root, '[data-catalog-back]');
    await click(root, '[data-catalog-back]');
    await toDetail(root, 'modelSets', 'modelSets/Claude models');
    expect(root.textContent).toContain('claude-sonnet-5Default');
    expect(root.textContent).not.toContain('Ferretry adapts this');
    await click(root, '[data-catalog-back]');
    await click(root, '[data-catalog-back]');
    await toDetail(root, 'hooks', 'hooks/Format on save');
    expect(root.textContent).toContain('{"PostToolUse": []}');
  });

  it('says what it cannot show: an empty settings file, a hooks folder, unreadable text', async () => {
    const catalog = studioCatalog({
      components: componentCatalog({
        settings: [
          component({
            ...claudeSettings,
            reference: 'settings/Empty',
            name: 'Empty',
            content: { form: 'entries', entries: [] },
            detail: { kind: 'settings', env: [] },
          }),
        ],
        hooks: [
          component({
            ...hooks,
            reference: 'hooks/Folder',
            name: 'Folder',
            detail: { kind: 'hooks', directory: 'hooks' },
            content: undefined,
          }),
        ],
        instructions: [
          component({ ...instructions, reference: 'instructions/Gone', name: 'Gone', content: undefined }),
        ],
      }),
    });
    const root = await open(scriptedMachine({ catalog }));
    await toDetail(root, 'settings', 'settings/Empty');
    expect(root.textContent).toContain('No settings in this file yet.');
    await click(root, '[data-catalog-back]');
    await click(root, '[data-catalog-back]');
    await toDetail(root, 'hooks', 'hooks/Folder');
    expect(root.textContent).toContain('edited there');
    await click(root, '[data-catalog-back]');
    await click(root, '[data-catalog-back]');
    await toDetail(root, 'instructions', 'instructions/Gone');
    expect(root.textContent).toContain('could not be read');
  });

  it('opens the page a link names, and says when it is gone', async () => {
    window.history.replaceState(null, '', `/#machines/studio-mac/components/${encodeURIComponent('mcp/github')}`);
    const root = await open();
    expect(text(root, 'h3')).toBe('github');
    await followHash('#machines/studio-mac/components/mcp%2Fgone');
    expect(root.textContent).toContain('This component is not on studio-mac any more.');
    await click(root, '[data-catalog-back]');
    expect(root.querySelector('[data-components-page="kinds"]')).not.toBeNull();
  });
});

describe('ComponentsTab — delete (E21)', () => {
  it('is blocked while a profile has it as a layer, then removes it from those and deletes it', async () => {
    const machine = scriptedMachine();
    const root = await open(machine);
    await toDetail(root, 'mcp', 'mcp/github');
    await click(root, '[data-component-delete]');
    const blocked = text(root, '[data-catalog-note="delete"]');
    expect(blocked).toContain('github is in use, so it can’t be deleted');
    expect(blocked).toContain('Profile · Default');
    expect(blocked).toContain('Through those, 2 runtimes use it: claude-default, claude-review.');
    await click(root, '[data-component-keep]');
    expect(root.querySelector('[data-catalog-note="delete"]')).toBeNull();
    await click(root, '[data-component-delete]');
    await click(root, '[data-component-detach]');
    expect(text(root, '[data-catalog-note="delete"]')).toContain('It is taken out of Default first.');
    machine.onApply = current => {
      current.catalog = studioCatalog({ components: componentCatalog() });
    };
    await submit(root);
    expect(stagedChanges(machine)).toEqual([
      { kind: 'component.remove', componentKind: 'mcp', name: 'github', removeFromProfiles: true },
    ]);
    expect(text(root, '[data-components-saved]')).toBe('Deleted github.');
    expect(text(root, 'h3')).toBe('MCP servers');
  });

  it('confirms deleting something nothing uses, and says one runtime in the singular', async () => {
    const lonely = component({
      ...github,
      reference: 'mcp/solo',
      name: 'solo',
      usedBy: { profiles: ['Solo'], runtimes: ['one'] },
    });
    const catalog = studioCatalog({ components: componentCatalog({ mcp: [lonely] }) });
    const solo = {
      ...catalog.profiles.profiles[0],
      name: 'Solo',
      layers: ['mcp/solo'],
    } as (typeof catalog.profiles.profiles)[0];
    const root = await open(
      scriptedMachine({ catalog: { ...catalog, profiles: { ...catalog.profiles, profiles: [solo] } } }),
    );
    await toDetail(root, 'mcp', 'mcp/solo');
    await click(root, '[data-component-delete]');
    expect(text(root, '[data-catalog-note="delete"]')).toContain('1 runtime uses it: one.');
    await click(root, '[data-catalog-back]');
    await click(root, '[data-component-row="mcp/notes"]');
    await click(root, '[data-component-delete]');
    expect(text(root, '[data-catalog-note="delete"]')).toContain('Nothing uses it now.');
    expect(text(root, '[data-change-submit]')).toBe('Delete notes');
  });

  it('keeps the page when the daemon refuses the delete', async () => {
    const machine = scriptedMachine({
      stage: new FyHttpError('This change conflicts with the setup.', 409, 'fleet_change_conflict'),
    });
    const root = await open(machine);
    await toDetail(root, 'mcp', 'mcp/notes');
    await click(root, '[data-component-delete]');
    await submit(root);
    expect(text(root, '[data-change-refusal]')).toContain('conflicts with the setup');
    expect(text(root, 'h3')).toBe('notes');
  });
});

describe('ComponentsTab — edit and new (E20)', () => {
  it('warns that an edit lands everywhere, saves for all, and keeps the environment', async () => {
    const machine = scriptedMachine();
    const root = await open(machine);
    await toDetail(root, 'instructions', 'instructions/Main instructions');
    await click(root, '[data-component-edit]');
    expect(text(root, '[data-catalog-note="used"]')).toContain('Used by 3 profiles and 3 runtimes');
    expect(text(root, '[data-change-submit]')).toBe('Save for all');
    expect(root.querySelector<HTMLInputElement>('[data-component-field="name"]')?.disabled).toBe(true);
    await type(root, '[data-component-field="body"]', 'New text');
    await submit(root);
    expect(stagedChanges(machine)).toEqual([
      {
        kind: 'component.put',
        name: 'Main instructions',
        component: { kind: 'instructions' },
        content: 'New text',
        create: false,
      },
    ]);
    expect(text(root, '[data-components-saved]')).toBe('Saved. New sessions use the new version.');
    expect(text(root, 'h3')).toBe('Main instructions');
  });

  it('saves a component only one place uses with plain Save, and Cancel goes back', async () => {
    const root = await open();
    await toDetail(root, 'mcp', 'mcp/notes');
    await click(root, '[data-component-edit]');
    expect(root.querySelector('[data-catalog-note="used"]')).toBeNull();
    expect(text(root, '[data-change-submit]')).toBe('Save');
    await type(root, '[data-component-field="body"]', ' ');
    expect(text(root, '[data-component-problem]')).toBe('Type the command that starts the server.');
    expect(root.querySelector<HTMLButtonElement>('[data-change-submit]')?.disabled).toBe(true);
    await click(root, '[data-component-cancel]');
    expect(text(root, 'h3')).toBe('notes');
  });

  it('shows a hidden setting as kept as is, and sends it kept', async () => {
    const machine = scriptedMachine();
    const root = await open(machine);
    await toDetail(root, 'settings', 'settings/Claude settings');
    await click(root, '[data-component-edit]');
    expect(text(root, '[data-component-hidden]')).toContain('env.ANTHROPIC_API_KEYhidden · kept as is');
    expect(root.querySelector('[data-component-field="harness"]')).toBeNull();
    await submit(root);
    expect(stagedChanges(machine)[0]).toMatchObject({
      component: { entries: { 'env.ANTHROPIC_API_KEY': { keep: true }, 'permissions.defaultMode': { value: 'plan' } } },
    });
  });

  it('creates a new one in place: names it, picks its tool, and opens it', async () => {
    const machine = scriptedMachine();
    const root = await open(machine);
    await click(root, '[data-component-kind="settings"]');
    await click(root, '[data-component-new="settings"]');
    expect(text(root, 'h3')).toBe('New settings');
    expect(root.textContent).toContain('Secret values go in the secret store');
    await type(root, '[data-component-field="name"]', 'Claude settings');
    expect(root.querySelector('[aria-invalid="true"]')).not.toBeNull();
    expect(root.textContent).toContain('You already have one called Claude settings.');
    await type(root, '[data-component-field="name"]', 'Quiet');
    await choose(root, '[data-component-field="harness"]', 'codex');
    await type(root, '[data-component-field="body"]', 'approval_policy = never');
    const added = component({ ...claudeSettings, reference: 'settings/Quiet', name: 'Quiet', harness: 'codex' });
    machine.onApply = current => {
      current.catalog = studioCatalog({ components: componentCatalog({ settings: [added] }) });
    };
    await submit(root);
    expect(stagedChanges(machine)).toEqual([
      {
        kind: 'component.put',
        name: 'Quiet',
        component: { kind: 'settings', harness: 'codex', entries: { approval_policy: { value: 'never' } } },
        create: true,
      },
    ]);
    expect(text(root, 'h3')).toBe('Quiet');
    expect(text(root, '[data-components-saved]')).toBe('Saved. Add it to a profile to use it.');
  });

  it('offers a model set’s default from the models typed', async () => {
    const machine = scriptedMachine();
    const root = await open(machine);
    await click(root, '[data-component-kind="modelSets"]');
    await click(root, '[data-component-new="modelSets"]');
    expect(root.querySelector('[data-component-field="default"]')).toBeNull();
    await type(root, '[data-component-field="name"]', 'Heavy');
    await type(root, '[data-component-field="body"]', 'claude-opus-5\nclaude-haiku-5');
    await choose(root, '[data-component-field="default"]', 'claude-haiku-5');
    await submit(root);
    expect(stagedChanges(machine)[0]).toMatchObject({
      component: { kind: 'modelSets', models: ['claude-opus-5', 'claude-haiku-5'], default: 'claude-haiku-5' },
    });
    expect([models.name, notes.name]).toHaveLength(2);
  });

  it('pauses writes while the machine is offline', async () => {
    const root = await open(scriptedMachine(), { online: false });
    await toDetail(root, 'mcp', 'mcp/notes');
    await click(root, '[data-component-edit]');
    expect(root.querySelector<HTMLButtonElement>('[data-change-submit]')?.disabled).toBe(true);
  });
});

describe('ComponentsSurface — where a copy came from', () => {
  it('names a cloned component’s source by the label this browser gave that machine', async () => {
    const work = daemonConnection({ daemonId: 'sha256:work', baseUrl: 'https://work.example.test', deviceId: 'd' });
    const connections = new DaemonConnectionStore({
      connections: [{ ...work, label: 'Work laptop', pairedAt: 1, lastSelectedAt: 1 }],
      selectedDaemonId: work.daemonId,
    });
    const copied = component({
      ...notes,
      reference: 'mcp/copied',
      name: 'copied',
      clonedFrom: 'work-mac',
      clonedFromDaemon: 'sha256:work',
    });
    const machine = scriptedMachine({
      catalog: studioCatalog({ components: componentCatalog({ mcp: [copied] }) }),
    });
    mounted = await mountSettled(
      <StoreProvider store={{ connections } as unknown as AppStore}>
        <ComponentsSurface {...tabProps(machine)} />
      </StoreProvider>,
    );
    const root = mounted.container;
    await toDetail(root, 'mcp', 'mcp/copied');
    expect(root.textContent).toContain('Copied from Work laptop');
  });
});
