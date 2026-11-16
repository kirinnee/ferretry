/**
 * ACCESS'S PASSKEY PROVISION, end to end against a REAL document: the handler the shell's client consults, the two
 * gates it raises, the two dialogs it mounts, and the ceremony over Access's own client by route key.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { PairedDaemon, PasskeyNeed, PasskeyPorts } from '@ferretry/app';
import type { PluginClient } from '@ferretry/kernel/manifest';
import { toBase64Url } from '../../../app/shell-grants.ts';
import { accessPasskey, PASSKEY_UNREACHABLE, passkeyNeed } from '../../../app/step-up-shell.tsx';
import { interact, mount, must } from '../../support/app/dom.ts';

const INSTANT = '2026-10-13T10:00:00.000Z';
const CHALLENGE = toBase64Url(Uint8Array.of(5, 6, 7, 8));
const buffer = (...values: number[]) => Uint8Array.from(values).buffer as ArrayBuffer;

const paired = (daemon: string, machine: string, address: string, pairedAt = 1): PairedDaemon => ({
  daemon,
  machine,
  deviceId: `device-${daemon}`,
  address,
  carriers: [],
  pairedAt,
  lastSelectedAt: pairedAt,
});

const ONE = paired('d1', 'dev-box', 'http://127.0.0.1:40245');
const TWO = paired('d2', 'dev-box', 'http://127.0.0.1:40246', 2);
const STUDIO = paired('d3', 'studio', 'https://studio.example', 3);

/** Access's client on one daemon, answering the passkey routes; it records each route key it was asked. */
function accessClient(routes: string[]): Pick<PluginClient, 'call' | 'subscribe'> {
  return {
    call: async <Answer,>(route: string): Promise<Answer> => {
      routes.push(route);
      if (route === 'POST /v1/step-up/options' || route === 'POST /v1/unlock/options')
        return {
          challenge: CHALLENGE,
          rpId: 'app.example',
          allowCredentials: [{ type: 'public-key', id: toBase64Url(Uint8Array.of(0xaa, 0xbb)) }],
          timeout: 60_000,
        } as Answer;
      if (route === 'POST /v1/step-up') return { expiresAt: INSTANT } as Answer;
      if (route === 'POST /v1/unlock') return { unlockedUntil: INSTANT } as Answer;
      throw Object.assign(new Error('The daemon answered 404.'), { status: 404, code: 'not_found' });
    },
    subscribe: () => () => {},
  };
}

function harness(daemons: readonly PairedDaemon[] = [ONE, TWO, STUDIO], reachable = true) {
  const routes: string[] = [];
  let sheets = 0;
  const snapshot = { daemons, selected: daemons[0]?.daemon ?? null };
  const ports: PasskeyPorts = {
    client: () => (reachable ? (accessClient(routes) as never) : undefined),
    daemons: { snapshot: () => snapshot, subscribe: () => () => {} },
    origin: 'https://app.example',
    credentials: {
      create: async () => null,
      get: async () => {
        sheets += 1;
        return {
          type: 'public-key',
          rawId: buffer(0xaa, 0xbb),
          response: { clientDataJSON: buffer(0x7b, 0x7d), authenticatorData: buffer(1, 2, 3), signature: buffer(4, 5) },
        } as unknown as Credential;
      },
    },
  };
  const provision = accessPasskey(ports);
  return { provision, routes, sheets: () => sheets };
}

const STEP_UP: PasskeyNeed = { kind: 'step-up', act: 'open a terminal' };
const UNLOCK: PasskeyNeed = { kind: 'unlock' };

const dialogs = (container: HTMLElement) => [...container.querySelectorAll<HTMLElement>('[data-step-up-dialog]')];
const settle = async () => {
  for (let i = 0; i < 6; i += 1) await interact(() => new Promise(resolve => setTimeout(resolve, 0)));
};

