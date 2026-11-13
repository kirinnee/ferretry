import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { ComponentCatalogSchema, type ComponentView } from '../../../../../../contract/index.ts';
import { ModelSetsTab } from '../../../../../../app/features/fleet/components/model-sets-tab.tsx';
import type { RuntimesClient } from '../../../../../../app/lib/client.ts';
import { type Mounted, mount, must } from '../../../../support/dom.ts';
import { COMMITTED, LANDED_FILE, ROLLBACK_INCOMPLETE, ROLLED_BACK, UNRESTORED_PATH } from '../account-support.ts';
import { refusal } from '../runtimes/support-b.ts';
import { component, componentCatalog, models, notes, studioCatalog } from './catalog-fixture.ts';
import {
  choose,
  click,
  type Machine,
  mountSettled,
  scriptedMachine,
  stagedChanges,
  submit,
  TAB_PATH,
  tabProps,
  text,
  type,
} from './view-support.tsx';

/**
 * Today's Components tab drew all six kinds; Runtimes draws only the model sets (the other kinds are the Instructions,
 * MCP, Skills, Settings and Hooks plugins' tabs). Each case below is today's case with a model set in the place of the
 * component, and the cases that are about another kind are skipped with the plugin that now owns them.
 */

let mounted: Mounted | undefined;
beforeEach(() => window.history.replaceState(null, '', `${TAB_PATH.replace('/profiles', '/model-sets')}`));
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  window.history.replaceState(null, '', '/');
});

const open = async (machine: Machine = scriptedMachine(), overrides: Parameters<typeof tabProps>[1] = {}) => {
  mounted = await mountSettled(<ModelSetsTab {...tabProps(machine, overrides)} />);
  return mounted.container;
};

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

const toDetail = async (root: HTMLElement, reference = 'modelSets/Claude models') =>
  await click(root, `[data-component-row="${reference}"]`);

describe('ModelSetsTab — reading', () => {
  it('lists the model sets with their badges and use, and opens one to its page', async () => {
    const root = await open();
    expect(text(root, 'h3')).toBe('Model sets');
    expect(root.querySelectorAll('[data-component-row]')).toHaveLength(1);
    expect(text(root, '[data-component-row="modelSets/Claude models"]')).toContain('Used by 0 profiles, 0 runtimes');
    expect(root.textContent).not.toContain('Main instructions');
    await toDetail(root);
    expect(text(root, 'h3')).toBe('Claude models');
    await click(root, '[data-catalog-back]');
    expect(root.querySelector('[data-components-page="list"]')).not.toBeNull();
  });

  it('shows the use of a model set the profiles and runtimes reach', async () => {
    const root = await open(scriptedMachine({ catalog: withModelSets(used()) }));
    expect(text(root, '[data-component-row="modelSets/Claude models"]')).toContain('Used by 2 profiles, 2 runtimes');
  });

  it('says there are none yet, and falls back to its own words for a kind the daemon did not list', async () => {
    const empty = await open(scriptedMachine({ catalog: withModelSets() }));
    expect(text(empty, 'h3')).toBe('Model sets');
    expect(empty.textContent).toContain('None saved yet.');
    await mounted?.unmount();
    const unlisted = await open(
      scriptedMachine({
        catalog: studioCatalog({
          components: ComponentCatalogSchema.parse({
            format: 'present',
            kinds: componentCatalog().kinds.filter(group => group.kind !== 'modelSets'),
          }),
        }),
      }),
    );
    expect(text(unlisted, 'h3')).toBe('Model sets');
    expect(unlisted.textContent).toContain('None saved yet.');
    expect(unlisted.querySelector('[data-component-new="modelSets"]')).not.toBeNull();
  });

  it('says why when the catalogue cannot be read, and reads again on Try again', async () => {
    const machine = scriptedMachine({ readFails: refusal('nope', 403, 'grant_refused') });
    const root = await open(machine);
    expect(text(root, '[data-catalog-note="read-failed"]')).toContain('did not share its setup: nope');
    machine.readFails = undefined;
    await click(root, '[data-catalog-retry]');
    expect(root.querySelector('[data-component-row]')).not.toBeNull();
    await mounted?.unmount();
    const offline = await open(scriptedMachine({ readFails: new Error('down') }));
    expect(offline.textContent).toContain('did not answer');
  });

  it('shows Reading… until the catalogue answers', async () => {
    const never: RuntimesClient = { call: () => new Promise(() => undefined) };
    mounted = await mount(<ModelSetsTab {...tabProps(scriptedMachine(), { client: never })} />);
    expect(mounted.container.textContent).toContain('Reading studio-mac’s model sets…');
  });
});

