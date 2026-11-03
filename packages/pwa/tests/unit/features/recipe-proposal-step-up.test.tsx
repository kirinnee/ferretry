/**
 * Approving a ferret's recipe from a paired device, through the app's real carrier and store: the daemon refuses with
 * `403 grant_step_up_required` naming `approve-recipe` and the proposal, the passkey options are asked for exactly that
 * act and subject, and the same body goes again once.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { RecipeProposalHost } from '../../../src/features/secrets/recipe-proposal-host.tsx';
import type { ConnectionHealthEnvironment } from '../../../src/lib/connection-health.ts';
import type { DaemonConnectionRepository } from '../../../src/lib/connections.ts';
import { createAppStore, StoreProvider } from '../../../src/lib/store.tsx';
import { list, PROPOSAL, SI_GITHUB } from '../../support/accounts-fixtures.ts';
import { mount, must } from '../../support/dom.ts';
import { click, settle, typeInto } from '../../support/dom-form.ts';
import {
  AutoCarrierPreferences,
  autoDial,
  dialByHost,
  keyedDaemon,
  relayCrypto,
  settle as settleTasks,
} from '../../support/relay.ts';

const DECISION_PATH = `/v1/accounts/sign-ins/${SI_GITHUB}/recipe/proposals/${PROPOSAL}`;
const REQUIRED = {
  error: 'Confirm with your passkey.',
  code: 'grant_step_up_required',
  demand: { capability: 'secrets', axis: 'configure', act: 'approve-recipe', subject: PROPOSAL },
};
const q = <T extends Element>(root: ParentNode, selector: string): T => must(root.querySelector<T>(selector), selector);

const idleConnectionHealth: ConnectionHealthEnvironment = {
  now: () => Date.now(),
  schedule: () => () => undefined,
  random: () => 0.5,
  isOnline: () => true,
};

class MemoryRepository implements DaemonConnectionRepository {
  readonly values = new Map<string, string>();
  async load(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }
  async save(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }
}

const bytes = (...values: number[]): ArrayBuffer => Uint8Array.from(values).buffer as ArrayBuffer;
const supported = Object.getOwnPropertyDescriptor(globalThis, 'PublicKeyCredential');
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
  if (supported === undefined) Reflect.deleteProperty(globalThis, 'PublicKeyCredential');
  else Object.defineProperty(globalThis, 'PublicKeyCredential', supported);
});

const quiet = async (): Promise<void> => {
  for (let tries = 0; tries < 4; tries += 1) {
    await settleTasks();
    await settle();
  }
};

/** A paired phone whose daemon asks for a passkey on the first approval, then accepts the same one again. */
const phone = async () => {
  Object.defineProperty(globalThis, 'PublicKeyCredential', { value: class {}, configurable: true });
  const { identity, daemon, deviceKeys } = await keyedDaemon('https://studio.example.test');
  const seen: Array<{ method: string; path: string; body: unknown }> = [];
  let approvals = 0;
  const scripted = autoDial(identity, {
    respond: request => {
      const body = request.body === undefined ? undefined : (JSON.parse(request.body) as unknown);
      seen.push({ method: request.method, path: request.path, body });
      if (request.path === '/v1/accounts') return { body: list() };
      if (request.path === DECISION_PATH) {
        approvals += 1;
        return approvals === 1 ? { status: 403, body: REQUIRED } : { body: list().signIns[0] };
      }
      if (request.path === '/v1/step-up/options')
        return {
          body: {
            challenge: 'AAAA',
            rpId: 'app.ferretry.test',
            allowCredentials: [{ type: 'public-key', id: 'qg' }],
            timeout: 60_000,
          },
        };
      if (request.path === '/v1/step-up') return { body: { expiresAt: '2099-01-01T00:00:00.000Z' } };
      return { status: 404, body: { error: 'no answer' } };
    },
  });
  const store = await createAppStore({
    carrierPreferences: new AutoCarrierPreferences(undefined),
    repository: new MemoryRepository(),
    deviceKeys,
    relayCrypto,
    relayDial: dialByHost({ 'studio.example.test': scripted.dial }).dial,
    connectionHealthEnvironment: idleConnectionHealth,
    passkeyCredentials: {
      create: async () => null,
      get: async () =>
        ({
          type: 'public-key',
          rawId: bytes(0xaa),
          response: { clientDataJSON: bytes(0x7b), authenticatorData: bytes(1), signature: bytes(2) },
        }) as unknown as Credential,
    },
  });
  store.connections.add(daemon);
  const view = await mount(
    <StoreProvider store={store}>
      <RecipeProposalHost connection={daemon} item={{ recipeProposal: { signIn: SI_GITHUB, id: PROPOSAL } }} />
    </StoreProvider>,
  );
  cleanups.push(async () => await view.unmount());
  await quiet();
  return { store, view, seen };
};

type Phone = Awaited<ReturnType<typeof phone>>;

const confirmed = async (store: Phone['store']): Promise<void> => {
  for (let tries = 0; tries < 6 && store.stepUp.snapshot() === null; tries += 1) await quiet();
  await store.stepUp.confirm();
  await quiet();
};

const posts = (seen: Phone['seen']) => seen.filter(call => call.method === 'POST' && call.path === DECISION_PATH);
const optionCalls = (seen: Phone['seen']) => seen.filter(call => call.path === '/v1/step-up/options');

describe('approving a recipe from a paired device', () => {
  it('asks the passkey for approve-recipe bound to the proposal, then sends Approve again exactly once', async () => {
    const { store, view, seen } = await phone();
    await click(q(view.container, '[data-recipe-approve]'));
    await confirmed(store);

    expect(optionCalls(seen).map(call => call.body)).toEqual([
      expect.objectContaining({ act: 'approve-recipe', subject: PROPOSAL }),
    ]);
    expect(posts(seen).map(call => call.body)).toEqual([{ decision: 'approve' }, { decision: 'approve' }]);
    expect(q(view.container, '[data-recipe-done]').textContent).toBe('Recipe for github.com approved.');
  });

  it('sends the owner’s edited text again, unchanged, after the passkey', async () => {
    const { store, view, seen } = await phone();
    await click(q(view.container, '[data-recipe-edit]'));
    await typeInto(q(view.container, '[data-recipe-text]'), 'Open the page, press Sign in, wait.', 'textarea');
    await click(q(view.container, '[data-recipe-approve-mine]'));
    await confirmed(store);

    expect(optionCalls(seen).map(call => call.body)).toEqual([
      expect.objectContaining({ act: 'approve-recipe', subject: PROPOSAL }),
    ]);
    const body = { decision: 'approve', recipe: 'Open the page, press Sign in, wait.' };
    expect(posts(seen).map(call => call.body)).toEqual([body, body]);
    expect(q(view.container, '[data-recipe-done]').textContent).toBe('Recipe for github.com approved.');
  });
});
