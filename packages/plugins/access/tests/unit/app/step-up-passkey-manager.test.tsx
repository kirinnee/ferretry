/**
 * A555 r7: "Add a passkey" in the step-up prompt, answered by a PASSKEY MANAGER (1Password), reaches the machine.
 *
 * The owner's 1Password saved a passkey and the machine never heard of it: 1Password resolves `create()` with a plain
 * object that only mimics a `PublicKeyCredential` (its bytes behind `toJSON()`), and the ceremony refused it as
 * "This browser cannot use passkeys" before sending anything. This drives Access's REAL prompt, gate and ceremony with
 * a device that has no passkey and a slow, 1Password-shaped `create()`, and checks the registration is SENT with the
 * credential's own bytes — and that a credential nothing can read is said in words, never sent half-read.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { PairedDaemon, PasskeyPorts } from '@ferretry/app';
import { toBase64Url } from '../../../app/shell-grants.ts';
import { accessPasskey } from '../../../app/step-up-shell.tsx';
import { interact, mount, must } from '../../support/app/dom.ts';

const ONE: PairedDaemon = {
  daemon: 'd1',
  machine: 'dev-box',
  deviceId: 'device-d1',
  address: 'http://127.0.0.1:40245',
  carriers: [],
  pairedAt: 1,
  lastSelectedAt: 1,
};
const SNAPSHOT = { daemons: [ONE], selected: 'd1' };
const CHALLENGE = toBase64Url(Uint8Array.of(5, 6, 7, 8));
const refusal = (status: number, code: string) =>
  Object.assign(new Error(code), { status, code, body: { error: code, code } });

/** 1Password's look-alike: a plain object, an empty `response`, the bytes only through `toJSON()`. */
const onePasswordCredential = () => ({
  id: 'qrs',
  type: 'public-key',
  rawId: new ArrayBuffer(8),
  authenticatorAttachment: 'platform',
  response: {},
  getClientExtensionResults: () => ({}),
  toJSON: () => ({
    id: toBase64Url(Uint8Array.of(0xaa, 0xbb)),
    rawId: toBase64Url(Uint8Array.of(0xaa, 0xbb)),
    type: 'public-key',
    response: {
      clientDataJSON: toBase64Url(Uint8Array.of(0x7b, 0x7d)),
      attestationObject: toBase64Url(Uint8Array.of(0xa0)),
    },
  }),
});

function machine(created: () => unknown) {
  const sent: { route: string; body?: unknown }[] = [];
  const client = {
    call: async (route: string, init?: { readonly body?: unknown }) => {
      sent.push({ route, ...(init?.body === undefined ? {} : { body: init.body }) });
      if (route === 'POST /v1/step-up/options') throw refusal(403, 'step_up_no_passkey');
      if (route === 'GET /v1/passkeys') return { passkeys: [], registration: 'reopened' };
      if (route === 'POST /v1/passkeys/options')
        return {
          challenge: CHALLENGE,
          rp: { id: 'app.example', name: 'Ferretry' },
          user: { id: CHALLENGE, name: 'phone', displayName: 'Phone' },
          pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
          timeout: 60_000,
          excludeCredentials: [],
        };
      if (route === 'POST /v1/passkeys') throw refusal(409, 'stop_here');
      throw refusal(404, 'not_found');
    },
    subscribe: () => () => {},
  };
  const ports: PasskeyPorts = {
    client: () => client as never,
    daemons: { snapshot: () => SNAPSHOT, subscribe: () => () => {} },
    origin: 'https://app.example',
    credentials: {
      // A passkey manager's own sheet takes seconds; the prompt must still be there to take its answer.
      create: async () => {
        await new Promise(resolve => setTimeout(resolve, 30));
        return created() as Credential;
      },
      get: async () => null,
    },
  };
  return { provision: accessPasskey(ports), sent };
}

const settle = async () => {
  for (let i = 0; i < 12; i += 1) await interact(() => new Promise(resolve => setTimeout(resolve, 5)));
};

const had = 'PublicKeyCredential' in globalThis;
beforeEach(() => {
  Object.defineProperty(globalThis, 'PublicKeyCredential', { value: class {}, configurable: true, writable: true });
});
afterEach(() => {
  if (!had) Reflect.deleteProperty(globalThis, 'PublicKeyCredential');
});

describe('A555 r7 Add a passkey, answered by a passkey manager', () => {
  it('sends the registration of a 1Password-shaped credential to the machine, with its own bytes', async () => {
    const { provision, sent } = machine(onePasswordCredential);
    const view = await mount(<provision.Prompts />);
    try {
      await interact(
        () => void provision.handler.confirm(ONE, { kind: 'step-up', act: 'make this change' }, 'explicit'),
      );
      await settle();
      const confirm = must(view.container.querySelector<HTMLButtonElement>('[data-step-up-confirm]'), 'the button');
      expect(confirm.textContent).toContain('Add a passkey');
      await interact(() => confirm.click());
      await settle();
      const registration = sent.find(each => each.route === 'POST /v1/passkeys');
      expect(registration?.body).toEqual({
        credentialId: toBase64Url(Uint8Array.of(0xaa, 0xbb)),
        clientDataJSON: toBase64Url(Uint8Array.of(0x7b, 0x7d)),
        attestationObject: toBase64Url(Uint8Array.of(0xa0)),
      });
    } finally {
      await view.unmount();
    }
  });

  it('says in words that a credential it cannot read was never sent, and sends nothing', async () => {
    const { provision, sent } = machine(() => ({ rawId: new ArrayBuffer(1), response: {} }));
    const view = await mount(<provision.Prompts />);
    try {
      await interact(
        () => void provision.handler.confirm(ONE, { kind: 'step-up', act: 'make this change' }, 'explicit'),
      );
      await settle();
      await interact(() =>
        must(view.container.querySelector<HTMLButtonElement>('[data-step-up-confirm]'), 'b').click(),
      );
      await settle();
      expect(sent.some(each => each.route === 'POST /v1/passkeys')).toBe(false);
      const failure =
        must(view.container.querySelector('[data-step-up-failure]'), 'the failure line').textContent ?? '';
      expect(failure).toContain('never sent to the machine');
      expect(failure).toContain('delete it there');
      // The prompt stays, so the person can try again.
      expect(view.container.querySelector('[data-step-up-dialog]')).not.toBeNull();
    } finally {
      await view.unmount();
    }
  });
});
