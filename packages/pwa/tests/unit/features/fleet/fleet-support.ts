/**
 * Fixtures and DOM helpers shared by the fleet configuration suites.
 *
 * The daemon shapes are written out longhand rather than generated, because these tests exist to catch
 * the day the daemon's answer changes shape — a fixture derived from the same schema the surface parses
 * with could never fail that way.
 */

import type { GrantUnlockView } from '@ferretry/protocol';
import type {
  FleetAssetIndex,
  FleetConfigView,
  FleetManifestAccountView,
  FleetManifestSummary,
  FleetPermissions,
  FleetProposalPreview,
  FleetProposalView,
  HarnessDiscovery,
  HarnessDiscoveryReport,
} from '../../../../src/features/fleet/fleet-api.ts';
import type { FleetStagedChange } from '../../../../src/features/fleet/fleet-change-review.tsx';
import { interact, must } from '../../../support/dom.ts';

/** The shared account shape, so a fixture cannot drift from what the daemon actually sends. */
export type FleetAccountFixture = FleetManifestAccountView;

export const account = (overrides: Partial<FleetAccountFixture> = {}): FleetAccountFixture => ({
  id: '11111111-1111-4111-8111-111111111111',
  kind: 'claude',
  mode: 'auto',
  wrapper: 'claude-studio',
  home: '/home/pilot/.ferretry/fleet/homes/claude-studio',
  displayName: 'Studio Claude',
  defaultModel: 'claude-opus-5',
  models: [{ id: 'claude-opus-5', available: true }],
  available: true,
  unavailableReason: null,
  ...overrides,
});

/**
 * Every fixture is TYPED as the shape the surface parses, so a suite cannot cast past the contract it
 * exists to pin. The values are still written out longhand — a fixture derived from the schema could
 * never fail on the day the daemon's answer changes.
 */
export const manifest = (accounts: readonly FleetAccountFixture[] = [account()]): FleetManifestSummary => ({
  version: 1,
  generatedAt: '2026-08-05T06:00:00.000Z',
  accounts,
});

export const config = (
  routes: Readonly<Record<string, { id: string; wrapper: string; layer?: Record<string, unknown> }>> = {
    default: { id: account().id, wrapper: 'claude-studio' },
  },
): FleetConfigView => ({
  variants: { default: {} },
  agents: [{ name: 'studio', kind: 'claude' as const, routes }],
});

/** A parsed asset index, so a suite pins the shared shape rather than casting past it. */
export const assetIndex = (files: FleetAssetIndex['files'], complete = true): FleetAssetIndex => ({ files, complete });

/** One harness as the daemon's discovery reports it. Typed, so a fixture cannot outgrow the contract. */
export const harness = (overrides: Partial<HarnessDiscovery> = {}): HarnessDiscovery => ({
  kind: 'claude',
  command: '/usr/local/bin/claude',
  absenceImpact: 'No Claude session can start here.',
  models: {
    origin: 'detected',
    ids: ['claude-opus-5', 'claude-sonnet-5'],
    defaultModel: 'claude-opus-5',
    source: '/home/pilot/.claude/settings.json',
  },
  instructions: { found: true, source: '/home/pilot/.claude/CLAUDE.md', text: '# House rules\n', bytes: 14 },
  ...overrides,
});

/**
 * The asymmetric host, because it is the common one AND the interesting one: Claude installed with a
 * detected model and an importable document, Codex absent and falling back to the starter model.
 *
 * A fixture where both harnesses look identical could not fail on the one thing this form does — tell
 * them apart and say which is which.
 */
export const discovery = (
  harnesses: readonly HarnessDiscovery[] = [harness(), absentCodex()],
): HarnessDiscoveryReport => ({
  // Copied, because the parsed wire shape is a mutable array and a fixture must be assignable to it.
  harnesses: [...harnesses],
  noneInstalled: harnesses.every(entry => entry.command === undefined),
  limitation: 'A PATH lookup proves nothing about being signed in.',
});

