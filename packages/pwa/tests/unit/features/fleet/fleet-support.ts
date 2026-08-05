/**
 * Fixtures and DOM helpers shared by the fleet configuration suites.
 *
 * The daemon shapes are written out longhand rather than generated, because these tests exist to catch
 * the day the daemon's answer changes shape — a fixture derived from the same schema the surface parses
 * with could never fail that way.
 */

import type {
  FleetAssetIndex,
  FleetConfigView,
  FleetManifestAccountView,
  FleetManifestSummary,
  FleetPermissions,
  FleetProposalPreview,
  FleetProposalView,
} from '../../../../src/features/fleet/fleet-api.ts';
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

export const permissions = (overrides: Partial<FleetPermissions> = {}): FleetPermissions => ({
  mayInspect: true,
  mayPropose: true,
  mayApplyDirectly: false,
  mayApplyWithApproval: true,
  approvalCommand: 'fy fleet authorize',
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