// Bun has no WebAuthn, and the ceremony asks the global whether this browser does.
const hadPublicKeyCredential = 'PublicKeyCredential' in globalThis;
beforeEach(() => {
  Object.defineProperty(globalThis, 'PublicKeyCredential', { value: class {}, configurable: true, writable: true });
});
afterEach(() => {
  if (!hadPublicKeyCredential) Reflect.deleteProperty(globalThis, 'PublicKeyCredential');
});

describe('reading a refusal', () => {
  it('G105 should read the unlock from a 401 with its code, and nothing else as one', () => {
    expect(passkeyNeed({ status: 401, body: { error: 'x', code: 'unlock_required' } })).toEqual({ kind: 'unlock' });
    expect(passkeyNeed({ status: 401, body: { error: 'x', code: 'unauthenticated' } })).toBeUndefined();
    expect(passkeyNeed({ status: 403, body: { error: 'x', code: 'unlock_required' } })).toBeUndefined();
  });

  it('G105 should read a named step-up demand as the act it names, and keep its id for the gate', () => {
    const need = passkeyNeed({
      status: 403,
      body: {
        error: 'Confirm with a passkey.',
        code: 'grant_step_up_required',
        demand: { capability: 'terminal', axis: 'use' },
      },
    });
    expect(need?.kind).toBe('step-up');
    expect(need?.kind === 'step-up' ? need.act : undefined).toBeString();
    const named = passkeyNeed({
      status: 403,
      body: {
        error: 'Confirm with a passkey.',
        code: 'grant_step_up_required',
        demand: { capability: 'pairing', axis: 'configure', act: 'widen-device' },
      },
    });
    expect(named?.kind === 'step-up' ? named.actId : undefined).toBe('widen-device');
  });

  it('G105 should still ask for a step-up whose demand does not parse, saying "this change"', () => {
    expect(passkeyNeed({ status: 403, body: { code: 'grant_step_up_required' } })).toEqual({ kind: 'step-up' });
  });

  it('G108 should raise no prompt for not-granted, undetermined or any other refusal', () => {
    for (const code of ['grant_forbidden', 'grant_undetermined', 'grant_device_withheld', 'not_found'])
      expect(passkeyNeed({ status: 403, body: { error: 'x', code } })).toBeUndefined();
    expect(passkeyNeed({ status: 403, body: 'not json' })).toBeUndefined();
    expect(passkeyNeed({ status: 500, body: { code: 'grant_step_up_required' } })).toBeUndefined();
  });
});

describe('G95 the prompt comes from the machine on screen', () => {
  it('G95 should hold a background request for a machine off screen, and ask once it comes on screen', async () => {
    const { provision } = harness();
    const view = await mount(<provision.Prompts />);
    try {
      await interact(() => provision.handler.focus('d3'));
      let settled: boolean | undefined;
      await interact(
        () =>
          void provision.handler.confirm(ONE, STEP_UP, 'background').then(answer => {
            settled = answer;
          }),
      );
      await settle();
      expect(dialogs(view.container)).toHaveLength(0);
      expect(settled).toBeUndefined();
      await interact(() => provision.handler.focus('d1'));
      expect(dialogs(view.container)).toHaveLength(1);
      await interact(() =>
        must(view.container.querySelector<HTMLButtonElement>('[data-step-up-confirm]'), 'confirm').click(),
      );
      await settle();
      expect(settled).toBe(true);
      expect(dialogs(view.container)).toHaveLength(0);
    } finally {
      await view.unmount();
    }
  });

  it('G95 should ask at once for anything a person pressed, wherever its machine is', async () => {
    const { provision } = harness();
    const view = await mount(<provision.Prompts />);
    try {
      await interact(() => provision.handler.focus('d3'));
      await interact(() => void provision.handler.confirm(ONE, STEP_UP, 'explicit'));
      await settle();
      expect(dialogs(view.container)).toHaveLength(1);
    } finally {
      await view.unmount();
    }
  });

  it('G95 should tell same-named machines apart by address in the prompt', async () => {
    const { provision } = harness();
    const view = await mount(<provision.Prompts />);
    try {
      await interact(() => void provision.handler.confirm(TWO, STEP_UP, 'explicit'));
      await settle();
      const text = must(dialogs(view.container)[0], 'the prompt').textContent ?? '';
      expect(text).toContain('dev-box (127.0.0.1:40246');
      expect(text).not.toContain('dev-box (127.0.0.1:40245');
    } finally {
      await view.unmount();
    }
  });

  it('G95 should name a machine with a name of its own by that name alone', async () => {
    const { provision } = harness();
    const view = await mount(<provision.Prompts />);
    try {
      await interact(() => void provision.handler.confirm(STUDIO, STEP_UP, 'explicit'));
      await settle();
      const text = must(dialogs(view.container)[0], 'the prompt').textContent ?? '';
      expect(text).toContain('studio');
      expect(text).not.toContain('studio.example');
    } finally {
      await view.unmount();
    }
  });
});