export function absentCodex(overrides: Partial<HarnessDiscovery> = {}): HarnessDiscovery {
  return {
    kind: 'codex',
    absenceImpact: 'No Codex session can start here.',
    models: {
      origin: 'fallback',
      ids: ['gpt-5.6'],
      defaultModel: 'gpt-5.6',
      source: 'Ferretry’s starter model for codex, because there is no /home/pilot/.codex/config.toml on this host',
    },
    instructions: {
      found: false,
      source: '/home/pilot/.codex/AGENTS.md',
      reason: 'this host has no AGENTS.md there',
    },
    ...overrides,
  };
}

/**
 * What this caller may do, defaulting to the UNGOVERNED answer.
 *
 * The default is the owner's own case and the common one: a loopback caller, or a local browser that has
 * already unlocked. It used to default to `mayApplyWithApproval`, so every suite that did not say
 * otherwise was asserting against the two-gate panel — which is how a screen nobody wanted stayed
 * pinned by its own tests.
 */
export const permissions = (overrides: Partial<FleetPermissions> = {}): FleetPermissions => ({
  mayInspect: true,
  mayPropose: true,
  mayApply: true,
  applyRefusal: 'ungated',
  confirmation: 'none',
  ...overrides,
});

/** A caller the operator's grants still govern on a machine with a password: apply asks for it once. */
export const confirmingPermissions = (overrides: Partial<FleetPermissions> = {}): FleetPermissions =>
  permissions({ applyRefusal: 'granted', confirmation: 'operator-password', ...overrides });

/**
 * A caller refused until it unlocks, which is the owner's complaint.
 *
 * `confirmation: 'operator-password'` alongside `locked` is the case the one-password rule exists for: a
 * remote caller on a machine with a password is BOTH, and one typed value has to serve both steps.
 */
export const lockedPermissions = (overrides: Partial<FleetPermissions> = {}): FleetPermissions =>
  permissions({ mayApply: false, applyRefusal: 'locked', confirmation: 'operator-password', ...overrides });

/**
 * A minted unlock, as `POST /v1/grants/unlock` answers.
 *
 * The SHARED shape, because the fleet panel now mints through the same route the grants surface does —
 * a fixture of its own here would be a second idea of what an unlock is.
 */
export const unlockView = (overrides: Partial<GrantUnlockView> = {}): GrantUnlockView => ({
  // The shared grammar requires the prefix and 22 characters after it, so a placeholder must satisfy it.
  token: `fy_unlock_${'A'.repeat(22)}`,
  expiresAt: '2026-08-05T06:05:00.000Z',
  ttlSeconds: 300,
  ...overrides,
});

/** The plan half of an `apply` preview, typed through the shared preview union. */
type FleetPlanFixture = Extract<FleetProposalPreview, { kind: 'apply' }>['plan'];

export const plan = (accounts: readonly FleetAccountFixture[] = [account()]): FleetPlanFixture => ({
  manifestPath: '/home/pilot/.ferretry/fleet/manifest.json',
  manifest: manifest(accounts),
  // No `content`: the shared operation schema deliberately omits a wrapper's script, because nobody
  // reads thousands of bytes in a review and shipping it would dominate the payload.
  operations: [
    { kind: 'directory', path: '/home/pilot/.ferretry/fleet/homes/claude-studio', mode: 448 },
    { kind: 'file', path: '/home/pilot/.ferretry/fleet/bin/claude-studio', mode: 493 },
    { kind: 'copy', source: '/assets/instructions/studio.md', path: '/homes/claude-studio/CLAUDE.md' },
  ],
  sharedHistory: [{ kind: 'claude', pool: '/pool/claude', migrated: 2, conflicts: 1, links: 3 }],
});

/** A valid account id: the shared schema requires a real UUID, so a fixture must supply one. */
export const accountId = (seed: number): string => `${String(seed).padStart(8, '0')}-1111-4111-8111-111111111111`;

/**
 * A held proposal. TYPED, so an override that misspells a field stops compiling rather than silently
 * doing nothing — `proposal({ stat: 'consumed' })` used to be accepted and ignored.
 */
