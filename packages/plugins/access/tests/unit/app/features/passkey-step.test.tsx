/**
 * The `access.passkey` client step (r10 O6b): drawn through the real O1 `StepHost` contract type (a recording host),
 * with the shell's `ChoiceCards`. Fake machine, fake WebAuthn: no real credential is ever made.
 */
import { describe, expect, it } from 'bun:test';
import type { z } from 'zod';
import type { CredentialsPort } from '@ferretry/app';
import { stepHostRecorder } from '../../../support/app/step-host.ts';
import { PasskeyStep, type PasskeyStepProps } from '../../../../app/features/onboarding/passkey-step.tsx';
import { inlinePasskeyOffered } from '../../../../app/lib/inline-passkey-offer.ts';
import type { StepUpClient } from '../../../../app/lib/step-up-client.ts';
import { toBase64Url } from '../../../../app/shell-grants.ts';
import { daemonConnection } from '../../../../app/shell-pairing.ts';
import manifest from '../../../../manifest.ts';
import { interact, mount, must } from '../../../support/app/dom.ts';

const connection = daemonConnection({
  daemonId: 'daemon-a',
  baseUrl: 'https://daemon.example.test',
  deviceId: 'device-one',
});
const ORIGIN = 'https://ferretry.pages.dev';
const NOW = Date.parse('2026-11-17T10:00:00.000Z');
const CLOSES = '2026-11-17T10:07:00.000Z';
const OPEN = { passkeys: [], registration: 'first-window', registrationClosesAt: CLOSES };
const CLOSED = { passkeys: [], registration: 'closed' };
const HELD = {
  passkeys: [{ id: toBase64Url(Uint8Array.of(1)), createdAt: '2026-11-16T10:00:00.000Z', origin: ORIGIN }],
  registration: 'closed',
};
const buffer = (...values: number[]) => Uint8Array.from(values).buffer as ArrayBuffer;

const machine = (view: unknown, options: { fail?: boolean } = {}) => {
  const paths: string[] = [];
  const client: StepUpClient = {
    request: async <T,>(path: string, schema: z.ZodType<T>): Promise<T> => {
      paths.push(path);
      if (options.fail === true) throw new Error('machine unreachable');
      const reads = paths.filter(p => p === '/v1/passkeys').length;
      const answers: Record<string, unknown> = {
        '/v1/passkeys':
          reads > 1
            ? { id: toBase64Url(Uint8Array.of(0xaa)), createdAt: '2026-11-17T10:03:00.000Z', origin: ORIGIN }
            : view,
        '/v1/passkeys/options': {
          challenge: toBase64Url(Uint8Array.of(9)),
          rp: { id: 'ferretry.pages.dev', name: 'Ferretry' },
          user: { id: toBase64Url(Uint8Array.of(1)), name: 'device-one', displayName: 'device-one' },
          pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
          timeout: 60_000,
          excludeCredentials: [],
        },
      };
      return schema.parse(answers[path]);
    },
  };
  return { client, paths };
};

const credentials = (failWith?: Error): CredentialsPort => ({
  create: async () => {
    if (failWith !== undefined) throw failWith;
    return {
      type: 'public-key',
      rawId: buffer(0xaa, 0xbb),
      response: { clientDataJSON: buffer(0x7b, 0x7d), attestationObject: buffer(1), getTransports: () => [] },
    } as unknown as Credential;
  },
  get: async () => null,
});

const draw = async (
  view: unknown,
  props: Partial<PasskeyStepProps> = {},
  options: { fail?: boolean; phase?: 'daemon' | 'client' } = {},
) => {
  const world = machine(view, options);
  const harness = stepHostRecorder(options.phase ?? 'client');
  const screen = await mount(
    <PasskeyStep
      step={harness.host}
      connection={connection}
      createClient={async () => world.client}
      credentials={() => credentials()}
      origin={() => ORIGIN}
      supported={() => true}
      now={() => NOW}
      {...props}
    />,
  );
  await interact(async () => await Promise.resolve());
  await interact(async () => await Promise.resolve());
  return { ...world, harness, screen };
};

const card = (root: HTMLElement, id: string) =>
  must(root.querySelector<HTMLInputElement>(`input[value="${id}"]`), `the ${id} card`);