describe('G105 one prompt, one ceremony', () => {
  it('G105 should share ONE prompt and ONE ceremony between every request waiting on a machine', async () => {
    const { provision, routes, sheets } = harness();
    const view = await mount(<provision.Prompts />);
    try {
      const answers: boolean[] = [];
      await interact(
        () => void provision.handler.confirm(ONE, STEP_UP, 'explicit').then(answer => answers.push(answer)),
      );
      await interact(
        () =>
          void provision.handler
            .confirm(ONE, { kind: 'step-up', act: 'add or manage a paired device' }, 'explicit')
            .then(answer => answers.push(answer)),
      );
      await settle();
      expect(dialogs(view.container)).toHaveLength(1);
      await interact(() =>
        must(view.container.querySelector<HTMLButtonElement>('[data-step-up-confirm]'), 'confirm').click(),
      );
      await settle();
      expect(answers).toEqual([true, true]);
      expect(sheets()).toBe(1);
      expect(routes.filter(route => route.startsWith('POST /v1/step-up'))).toEqual([
        'POST /v1/step-up/options',
        'POST /v1/step-up',
      ]);
    } finally {
      await view.unmount();
    }
  });

  it('G105 should answer false for a dismissed prompt, running no ceremony', async () => {
    const { provision, routes } = harness();
    const view = await mount(<provision.Prompts />);
    try {
      let settled: boolean | undefined;
      await interact(
        () =>
          void provision.handler.confirm(ONE, STEP_UP, 'explicit').then(answer => {
            settled = answer;
          }),
      );
      await settle();
      const cancel = [...view.container.querySelectorAll<HTMLButtonElement>('button')].find(
        button => button.textContent === 'Cancel',
      );
      await interact(() => must(cancel, 'cancel').click());
      await settle();
      expect(settled).toBe(false);
      expect(routes.filter(route => route.includes('step-up'))).toEqual([]);
    } finally {
      await view.unmount();
    }
  });

  it('G105 should raise the unlock in its own prompt, list the machine as locked, and run the unlock routes', async () => {
    const { provision, routes } = harness();
    const view = await mount(<provision.Prompts />);
    try {
      await interact(() => void provision.handler.confirm(ONE, UNLOCK, 'explicit'));
      await settle();
      expect(provision.handler.locked()).toEqual(['d1']);
      const dialog = must(dialogs(view.container)[0], 'the unlock prompt');
      expect(dialog.querySelector('h2')?.textContent).toBe('Unlock');
      await interact(() => must(dialog.querySelector<HTMLButtonElement>('[data-step-up-confirm]'), 'unlock').click());
      await settle();
      expect(provision.handler.locked()).toEqual([]);
      expect(routes.filter(route => route.startsWith('POST /v1/unlock'))).toEqual([
        'POST /v1/unlock/options',
        'POST /v1/unlock',
      ]);
    } finally {
      await view.unmount();
    }
  });

  it('G105 should say plainly that a machine it cannot reach cannot be confirmed, and leave the prompt open', async () => {
    const { provision } = harness([ONE], false);
    const view = await mount(<provision.Prompts />);
    try {
      await interact(() => void provision.handler.confirm(ONE, STEP_UP, 'explicit'));
      await settle();
      await interact(() =>
        must(view.container.querySelector<HTMLButtonElement>('[data-step-up-confirm]'), 'confirm').click(),
      );
      await settle();
      expect(view.container.querySelector('[data-step-up-failure]')?.textContent).toBe(PASSKEY_UNREACHABLE);
    } finally {
      await view.unmount();
    }
  });
});