describe('ModelSetsTab — a model set’s page', () => {
  it.skip('shows an MCP server’s command, environment, warnings, the path to check and who uses it … pending port: MCP plugin', () => {});

  it('links each profile that uses it to the Profiles tab by its Settings path, saying how it reaches the profile', async () => {
    const root = await open(scriptedMachine({ catalog: withModelSets(used()) }));
    await toDetail(root);
    expect(root.textContent).toContain('Used by 2 profiles and 2 runtimes.');
    const links = [...root.querySelectorAll('[data-catalog-link]')];
    expect(links.map(link => link.textContent)).toEqual([
      expect.stringContaining('Has it as a layer'),
      expect.stringContaining('Gets it through a base profile'),
    ]);
    expect(links[0]?.getAttribute('href')).toBe(
      '/d/d1/settings/runtimes/profiles#machines/studio-mac/profiles/Default',
    );
    await click(root, '[data-catalog-link$="Default"]');
    expect(window.location.pathname).toBe('/d/d1/settings/runtimes/profiles');
    expect(window.location.hash).toBe('#machines/studio-mac/profiles/Default');
  });

  it.skip('shows skills with partial support, settings with a hidden value and flags … pending port: Skills and Settings plugins', () => {});

  it('shows a model set’s models with the default marked, and nothing the daemon adapts', async () => {
    const root = await open();
    await toDetail(root);
    expect(root.textContent).toContain('claude-opus-5');
    expect(root.textContent).toContain('claude-sonnet-5Default');
    expect(root.textContent).not.toContain('Ferretry adapts this');
  });

  it.skip('shows hooks content … pending port: Hooks plugin', () => {});
  it.skip('reads instructions as Markdown — headings, lists, code — with no raw HTML, and View source shows the text … pending port: Instructions plugin', () => {});
  it.skip('says what it cannot show: an empty settings file, a hooks folder, unreadable text … pending port: Settings, Hooks and Instructions plugins', () => {});
  it.skip('opens the page a link names, and says when it is gone … pending port: an address reader for the Model sets tab (nothing links to a model set by address yet)', () => {});
});

describe('ModelSetsTab — delete (E21)', () => {
  it('is blocked while a profile has it as a layer, then removes it from those and deletes it', async () => {
    const machine = scriptedMachine({ catalog: withModelSets(used()) });
    const root = await open(machine);
    await toDetail(root);
    await click(root, '[data-component-delete]');
    const blocked = text(root, '[data-catalog-note="delete"]');
    expect(blocked).toContain('Claude models is in use, so it can’t be deleted');
    expect(blocked).toContain('Profile · Default');
    expect(blocked).toContain('Through those, 2 runtimes use it: claude-default, claude-review.');
    await click(root, '[data-component-keep]');
    expect(root.querySelector('[data-catalog-note="delete"]')).toBeNull();
    await click(root, '[data-component-delete]');
    await click(root, '[data-component-detach]');
    expect(text(root, '[data-catalog-note="delete"]')).toContain('It is taken out of Default first.');
    machine.onApply = current => {
      current.catalog = withModelSets();
    };
    await submit(root);
    expect(stagedChanges(machine)).toEqual([
      { kind: 'component.remove', componentKind: 'modelSets', name: 'Claude models', removeFromProfiles: true },
    ]);
    expect(text(root, '[data-components-saved]')).toBe('Deleted Claude models.');
    expect(text(root, 'h3')).toBe('Model sets');
  });

  it('confirms deleting something nothing uses, and says one runtime in the singular', async () => {
    const lonely = component({
      ...models,
      reference: 'modelSets/Solo',
      name: 'Solo',
      usedBy: { profiles: ['Solo'], runtimes: ['one'] },
    });
    const base = withModelSets(lonely, component({ ...models, reference: 'modelSets/Spare', name: 'Spare' }));
    const solo = {
      ...base.profiles.profiles[0],
      name: 'Solo',
      layers: ['modelSets/Solo'],
    } as (typeof base.profiles.profiles)[0];
    const root = await open(
      scriptedMachine({ catalog: { ...base, profiles: { ...base.profiles, profiles: [solo] } } }),
    );
    await toDetail(root, 'modelSets/Solo');
    await click(root, '[data-component-delete]');
    expect(text(root, '[data-catalog-note="delete"]')).toContain('1 runtime uses it: one.');
    await click(root, '[data-catalog-back]');
    await click(root, '[data-component-row="modelSets/Spare"]');
    await click(root, '[data-component-delete]');
    expect(text(root, '[data-catalog-note="delete"]')).toContain('Nothing uses it now.');
    expect(text(root, '[data-change-submit]')).toBe('Delete Spare');
  });

  it('keeps the page when the daemon refuses the delete', async () => {
    const spare = component({ ...models, reference: 'modelSets/Spare', name: 'Spare' });
    const machine = scriptedMachine({
      catalog: withModelSets(spare),
      stage: refusal('This change conflicts with the setup.', 409, 'fleet_change_conflict'),
    });
    const root = await open(machine);
    await toDetail(root, 'modelSets/Spare');
    await click(root, '[data-component-delete]');
    await submit(root);
    expect(text(root, '[data-change-refusal]')).toContain('conflicts with the setup');
    expect(text(root, 'h3')).toBe('Spare');
  });
});