export const proposal = (overrides: Partial<FleetProposalView> = {}): FleetProposalView => ({
  id: 'fy_fprop_AAAAAAAAAAAAAAAAAAAAAA',
  revision: 'a1b2c3',
  mutation: { kind: 'edit-account', accountId: account().id, layer: {} },
  summary: 'add claude-studio',
  expiresAt: '2026-08-05T06:15:00.000Z',
  state: 'pending',
  assetEdits: [{ path: 'instructions/studio.md', bytes: 12 }],
  preview: {
    kind: 'apply',
    plan: plan(),
    // The configuration rewrite and the asset text are writes too, and the daemon names both.
    documents: [
      { path: '/home/pilot/.ferretry/fleet/config.yaml', bytes: 512 },
      { path: '/home/pilot/.ferretry/fleet/assets/instructions/studio.md', bytes: 12 },
    ],
  },
  ...overrides,
});

/**
 * The same fixture, narrowed to a change that HAS A PLAN.
 *
 * The review panel takes exactly that now: a first run is a different operation with a different panel,
 * so the type says which one this is rather than the component branching on it at render time.
 */
export const stagedChange = (overrides: Partial<FleetProposalView> = {}): FleetStagedChange => {
  const view = proposal(overrides);
  if (view.preview.kind !== 'apply') throw new Error('a staged-change fixture must carry a plan');
  return { ...view, preview: view.preview };
};

/** What a first run creates, as the daemon's own initialize preview carries it. */
export const scaffoldPreview = (): Extract<FleetProposalPreview, { kind: 'initialize' }> => {
  const preview = scaffoldProposal().preview;
  if (preview.kind !== 'initialize') throw new Error('the first-run fixture must carry a scaffold');
  return preview;
};

export const scaffoldProposal = (): FleetProposalView =>
  proposal({
    summary: 'prepare this host for a fleet',
    assetEdits: [],
    preview: {
      kind: 'initialize',
      scaffold: {
        directories: ['/home/pilot/.ferretry/fleet', '/home/pilot/.ferretry/fleet/bin'],
        files: [{ path: '/home/pilot/.ferretry/fleet/config.yaml' }],
        pathEntry: 'export PATH="$HOME/.ferretry/fleet/bin:$PATH"',
      },
      documents: [],
    },
  });

// ─── DOM helpers ──────────────────────────────────────────────────────────────────────────────

/**
 * React remembers the last value it wrote on the node, so assigning `.value` directly is invisible to
 * it. Writing through the prototype setter is what a real keystroke does.
 */
const setValue = <T extends HTMLElement>(prototype: object, node: T, value: string): void => {
  Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(node, value);
};

/**
 * Controls are found by the SUFFIX of their id.
 *
 * The ids are instance-scoped with `useId()`, because two copies of a layer form mount together in the
 * harness gallery and hard-coded global ids broke `<label for>` there — clicking one form's label
 * focused the other form's input. The prefix is therefore a React-generated value no test may spell,
 * and a suffix match is what remains: `[id$="-instructions-path"]`.
 */
const suffix = (id: string): string => `[id$="${id}"]`;

export const field = (container: HTMLElement, id: string): HTMLInputElement =>
  must(container.querySelector<HTMLInputElement>(suffix(id)), `the ${id} field`);

export const area = (container: HTMLElement, id: string): HTMLTextAreaElement =>
  must(container.querySelector<HTMLTextAreaElement>(suffix(id)), `the ${id} textarea`);

export const chooser = (container: HTMLElement, id: string): HTMLSelectElement =>
  must(container.querySelector<HTMLSelectElement>(suffix(id)), `the ${id} chooser`);

