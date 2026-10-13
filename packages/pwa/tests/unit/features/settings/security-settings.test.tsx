import { describe, expect, it } from 'bun:test';
import type { PasskeysView } from '@ferretry/protocol';
import { FyHttpError } from '@ferretry/protocol/client';
import type { ReactTestRenderer } from 'react-test-renderer';
import should from 'should';
import { SecuritySurface } from '../../../../src/features/settings/security-settings.tsx';
import { daemonConnection } from '../../../../src/lib/daemon-connection.ts';
import type { CredentialsPort } from '../../../../src/lib/passkeys.ts';
import type { StepUpClient } from '../../../../src/lib/step-up-client.ts';
import { mount, must } from '../../../support/dom.ts';
import { render, run, runAsync } from '../../../support/react.ts';

const ORIGIN = 'https://ferretry.example.test';
const connection = daemonConnection({
  daemonId: 'daemon-alpha',
  baseUrl: 'https://alpha.example.test',
  deviceId: 'alpha-token',
});

const PASSKEY = { id: 'QUJD', origin: ORIGIN, createdAt: '2025-12-20T18:22:00.000Z' };
const view = (over: Partial<PasskeysView> = {}): PasskeysView => ({
  passkeys: [],
  registration: 'first-window',
  ...over,
});

const OPTIONS = {
  challenge: 'AAAA',
  rp: { id: 'ferretry.example.test', name: 'Ferretry' },
  user: { id: 'AAAA', name: 'device', displayName: 'Device' },
  pubKeyCredParams: [{ type: 'public-key' as const, alg: -7 }],
};

const buffer = (...bytes: number[]): ArrayBuffer => new Uint8Array(bytes).buffer as ArrayBuffer;
const credential = {
  rawId: buffer(1, 2, 3),
  response: { clientDataJSON: buffer(4), attestationObject: buffer(5) },
} as unknown as Credential;

interface Ledger {
  readonly paths: string[];
  readonly bodies: unknown[];
}

/** A machine that lists `lists` in order (the last repeats), and answers the registration routes. */
const machine = (
  lists: readonly (PasskeysView | Error)[],
  ledger: Ledger = { paths: [], bodies: [] },
  registerFailure?: Error,
): (() => Promise<StepUpClient>) => {
  let reads = 0;
  const client = {
    request: async (path: string, _schema: unknown, init?: RequestInit) => {
      ledger.paths.push(`${init?.method ?? 'GET'} ${path}`);
      if (init?.body !== undefined) ledger.bodies.push(JSON.parse(String(init.body)));
      if (path === '/v1/passkeys/options') return OPTIONS;
      if (path === '/v1/passkeys' && init?.method === 'POST') {
        if (registerFailure !== undefined) throw registerFailure;
        return PASSKEY;
      }
      const next = lists[Math.min(reads, lists.length - 1)];
      reads += 1;
      if (next instanceof Error) throw next;
      return next;
    },
  } as unknown as StepUpClient;
  return async () => client;
};

const credentials = (result: Credential | null | Error): (() => CredentialsPort) => {
  return () => ({
    create: async () => {
      if (result instanceof Error) throw result;
      return result;
    },
    get: async () => null,
  });
};

const named = (error: string): Error => Object.assign(new Error(error), { name: error });

const mountSurface = async (
  create: () => Promise<StepUpClient>,
  over: Partial<Parameters<typeof SecuritySurface>[0]> = {},
): Promise<ReactTestRenderer> => {
  let renderer: ReactTestRenderer | undefined;
  await runAsync(async () => {
    renderer = render(
      <SecuritySurface
        connection={connection}
        createClient={create}
        origin={() => ORIGIN}
        supported={() => true}
        credentials={credentials(credential)}
        {...over}
      />,
    );
  });
  return must(renderer, 'the rendered surface');
};

const marked = (surface: ReactTestRenderer, marker: string) =>
  surface.root.findAll(node => typeof node.type === 'string' && node.props[marker] !== undefined);