describe('ModelSetsTab — R3-M1 a rolled-back or half-restored apply is not a save', () => {
  for (const [what, applied, expected] of [
    ['rolled-back', ROLLED_BACK, [LANDED_FILE, 'rolled back']],
    ['rollback-incomplete', ROLLBACK_INCOMPLETE, [LANDED_FILE, UNRESTORED_PATH, 'needs a look']],
  ] as const) {
    it(`R3-M1: a ${what} delete does not say Deleted, names the files, and stays on the model set`, async () => {
      const spare = component({ ...models, reference: 'modelSets/Spare', name: 'Spare' });
      const machine = scriptedMachine({ catalog: withModelSets(spare), applied });
      const root = await open(machine);
      await toDetail(root, 'modelSets/Spare');
      await click(root, '[data-component-delete]');
      await submit(root);
      const alert = must(root.querySelector('[data-catalog-note="delete"] [data-change-refusal]'), 'alert');
      expect(alert.getAttribute('role')).toBe('alert');
      for (const part of expected) expect(alert.textContent).toContain(part);
      expect(root.querySelector('[data-components-saved]')).toBeNull();
      expect(text(root, 'h3')).toBe('Spare');
    });

    it(`R3-M1: a ${what} save keeps the form open, names the files, and never says Saved`, async () => {
      const machine = scriptedMachine({ catalog: withModelSets(models), applied });
      const root = await open(machine);
      await toDetail(root, 'modelSets/Claude models');
      await click(root, '[data-component-edit]');
      await type(root, '[data-component-field="body"]', 'claude-opus-5\nclaude-haiku-5');
      await submit(root);
      const alert = must(root.querySelector('[data-change-refusal]'), 'alert');
      expect(alert.getAttribute('role')).toBe('alert');
      for (const part of expected) expect(alert.textContent).toContain(part);
      expect(root.querySelector('[data-components-saved]')).toBeNull();
      expect(text(root, 'h3')).toBe('Edit Claude models');
    });
  }

  it('R3-M1: a finished apply still closes the form as saved', async () => {
    const machine = scriptedMachine({ catalog: withModelSets(models), applied: COMMITTED });
    const root = await open(machine);
    await toDetail(root, 'modelSets/Claude models');
    await click(root, '[data-component-edit]');
    await type(root, '[data-component-field="body"]', 'claude-opus-5\nclaude-haiku-5');
    await submit(root);
    expect(text(root, '[data-components-saved]')).toBe('Saved. New sessions use the new version.');
    expect(root.querySelector('[data-change-refusal]')).toBeNull();
  });
});