export const type = async (node: HTMLInputElement | HTMLTextAreaElement, value: string): Promise<void> => {
  await interact(() => {
    setValue(
      node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
      node,
      value,
    );
    node.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

export const choose = async (node: HTMLSelectElement, value: string): Promise<void> => {
  await interact(() => {
    setValue(HTMLSelectElement.prototype, node, value);
    node.dispatchEvent(new Event('change', { bubbles: true }));
  });
};

export const click = async (node: HTMLElement): Promise<void> => {
  await interact(() => node.click());
};

export const button = (container: HTMLElement, text: string): HTMLButtonElement =>
  must(
    [...container.querySelectorAll('button')].find(candidate => candidate.textContent?.includes(text)),
    `the "${text}" button`,
  );

/** React listens at the root container, so a bubbling submit is what a real one looks like. */
export const submit = async (form: HTMLFormElement): Promise<void> => {
  await interact(() => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
};

export const form = (container: HTMLElement, selector: string): HTMLFormElement =>
  must(container.querySelector<HTMLFormElement>(selector), `the ${selector} form`);

export const pick = (container: HTMLElement, selector: string): HTMLElement =>
  must(container.querySelector<HTMLElement>(selector), `an element matching ${selector}`);

export const absent = (container: HTMLElement, selector: string): boolean => container.querySelector(selector) === null;

/**
 * The operator password field, wherever the SHARED prompt puts it.
 *
 * `[data-grant-unlock-field]` rather than a fleet-specific hook, because there is one prompt now and the
 * grants panel raises the same one. A fleet-private selector here would be the first step back to two.
 */
export const unlockField = (container: HTMLElement): HTMLInputElement =>
  must(container.querySelector<HTMLInputElement>('[data-grant-unlock-field]'), 'the operator password field');

/** Types the password into the raised prompt and submits it, which is what a person does. */
export const unlockWith = async (container: HTMLElement, password: string): Promise<void> => {
  await type(unlockField(container), password);
  await click(must(container.querySelector<HTMLElement>('[data-operator-unlock-submit]'), 'the unlock button'));
};

// ─── driving the new-account stepper ──────────────────────────────────────────────────────────

/** Which question the open stepper is showing. */
export const stepperStep = (container: HTMLElement): string =>
  pick(container, '[data-fleet-account-stepper]').getAttribute('data-fleet-account-stepper') ?? '';

/**
 * The input inside one card of a radio or checkbox group.
 *
 * The card is a `<label>` wrapping an `sr-only` input, so a person clicks the card and the platform
 * changes the input. A test clicks the INPUT, which is what the card's click resolves to anyway —
 * going through the label would only prove happy-dom forwards label clicks.
 */
export const card = (container: HTMLElement, group: string, id: string): HTMLInputElement =>
  must(
    container.querySelector<HTMLInputElement>(
      `[data-fleet-choice-group="${group}"] [data-fleet-choice="${id}"] input, [data-fleet-check-group="${group}"] [data-fleet-check="${id}"] input`,
    ),
    `the "${id}" card in the ${group} group`,
  );

/** Whether that card reads as chosen, from the attribute it renders rather than from a class. */
export const cardChosen = (container: HTMLElement, group: string, id: string): boolean => {
  const node = must(
    container.querySelector<HTMLElement>(
      `[data-fleet-choice-group="${group}"] [data-fleet-choice="${id}"], [data-fleet-check-group="${group}"] [data-fleet-check="${id}"]`,
    ),
    `the "${id}" card in the ${group} group`,
  );
  return (
    node.getAttribute('data-fleet-choice-selected') === 'true' ||
    node.getAttribute('data-fleet-check-selected') === 'true'
  );
};

/** Press Next once, which is the only way forward through the sequence. */
export const next = async (container: HTMLElement): Promise<void> => {
  await click(button(container, 'Next'));
};

/**
 * Walk forward to a named step.
 *
 * Forward only, and one press at a time, because that is the whole claim being tested: a step a draft
 * cannot leave stops the walk here rather than somewhere later. A step that will not advance therefore
 * fails with the step it stuck on rather than with a missing element three screens away.
 */
export const walkTo = async (container: HTMLElement, step: string): Promise<void> => {
  for (let pressed = 0; pressed < 8; pressed += 1) {
    if (stepperStep(container) === step) return;
    await next(container);
  }
  throw new Error(`the stepper stopped at "${stepperStep(container)}" and never reached "${step}"`);
};
