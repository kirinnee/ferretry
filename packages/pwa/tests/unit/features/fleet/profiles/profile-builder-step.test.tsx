import { afterEach, describe, expect, it } from 'bun:test';
import { BuildProfileStep } from '../../../../../src/features/fleet/profiles/profile-builder-step.tsx';
import { buildProfileFlowInput } from '../../../../../src/features/fleet/profiles/profile-model.ts';
import {
  currentFlow,
  openSubStepper,
  type StepperState,
  startStepper,
} from '../../../../../src/features/fleet/shell/stepper-model.ts';
import { type Mounted, mount } from '../../../../support/dom.ts';
import { profile, profileCatalog, stack, studioCatalog } from '../components/catalog-fixture.ts';
import {
  click,
  type Machine,
  mountSettled,
  scriptedMachine,
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
});

/** Add runtime with Build a profile opened on top of it. */
const stacked = (): StepperState =>
  openSubStepper(
    startStepper({
      kind: 'add-runtime',
      title: 'Add a runtime',
      steps: [{ id: 'profile', label: 'Profile' }],
      leave: { question: 'Stop?', consequence: 'Nothing.', stopLabel: 'Stop' },
    }),
    buildProfileFlowInput({ harness: 'claude' }),
  );

const built: { name: string; next: StepperState | null }[] = [];

const openStep = async (machine: Machine, element: 'settled' | 'pending' = 'settled') => {
  built.length = 0;
  const props = tabProps(machine);
  const step = (
    <BuildProfileStep
      state={stacked()}
      onChange={() => undefined}
      onBuilt={(name, next) => built.push({ name, next })}
      machine={props.machine}
      machineName={props.machineName}
      connection={props.connection}
      createClient={element === 'pending' ? () => new Promise(() => undefined) : props.createClient}
      harness="claude"
      openedFromAddRuntime
    />
  );
  mounted = element === 'pending' ? await mount(step) : await mountSettled(step);
  return mounted.container;
};

describe('BuildProfileStep — Add runtime’s "+ Build a new profile"', () => {
  it('builds with the same editor, for the login’s tool, and hands back the profile with the flow ended', async () => {
    const machine = scriptedMachine({
      preview: { harnesses: [stack('claude'), stack('codex')], scope: { kind: 'scoped', scope: 'generic' } },
      catalog: studioCatalog({
        profiles: profileCatalog([
          ...profileCatalog().profiles,
          profile('Codex', ['mcp/github'], { scope: { kind: 'scoped', scope: 'codex' } }),
        ]),
      }),
    });
    const root = await openStep(machine);
    expect(root.querySelector('[data-build-step="build"] [data-profile-editor=""]')).not.toBeNull();
    expect(text(root, '[data-profile-scope]')).toContain('for a Claude Code login');
    expect(root.textContent).toContain('you go back to choosing a profile, with this one picked');
    await click(root, '[data-library-add="profile/Codex"]');
    expect(text(root, '[data-catalog-note="refused"] p')).toBe(
      'Refused: Codex is Codex only, but this profile is for a Claude Code login.',
    );
    await type(root, '[data-profile-name]', 'Fresh');
    await click(root, '[data-library-add="mcp/github"]');
    await submit(root);
    expect(stagedChanges(machine)).toEqual([
      { kind: 'profile.put', name: 'Fresh', layers: ['mcp/github'], create: true },
    ]);
    expect(built).toHaveLength(1);
    const [done] = built;
    expect(done?.name).toBe('Fresh');
    const parent = currentFlow(done?.next as StepperState);
    expect(parent.kind).toBe('add-runtime');
    expect(parent.saved).toEqual(['Profile Fresh']);
  });

  it('reads first, and says why when the read fails', async () => {
    const pending = await openStep(scriptedMachine(), 'pending');
    expect(pending.textContent).toContain('Reading studio-mac’s profiles and components…');
    await mounted?.unmount();
    mounted = undefined;
    const root = await openStep(scriptedMachine({ readFails: new Error('down') }));
    expect(root.textContent).toContain('did not answer');
    await click(root, '[data-catalog-retry]');
  });
});
