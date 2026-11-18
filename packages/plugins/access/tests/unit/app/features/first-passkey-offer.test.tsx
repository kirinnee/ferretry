/**
 * "Add a passkey now", on the screen that says a device is paired — drawn only while the machine says this device has
 * no passkey and the first-passkey window is open, and it runs the existing ceremony, nothing more.
 */
import { describe, expect, it } from 'bun:test';
import type { z } from 'zod';
import type { CredentialsPort } from '@ferretry/app';
import { PairingScreen } from '../../../../app/features/pairing/pairing-screen.tsx';
import type { StepUpClient } from '../../../../app/lib/step-up-client.ts';
import type { PairingArrival, PairingSeed } from '../../../../app/lib/pairing.ts';
import { toBase64Url } from '../../../../app/shell-grants.ts';
import { daemonConnection } from '../../../../app/shell-pairing.ts';
import { inlinePasskeyOffered } from '../../../../app/lib/inline-passkey-offer.ts';
import { interact, mount, must } from '../../../support/app/dom.ts';

const SEED: PairingSeed = { daemonUrl: 'https://daemon.example.test', daemonId: 'daemon-a', code: 'single-use' };
const PREFILLED: PairingArrival = { kind: 'seed', seed: SEED };
const connection = daemonConnection({
  daemonId: 'daemon-a',
  baseUrl: 'https://daemon.example.test',
  deviceId: 'device-one',
});
const ORIGIN = 'https://ferretry.pages.dev';
const NOW = Date.parse('2026-11-17T10:00:00.000Z');
const CLOSES = '2026-11-17T10:07:00.000Z';
const CREATED = '2026-11-17T10:03:00.000Z';
const buffer = (...values: number[]) => Uint8Array.from(values).buffer as ArrayBuffer;

/** A machine whose view of this device is `view`, and which records every path it is asked. */
const machine = (view: unknown, paths: string[] = []) => {
  const client: StepUpClient = {
    request: async <T,>(path: string, schema: z.ZodType<T>): Promise<T> => {
      paths.push(path);
      const answers: Record<string, unknown> = {
        '/v1/passkeys':
          path === '/v1/passkeys' && paths.filter(p => p === '/v1/passkeys').length > 1
            ? { id: toBase64Url(Uint8Array.of(0xaa, 0xbb)), createdAt: CREATED, origin: ORIGIN }
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

const OPEN = { passkeys: [], registration: 'first-window', registrationClosesAt: CLOSES };

const pairedScreen = async (
  client: StepUpClient,
  options: { supported?: boolean; creds?: CredentialsPort; withClient?: boolean } = {},
) => {
  const screen = await mount(
    <PairingScreen
      connections={[]}
      selectedDaemonId={null}
      arrival={PREFILLED}
      scanHost={{ supported: true, scan: async () => await new Promise<string>(() => {}) }}
      onPair={async () => ({ machine: 'Studio', via: 'direct', connection })}
      onRemove={() => {}}
      onSelect={() => {}}
      {...(options.withClient === false
        ? {}
        : {
            passkeyClient: async () => client,
            passkeyOffer: {
              credentials: () => options.creds ?? credentials(),
              origin: () => ORIGIN,
              supported: () => options.supported ?? true,
              now: () => NOW,
            },
          })}
    />,
  );
  const pair = [...screen.container.querySelectorAll('button')].find(b => b.textContent?.includes('Pair this device'));
  await interact(() => must(pair ?? null, 'the pair button').click());
  await interact(async () => await Promise.resolve());
  return screen;
};

describe('the first-passkey offer on the pairing-success screen', () => {
  it('P-F1 should offer "Add a passkey now" with the minutes left while the first window is open, and run the ceremony', async () => {
    const { client, paths } = machine(OPEN);
    const screen = await pairedScreen(client);
    try {
      expect(screen.container.textContent).toContain('Connected');
      const offer = must(screen.container.querySelector('[data-first-passkey-offer]'), 'the offer');
      expect(offer.textContent).toContain('7 minutes left');

      await interact(() =>
        (must(screen.container.querySelector('[data-first-passkey-add]'), 'the button') as HTMLElement).click(),
      );
      await interact(async () => await Promise.resolve());

      expect(paths).toEqual(['/v1/passkeys', '/v1/passkeys/options', '/v1/passkeys']);
      expect(screen.container.querySelector('[data-first-passkey-offer]')).toBeNull();
      expect(screen.container.querySelector('[data-first-passkey-added]')).not.toBeNull();
    } finally {
      await screen.unmount();
    }
  });

  it('A555 r7 should hold its machine while the button shows, so no unasked prompt pops over it, and let go once added', async () => {
    const { client } = machine(OPEN);
    const screen = await pairedScreen(client);
    try {
      expect(screen.container.querySelector('[data-first-passkey-offer]')).not.toBeNull();
      expect(inlinePasskeyOffered('daemon-a')).toBe(true);
      await interact(() =>
        (must(screen.container.querySelector('[data-first-passkey-add]'), 'the button') as HTMLElement).click(),
      );
      await interact(async () => await Promise.resolve());
      expect(screen.container.querySelector('[data-first-passkey-added]')).not.toBeNull();
      expect(inlinePasskeyOffered('daemon-a')).toBe(false);
    } finally {
      await screen.unmount();
    }
    expect(inlinePasskeyOffered('daemon-a')).toBe(false);
  });

  it('P-F2 should offer nothing once the window is closed', async () => {
    const { client, paths } = machine({ passkeys: [], registration: 'closed' });
    const screen = await pairedScreen(client);
    try {
      expect(screen.container.textContent).toContain('Connected');
      expect(screen.container.querySelector('[data-first-passkey-offer]')).toBeNull();
      // Read once, never ceremonied.
      expect(paths).toEqual(['/v1/passkeys']);
    } finally {
      await screen.unmount();
    }
  });

  it('P-F3 should offer nothing to a device that already holds a passkey, or a browser that cannot run one', async () => {
    const held = machine({
      passkeys: [{ id: toBase64Url(Uint8Array.of(1)), createdAt: CREATED, origin: ORIGIN }],
      registration: 'confirm-existing',
    });
    const first = await pairedScreen(held.client);
    expect(first.container.querySelector('[data-first-passkey-offer]')).toBeNull();
    await first.unmount();

    const unsupported = machine(OPEN);
    const second = await pairedScreen(unsupported.client, { supported: false });
    expect(second.container.querySelector('[data-first-passkey-offer]')).toBeNull();
    expect(unsupported.paths).toEqual([]);
    await second.unmount();
  });

  it('P-F4 should offer nothing on a screen with no way to reach the machine, and say a refused press in one sentence', async () => {
    const bare = await pairedScreen(machine(OPEN).client, { withClient: false });
    expect(bare.container.textContent).toContain('Connected');
    expect(bare.container.querySelector('[data-first-passkey-offer]')).toBeNull();
    await bare.unmount();

    const refused = await pairedScreen(machine(OPEN).client, { creds: credentials(new Error('boom')) });
    try {
      await interact(() =>
        (must(refused.container.querySelector('[data-first-passkey-add]'), 'the button') as HTMLElement).click(),
      );
      await interact(async () => await Promise.resolve());
      expect(must(refused.container.querySelector('[data-first-passkey-failure]'), 'the failure').textContent).toBe(
        'The passkey was not added. Try again.',
      );
      expect(refused.container.querySelector('[data-first-passkey-offer]')).not.toBeNull();
    } finally {
      await refused.unmount();
    }
  });
});