describe('the access.passkey client step', () => {
  it("declares itself as a client step of Access through O1's contract, with a panel in the onboarding.step slot", () => {
    expect(manifest.onboarding).toEqual([{ id: 'passkey', title: 'Passkey', order: 2, side: 'client' }]);
    const panel = manifest.ui?.panels?.find(p => p.id === 'onboarding-passkey');
    expect(panel?.slot).toBe('onboarding.step');
  });

  it('shows two cards (add now / not now) with the minutes left once the machine says this device has none', async () => {
    const { harness, screen } = await draw(OPEN);
    try {
      expect(harness.decision).toBe('shown');
      const root = must(screen.container.querySelector<HTMLElement>('[data-passkey-step]'), 'the step');
      expect(root.textContent).toContain('Add a passkey now');
      expect(root.textContent).toContain('7 minutes left');
      expect(root.textContent).toContain('Not now');
      expect(root.querySelector('[data-choice-cards]')).not.toBeNull();
      expect(root.querySelectorAll('input[type="radio"]').length).toBe(2);
      // Nothing chosen yet, nothing run: the page only asked the machine, once.
      expect(harness.count('done')).toBe(0);
      expect(harness.count('busy')).toBe(0);
    } finally {
      await screen.unmount();
    }
  });

  it('skips as already-set, drawing nothing, when this device already holds a passkey', async () => {
    const { harness, screen } = await draw(HELD);
    try {
      expect(harness.decision).toBe('skipped');
      expect(harness.skippedWhy).toBe('already-set');
      expect(screen.container.querySelector('[data-passkey-step]')).toBeNull();
    } finally {
      await screen.unmount();
    }
  });

  it('skips as not-needed when no first-passkey window is open', async () => {
    const { harness, screen } = await draw(CLOSED);
    try {
      expect(harness.skippedWhy).toBe('not-needed');
      expect(screen.container.querySelector('[data-passkey-step]')).toBeNull();
    } finally {
      await screen.unmount();
    }
  });

  it('skips as not-needed with no browser support, without even asking the machine', async () => {
    const { harness, paths, screen } = await draw(OPEN, { supported: () => false });
    try {
      expect(harness.skippedWhy).toBe('not-needed');
      expect(paths).toEqual([]);
    } finally {
      await screen.unmount();
    }
  });

  it('skips as not-needed with no machine in scope', async () => {
    const { harness, paths, screen } = await draw(OPEN, { connection: undefined });
    try {
      expect(harness.skippedWhy).toBe('not-needed');
      expect(paths).toEqual([]);
    } finally {
      await screen.unmount();
    }
  });

  it('skips as not-needed when the machine cannot be read, so a broken read never blocks the flow', async () => {
    const { harness, screen } = await draw(OPEN, {}, { fail: true });
    try {
      expect(harness.skippedWhy).toBe('not-needed');
    } finally {
      await screen.unmount();
    }
  });

  it('draws nothing at all when it is not drawn as a step', async () => {
    const screen = await mount(
      <PasskeyStep step={undefined} connection={connection} createClient={async () => machine(OPEN).client} />,
    );
    try {
      expect(screen.container.textContent).toBe('');
    } finally {
      await screen.unmount();
    }
  });

  it('choosing "Add a passkey now" runs the fake ceremony, locks the footer while it runs, then records done', async () => {
    const { harness, paths, screen } = await draw(OPEN);
    try {
      await interact(() => card(screen.container, 'add').click());
      await interact(async () => await Promise.resolve());
      await interact(async () => await Promise.resolve());
      expect(paths).toEqual(['/v1/passkeys', '/v1/passkeys/options', '/v1/passkeys']);
      expect(harness.calls.map(c => c.kind)).toEqual(['ready', 'busy', 'busy', 'done']);
      expect(harness.calls.filter(c => c.kind === 'busy')).toEqual([
        { kind: 'busy', label: 'Waiting for your device…' },
        { kind: 'busy', label: null },
      ]);
      expect(screen.container.querySelector('[data-passkey-step-added]')).not.toBeNull();
    } finally {
      await screen.unmount();
    }
  });

  it('a refused ceremony says why, releases the footer, records nothing, and lets the person choose again', async () => {
    const { harness, screen } = await draw(OPEN, { credentials: () => credentials(new Error('refused')) });
    try {
      await interact(() => card(screen.container, 'add').click());
      await interact(async () => await Promise.resolve());
      await interact(async () => await Promise.resolve());
      expect(screen.container.querySelector('[data-passkey-step-failure]')).not.toBeNull();
      expect(harness.count('done')).toBe(0);
      expect(harness.calls.filter(c => c.kind === 'busy').at(-1)).toEqual({ kind: 'busy', label: null });
      expect(card(screen.container, 'add').checked).toBe(false);
      expect(card(screen.container, 'add').disabled).toBe(false);
    } finally {
      await screen.unmount();
    }
  });

  it('"Not now" is the whole answer: it moves on at once and records nothing on the ledger', async () => {
    const { harness, paths, screen } = await draw(OPEN);
    try {
      await interact(() => card(screen.container, 'later').click());
      expect(harness.count('next')).toBe(1);
      expect(harness.count('done')).toBe(0);
      expect(paths).toEqual(['/v1/passkeys']);
    } finally {
      await screen.unmount();
    }
  });

  it("holds this machine's own passkey prompt while the cards show, and lets go on unmount", async () => {
    const { screen } = await draw(OPEN);
    expect(inlinePasskeyOffered('daemon-a')).toBe(true);
    await screen.unmount();
    expect(inlinePasskeyOffered('daemon-a')).toBe(false);
  });

  it('never puts a credential, challenge or key into the page text or the browser storage', async () => {
    const { screen } = await draw(OPEN);
    try {
      await interact(() => card(screen.container, 'add').click());
      await interact(async () => await Promise.resolve());
      await interact(async () => await Promise.resolve());
      const text = `${document.body.textContent}${document.body.innerHTML}`;
      expect(text).not.toContain(toBase64Url(Uint8Array.of(9)));
      expect(text).not.toContain(toBase64Url(Uint8Array.of(0xaa, 0xbb)));
      expect(localStorage.length).toBe(0);
      expect(sessionStorage.length).toBe(0);
    } finally {
      await screen.unmount();
    }
  });
});