const text = (surface: ReactTestRenderer): string => JSON.stringify(surface.toJSON()).replace(/\\"/g, '"');

const press = async (surface: ReactTestRenderer, marker: string): Promise<void> => {
  const button = must(marked(surface, marker)[0], marker);
  await runAsync(async () => {
    button.props.onClick();
  });
};

describe('SecuritySurface', () => {
  it('lists this device’s passkeys from the origin and date, and says what a passkey costs', async () => {
    // Arrange / Act
    const surface = await mountSurface(machine([view({ passkeys: [PASSKEY], registration: 'stepped-up' })]));

    // Assert
    should(marked(surface, 'data-security-passkey')).have.length(1);
    expect(text(surface)).toContain(`Passkey for ${ORIGIN}, added `);
    expect(text(surface)).toContain(
      'Changing settings, opening a terminal or the browser, and adding a device ask you to confirm with a passkey on this device.',
    );
    should(marked(surface, 'data-security-add')).have.length(1);
    should(marked(surface, 'data-security-failure')).be.empty();
    run(() => surface.unmount());
  });

  it('says there is no passkey yet, and still offers the first one inside its window', async () => {
    // Arrange / Act
    const surface = await mountSurface(machine([view()]));

    // Assert
    should(marked(surface, 'data-security-empty')).have.length(1);
    should(marked(surface, 'data-security-add')).have.length(1);
    run(() => surface.unmount());
  });

  it('reads once and never polls', async () => {
    // Arrange
    const ledger: Ledger = { paths: [], bodies: [] };

    // Act
    const surface = await mountSurface(machine([view()], ledger));

    // Assert
    should(ledger.paths).eql(['GET /v1/passkeys']);
    run(() => surface.unmount());
  });

  it('adds a passkey: options for this origin, the ceremony, the registration, then a refreshed list', async () => {
    // Arrange
    const ledger: Ledger = { paths: [], bodies: [] };
    const surface = await mountSurface(
      machine([view(), view({ passkeys: [PASSKEY], registration: 'stepped-up' })], ledger),
    );

    // Act
    await press(surface, 'data-security-add');

    // Assert
    should(ledger.paths).eql([
      'GET /v1/passkeys',
      'POST /v1/passkeys/options',
      'POST /v1/passkeys',
      'GET /v1/passkeys',
    ]);
    should(ledger.bodies[0]).eql({ origin: ORIGIN });
    should(ledger.bodies[1]).eql({ credentialId: 'AQID', clientDataJSON: 'BA', attestationObject: 'BQ' });
    should(marked(surface, 'data-security-passkey')).have.length(1);
    should(marked(surface, 'data-security-failure')).be.empty();
    run(() => surface.unmount());
  });

  it('offers no button, and says why, when registration is closed after a passkey exists', async () => {
    // Arrange / Act
    const surface = await mountSurface(machine([view({ passkeys: [PASSKEY], registration: 'closed' })]));

    // Assert
    should(marked(surface, 'data-security-add')).be.empty();
    expect(text(surface)).toContain('needs a recent passkey confirmation');
    run(() => surface.unmount());
  });

  it('offers no button, and says why, when registration is closed before the first passkey', async () => {
    // Arrange / Act
    const surface = await mountSurface(machine([view({ registration: 'closed' })]));

    // Assert
    should(marked(surface, 'data-security-add')).be.empty();
    expect(text(surface)).toContain('within 10 minutes of pairing');
    run(() => surface.unmount());
  });

  it('says when a reopened window closes, and still offers the button', async () => {
    // Arrange / Act
    const surface = await mountSurface(
      machine([view({ registration: 'reopened', registrationClosesAt: '2026-01-01T00:10:00.000Z' })]),
    );

    // Assert
    should(marked(surface, 'data-security-add')).have.length(1);
    expect(text(surface)).toContain('You can add a passkey until');
    run(() => surface.unmount());
  });

  it('says nothing about a closing time once a step-up is what allows the registration', async () => {
    // Arrange / Act
    const surface = await mountSurface(machine([view({ registration: 'stepped-up' })]));

    // Assert
    should(marked(surface, 'data-security-closes')).be.empty();
    run(() => surface.unmount());
  });

  it('says so, with no button, when the browser cannot use passkeys', async () => {
    // Arrange / Act
    const surface = await mountSurface(machine([view()]), { supported: () => false });

    // Assert
    should(marked(surface, 'data-security-add')).be.empty();
    expect(text(surface)).toContain(`This browser cannot use passkeys at ${ORIGIN}`);
    run(() => surface.unmount());
  });

  it('turns a dismissed passkey sheet into one sentence and keeps the list', async () => {
    // Arrange
    const surface = await mountSurface(machine([view()]), { credentials: credentials(named('NotAllowedError')) });

    // Act
    await press(surface, 'data-security-add');

    // Assert
    expect(text(surface)).toContain('did not finish');
    expect(text(surface)).not.toContain('NotAllowedError');
    should(marked(surface, 'data-security-add')).have.length(1);
    run(() => surface.unmount());
  });

  it('turns a daemon refusal into one sentence, never its code', async () => {
    // Arrange
    const refusal = new FyHttpError('registration is closed', 403, 'step_up_registration_closed');
    const surface = await mountSurface(machine([view()], { paths: [], bodies: [] }, refusal));

    // Act
    await press(surface, 'data-security-add');

    // Assert
    expect(text(surface)).toContain('within 10 minutes of pairing');
    expect(text(surface)).not.toContain('step_up_registration_closed');
    run(() => surface.unmount());
  });

  it('says the passkey was added when only the refresh failed', async () => {
    // Arrange
    const surface = await mountSurface(machine([view(), new Error('offline')]));

    // Act
    await press(surface, 'data-security-add');

    // Assert
    expect(text(surface)).toContain('The passkey was added, but the list could not be refreshed');
    run(() => surface.unmount());
  });

  it('says the list could not be read, never an empty machine', async () => {
    // Arrange / Act
    const surface = await mountSurface(machine([new Error('offline')]));

    // Assert
    should(marked(surface, 'data-security-state')[0]?.props['data-security-state']).equal('failed');
    should(marked(surface, 'data-security-empty')).be.empty();
    expect(text(surface)).toContain('did not answer the list of passkeys');
    run(() => surface.unmount());
  });

  it('says the list could not be read when no client could be made', async () => {
    // Arrange / Act
    const surface = await mountSurface(async () => {
      throw new Error('no carrier');
    });

    // Assert
    should(marked(surface, 'data-security-state')[0]?.props['data-security-state']).equal('failed');
    run(() => surface.unmount());
  });

  it('shows a reading state until the machine answers, and ignores an answer after unmount', async () => {
    // Arrange
    let release: (client: StepUpClient) => void = () => undefined;
    const slow = (): Promise<StepUpClient> => new Promise(resolve => (release = resolve));
    const surface = await mountSurface(slow);
    should(marked(surface, 'data-security-state')[0]?.props['data-security-state']).equal('loading');

    // Act
    run(() => surface.unmount());
    await runAsync(async () => release(await machine([view()])()));

    // Assert — nothing threw and nothing is left to render.
    should(surface.toJSON()).be.null();
  });

  it('ignores a failed read that lands after unmount', async () => {
    // Arrange
    let fail: (reason: Error) => void = () => undefined;
    const surface = await mountSurface(() => new Promise((_resolve, reject) => (fail = reject)));

    // Act
    run(() => surface.unmount());
    await runAsync(async () => fail(new Error('late')));

    // Assert
    should(surface.toJSON()).be.null();
  });

  it('uses the page’s own origin, the browser credential container and a real support check by default', async () => {
    // Arrange / Act — the happy-dom page has no PublicKeyCredential, so passkeys are unsupported.
    const mounted = await mount(<SecuritySurface connection={connection} createClient={machine([view()])} />);

    // Assert
    expect(mounted.container.textContent).toContain(`This browser cannot use passkeys at ${window.location.origin}`);
    await mounted.unmount();
  });

  it('reads through the app’s client pool when none is injected, and says so when there is no pool', async () => {
    // Arrange / Act — outside a provider the pool refuses, which is a failed read, not a crash.
    const mounted = await mount(<SecuritySurface connection={connection} />);

    // Assert
    expect(mounted.container.textContent).toContain('did not answer the list of passkeys');
    await mounted.unmount();
  });
});