describe('ModelSetsTab — edit and new (E20)', () => {
  it('warns that an edit lands everywhere, saves for all, and keeps the name', async () => {
    const machine = scriptedMachine({
      catalog: withModelSets(used({ usedBy: { profiles: ['A', 'B', 'C'], runtimes: ['x', 'y', 'z'] } })),
    });
    const root = await open(machine);
    await toDetail(root);
    await click(root, '[data-component-edit]');
    expect(text(root, '[data-catalog-note="used"]')).toContain('Used by 3 profiles and 3 runtimes');
    expect(text(root, '[data-change-submit]')).toBe('Save for all');
    expect(root.querySelector<HTMLInputElement>('[data-component-field="name"]')?.disabled).toBe(true);
    await type(root, '[data-component-field="body"]', 'claude-opus-5\nclaude-haiku-5');
    await choose(root, '[data-component-field="default"]', 'claude-haiku-5');
    await submit(root);
    expect(stagedChanges(machine)).toEqual([
      {
        kind: 'component.put',
        name: 'Claude models',
        component: { kind: 'modelSets', models: ['claude-opus-5', 'claude-haiku-5'], default: 'claude-haiku-5' },
        create: false,
      },
    ]);
    expect(text(root, '[data-components-saved]')).toBe('Saved. New sessions use the new version.');
    expect(text(root, 'h3')).toBe('Claude models');
  });

  it('saves a model set only one place uses with plain Save, and Cancel goes back', async () => {
    const root = await open();
    await toDetail(root);
    await click(root, '[data-component-edit]');
    expect(root.querySelector('[data-catalog-note="used"]')).toBeNull();
    expect(text(root, '[data-change-submit]')).toBe('Save');
    await type(root, '[data-component-field="body"]', ' ');
    expect(text(root, '[data-component-problem]')).toBe('Add at least one model.');
    expect(root.querySelector<HTMLButtonElement>('[data-change-submit]')?.disabled).toBe(true);
    await click(root, '[data-component-cancel]');
    expect(text(root, 'h3')).toBe('Claude models');
  });

  it.skip('shows a hidden setting as kept as is, and sends it kept … pending port: Settings plugin', () => {});

  it('creates a new one in place: names it, offers its default, and opens it', async () => {
    const machine = scriptedMachine();
    const root = await open(machine);
    await click(root, '[data-component-new="modelSets"]');
    expect(text(root, 'h3')).toBe('New model set');
    await type(root, '[data-component-field="name"]', 'Claude models');
    expect(root.querySelector('[aria-invalid="true"]')).not.toBeNull();
    expect(root.textContent).toContain('You already have one called Claude models.');
    await type(root, '[data-component-field="name"]', 'Quiet');
    await type(root, '[data-component-field="body"]', 'claude-haiku-5');
    const added = component({
      ...models,
      reference: 'modelSets/Quiet',
      name: 'Quiet',
      detail: { kind: 'modelSets', models: ['claude-haiku-5'], default: 'claude-haiku-5' },
    });
    machine.onApply = current => {
      current.catalog = withModelSets(models, added);
    };
    await submit(root);
    expect(stagedChanges(machine)).toEqual([
      {
        kind: 'component.put',
        name: 'Quiet',
        component: { kind: 'modelSets', models: ['claude-haiku-5'], default: 'claude-haiku-5' },
        create: true,
      },
    ]);
    expect(text(root, 'h3')).toBe('Quiet');
    expect(text(root, '[data-components-saved]')).toBe('Saved. Add it to a profile to use it.');
  });

  it('goes back from a new model set to the list', async () => {
    const root = await open();
    await click(root, '[data-component-new="modelSets"]');
    expect(text(root, 'h3')).toBe('New model set');
    await click(root, '[data-component-cancel]');
    expect(root.querySelector('[data-components-page]')?.getAttribute('data-components-page')).toBe('list');
    expect(root.querySelector('[data-component-new="modelSets"]')).not.toBeNull();
  });

  it('offers a model set’s default from the models typed', async () => {
    const machine = scriptedMachine();
    const root = await open(machine);
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
    await toDetail(root);
    await click(root, '[data-component-edit]');
    expect(root.querySelector<HTMLButtonElement>('[data-change-submit]')?.disabled).toBe(true);
  });
});

describe('ModelSetsTab — where a copy came from', () => {
  it('names a cloned model set’s source by the label this browser gave that machine', async () => {
    const copied = component({
      ...models,
      reference: 'modelSets/Copied',
      name: 'Copied',
      clonedFrom: 'work-mac',
      clonedFromDaemon: 'sha256:work',
    });
    const machine = scriptedMachine({ catalog: withModelSets(copied) });
    mounted = await mountSettled(
      <ModelSetsTab {...tabProps(machine)} machineNames={new Map([['sha256:work', 'Work laptop']])} />,
    );
    const root = mounted.container;
    await toDetail(root, 'modelSets/Copied');
    expect(root.textContent).toContain('Copied from Work laptop');
  });
});

describe('ModelSetsTab — a server that signs in with OAuth', () => {
  it.skip('shows its address and where its sign-in stands, and no sign-in for a command server … pending port: MCP plugin', () => {});
  it.skip('keeps auth: oauth through an edit, and drops it when the switch is turned off … pending port: MCP plugin', () => {});
  it.skip('offers the switch on a new server only once it is a web address … pending port: MCP plugin', () => {});
});

describe('ModelSetsTab — where each MCP server stands', () => {
  it.skip('gives each MCP row its status and Check, and checks it the way a ferret on the machine would … pending port: MCP plugin', () => {});
  it.skip('says a server its runtimes have not picked up yet has nothing to check … pending port: MCP plugin', () => {});
  it.skip('says a failed check and a failed status read in plain words, the raw text behind Details … pending port: MCP plugin', () => {});
  it.skip('offers Sign in on the row of a server that must sign in, and Check on its page beside the Sign-in section … pending port: MCP plugin', () => {});
});