describe('asking before a press', () => {
  it('should ask the same one prompt for an unbound ask', async () => {
    const { provision } = harness();
    const view = await mount(<provision.Prompts />);
    try {
      await interact(() => void provision.handler.ask(ONE, { act: 'change the settings for pairing' }));
      await settle();
      expect(dialogs(view.container)).toHaveLength(1);
    } finally {
      await view.unmount();
    }
  });

  it('should refuse a bound ask it cannot stamp rather than ask it unbound', async () => {
    const { provision } = harness();
    const view = await mount(<provision.Prompts />);
    try {
      expect(await provision.handler.ask(ONE, { actId: 'not-an-act' })).toBe(false);
      expect(await provision.handler.ask(ONE, { subject: 'srs_0123456789abcdef01234567' })).toBe(false);
      expect(await provision.handler.ask(ONE, { actId: 'approve-sign-in-rule', subject: 'nope' })).toBe(false);
      await settle();
      expect(dialogs(view.container)).toHaveLength(0);
    } finally {
      await view.unmount();
    }
  });

  it('should show a bound ask’s structured words, and stamp the ceremony for that act and stage', async () => {
    const { provision, routes } = harness();
    const view = await mount(<provision.Prompts />);
    try {
      await interact(
        () =>
          void provision.handler.ask(ONE, {
            actId: 'approve-sign-in-rule',
            subject: 'srs_0123456789abcdef01234567',
            act: 'approve a standing sign-in rule',
            words: {
              does: 'Signs in to example.com for you.',
              rows: [{ label: 'Site', value: 'example.com' }],
              warnings: [],
            },
          }),
      );
      await settle();
      expect(must(dialogs(view.container)[0], 'the prompt').textContent).toContain('example.com');
      await interact(() =>
        must(view.container.querySelector<HTMLButtonElement>('[data-step-up-confirm]'), 'confirm').click(),
      );
      await settle();
      expect(routes).toContain('POST /v1/step-up/options');
    } finally {
      await view.unmount();
    }
  });
});

describe('G100 the browser holds no replayable value', () => {
  it('G100 should keep nothing and log nothing of a ceremony: no challenge on the page, no console line', async () => {
    const { provision } = harness();
    const said: unknown[] = [];
    const original = {
      log: console.log,
      info: console.info,
      warn: console.warn,
      error: console.error,
      debug: console.debug,
    };
    for (const name of Object.keys(original) as (keyof typeof original)[])
      console[name] = (...args: unknown[]) => said.push(args);
    const view = await mount(<provision.Prompts />);
    try {
      await interact(() => void provision.handler.confirm(ONE, STEP_UP, 'explicit'));
      await settle();
      await interact(() =>
        must(view.container.querySelector<HTMLButtonElement>('[data-step-up-confirm]'), 'confirm').click(),
      );
      await settle();
      expect(said).toEqual([]);
      expect(document.documentElement.outerHTML).not.toContain(CHALLENGE);
      // The provision is handed no storage at all: there is nowhere a proof could be kept.
      expect(Object.keys(provision).sort()).toEqual(['Prompts', 'handler']);
    } finally {
      Object.assign(console, original);
      await view.unmount();
    }
  });
});
