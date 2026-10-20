import { describe, expect, it } from 'bun:test';
import {
  SECRET_SCHEMA_VERSION,
  type SealedSecretBundle,
  type SecretImportOffer,
  type SecretImportResult,
  type SecretList,
} from '@ferretry/protocol';
import { FyHttpError } from '@ferretry/protocol/client';
import type { ReactTestInstance, ReactTestRenderer } from 'react-test-renderer';
import {
  completeSecretImport,
  copySecrets,
  exportSecrets,
  openSecretImport,
  type SecretCloneClient,
} from '../../../src/features/secrets/secret-clone-api.ts';
import {
  copiedSentence,
  copyButtonLabel,
  copyRefusalSentence,
  initialPicks,
  SECRET_COPY_PROMISE,
  secretCopyRows,
} from '../../../src/features/secrets/secret-clone-model.ts';
import { SecretCopyLauncher, SecretCopyPanel } from '../../../src/features/secrets/secret-copy-panel.tsx';
import { SecretsSurface } from '../../../src/features/secrets/secrets-surface.tsx';
import { type DaemonConnection, daemonConnection } from '../../../src/lib/daemon-connection.ts';
import { render, runAsync } from '../../support/react.ts';

const AT = '2026-10-20T10:00:00.000Z';
const SOURCE_ID = `fy_daemon_${'S'.repeat(43)}`;
const TARGET_ID = `fy_daemon_${'T'.repeat(43)}`;
const IMPORT_ID = `fy_secret_import_${'a'.repeat(22)}`;

const connection = (id: string, name: string): DaemonConnection =>
  daemonConnection({
    daemonId: id,
    baseUrl: `https://${name}.example.test`,
    deviceId: `device-${name}`,
    daemonName: name,
  });

const LAPTOP = connection('laptop', 'laptop');
const STUDIO = connection('studio', 'studio');
const SPARE = connection('spare', 'spare');

const list = (names: readonly string[], overrides: Partial<SecretList> = {}): SecretList => ({
  v: SECRET_SCHEMA_VERSION,
  health: 'ready',
  secrets: names.map(name => ({ name, createdAt: AT, updatedAt: AT })),
  references: [],
  ...overrides,
});

const OFFER: SecretImportOffer = {
  v: 1,
  importId: IMPORT_ID,
  daemonId: TARGET_ID,
  identityKey: 'aWQ',
  publicKey: 'cHVi',
  expiresAt: AT,
  signature: 'c2ln',
};

const BUNDLE: SealedSecretBundle = {
  v: 1,
  importId: IMPORT_ID,
  sourceDaemonId: SOURCE_ID,
  targetDaemonId: TARGET_ID,
  expiresAt: AT,
  names: ['API_KEY'],
  ephemeralKey: 'ZXBo',
  nonce: 'bm9uY2U',
  ciphertext: 'Y2lwaGVy',
};

const RESULT = (imported: readonly string[], replaced: readonly string[] = []): SecretImportResult => ({
  importId: IMPORT_ID,
  sourceDaemonId: SOURCE_ID,
  imported,
  replaced,
});

interface Call {
  readonly machine: string;
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
}

type Handler = (path: string, method: string, body: unknown) => unknown;

/** A browser paired with several fake machines; each answers through its own handler. */
function machines(handlers: Readonly<Record<string, Handler>>) {
  const calls: Call[] = [];
  const createClient = async (target: DaemonConnection): Promise<SecretCloneClient> => {
    const handler = handlers[String(target.daemonId)];
    if (handler === undefined) throw new Error(`${String(target.daemonId)} is unreachable`);
    return {
      request: async (path: string, schema: { parse: (value: unknown) => unknown }, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
        calls.push({ machine: String(target.daemonId), method, path, body });
        return schema.parse(await handler(path, method, body));
      },
    } as unknown as SecretCloneClient;
  };
  return { calls, createClient };
}

/** A sending machine holding `names`, and a receiving one holding `held`. */
function pair(names: readonly string[], held: readonly string[] = [], result = RESULT(names)) {
  return machines({
    studio: path => {
      if (path === '/v1/secrets')
        return list(names, { references: [{ name: names[0] ?? 'X', origin: 'login glm-env', resolved: true }] });
      return { bundle: BUNDLE, names: ['API_KEY'] };
    },
    laptop: path => {
      if (path === '/v1/secrets') return list(held);
      if (path === '/v1/secrets/imports') return OFFER;
      return result;
    },
  });
}

/** Every string a node renders, joined — React splits `on {name}…` into several children. */
const words = (node: ReactTestInstance | string): string =>
  typeof node === 'string' ? node : node.children.map(child => words(child)).join('');

const text = (renderer: ReactTestRenderer): string => words(renderer.root);

const button = (renderer: ReactTestRenderer, label: string): ReactTestInstance => {
  const found = renderer.root.findAllByType('button').find(candidate => words(candidate).includes(label));
  if (found === undefined) throw new Error(`no button "${label}"`);
  return found;
};

const box = (renderer: ReactTestRenderer, name: string): ReactTestInstance =>
  renderer.root.findByProps({ 'data-secret-copy-row': name }).findByType('input');

async function settle(): Promise<void> {
  for (let round = 0; round < 4; round += 1) await runAsync(async () => undefined);
}

describe('the secret copy calls', () => {
  it('should open, seal and file in that order, each on its own machine', async () => {
    // Arrange
    const { calls, createClient } = pair(['API_KEY']);

    // Act
    const result = await copySecrets(await createClient(STUDIO), await createClient(LAPTOP), ['API_KEY']);

    // Assert — the offer goes to the source with the names; the bundle goes back to the target.
    expect(result.imported).toEqual(['API_KEY']);
    expect(calls.map(call => `${call.machine} ${call.method} ${call.path}`)).toEqual([
      'laptop POST /v1/secrets/imports',
      `studio POST /v1/secrets/exports/${IMPORT_ID}`,
      `laptop POST /v1/secrets/imports/${IMPORT_ID}`,
    ]);
    expect(calls[1]?.body).toEqual({ offer: OFFER, names: ['API_KEY'] });
    expect(calls[2]?.body).toEqual({ bundle: BUNDLE });
  });

  it('should expose each step on its own', async () => {
    // Arrange
    const { createClient } = pair(['API_KEY']);
    const target = await createClient(LAPTOP);

    // Act / Assert
    expect(await openSecretImport(target)).toEqual(OFFER);
    expect((await exportSecrets(await createClient(STUDIO), OFFER, ['API_KEY'])).bundle).toEqual(BUNDLE);
    expect(await completeSecretImport(target, BUNDLE)).toEqual(RESULT(['API_KEY']));
  });
});

describe('the secret copy wording', () => {
  it('should list the source by name with its uses, marking what the target already holds', () => {
    // Arrange
    const source = list(['ZETA', 'API_KEY'], {
      references: [
        { name: 'API_KEY', origin: 'login glm-env', resolved: true },
        { name: 'API_KEY', origin: 'config/daemon.json → AUTH', resolved: true },
      ],
    });

    // Act
    const rows = secretCopyRows(source, new Set(['ZETA']));

    // Assert
    expect(rows).toEqual([
      { name: 'API_KEY', uses: ['login glm-env', 'config/daemon.json → AUTH'], onTarget: false },
      { name: 'ZETA', uses: [], onTarget: true },
    ]);
    expect(secretCopyRows(source, null).every(row => !row.onTarget)).toBe(true);
    expect(initialPicks(rows, ['ZETA', 'MISSING'])).toEqual(['ZETA']);
  });

  it('should count and say what arrived', () => {
    expect(copyButtonLabel(0)).toBe('Pick secrets to copy');
    expect(copyButtonLabel(1)).toBe('Copy 1 secret');
    expect(copyButtonLabel(12)).toBe('Copy 12 secrets');
    expect(copiedSentence(RESULT(['A', 'B']), 'laptop')).toBe('2 secrets copied to laptop.');
    expect(copiedSentence(RESULT(['A', 'B'], ['A']), 'laptop')).toBe(
      '2 secrets copied to laptop. 1 of them replaced the one already there.',
    );
    expect(copiedSentence(RESULT(['A', 'B'], ['A', 'B']), 'laptop')).toBe(
      '2 secrets copied to laptop. 2 of them replaced the ones already there.',
    );
  });

  it('should word each refusal, and fall back to the general wording', () => {
    expect(copyRefusalSentence(new FyHttpError('no', 403, 'grant_step_up_required'))).toContain('passkey');
    expect(copyRefusalSentence(new FyHttpError('no', 409, 'import_spent'))).toContain('already used');
    expect(copyRefusalSentence(new FyHttpError('the daemon said so', 500, 'something_else'))).toBe(
      'the daemon said so',
    );
    expect(copyRefusalSentence(new FyHttpError('the daemon said so', 500, undefined))).toBe('the daemon said so');
  });

  it('should promise only what is true', () => {
    expect(SECRET_COPY_PROMISE).toContain('cannot read them');
    expect(SECRET_COPY_PROMISE).toContain('passkey');
  });
});

describe('the secret copy panel', () => {
  it('should copy the picked secrets FROM the other machine and say how many arrived', async () => {
    // Arrange
    const { calls, createClient } = pair(['API_KEY', 'DB_PASSWORD'], [], RESULT(['API_KEY']));
    const copied: SecretImportResult[] = [];
    const renderer = render(
      <SecretCopyPanel
        direction="from"
        here={LAPTOP}
        others={[STUDIO]}
        createClient={createClient}
        machineName={machine => machine.daemonName ?? ''}
        preselect={['API_KEY']}
        onCopied={result => copied.push(result)}
      />,
    );
    await settle();
    const picking = text(renderer);

    // Act
    await runAsync(async () => button(renderer, 'Copy 1 secret').props.onClick());
    await settle();

    // Assert
    expect(picking).toContain('Used by login glm-env');
    expect(picking).toContain('No setting names it');
    expect(text(renderer)).toContain('1 secret copied to laptop.');
    expect(copied).toEqual([RESULT(['API_KEY'])]);
    expect(calls.find(call => call.path.startsWith('/v1/secrets/exports'))?.machine).toBe('studio');
  });

  it('should copy TO a machine the person picks, marking what it replaces', async () => {
    // Arrange
    const { calls, createClient } = pair(['API_KEY'], ['API_KEY'], RESULT(['API_KEY'], ['API_KEY']));
    const renderer = render(
      <SecretCopyPanel
        direction="to"
        here={STUDIO}
        others={[LAPTOP, SPARE]}
        createClient={createClient}
        machineName={machine => machine.daemonName ?? ''}
      />,
    );
    await settle();
    expect(text(renderer)).not.toContain('Secrets on');

    // Act
    const radios = renderer.root.findAllByProps({ type: 'radio' });
    await runAsync(async () => radios[0]?.props.onChange());
    await settle();
    await runAsync(async () => box(renderer, 'API_KEY').props.onChange({ target: { checked: true } }));
    const picking = text(renderer);
    await runAsync(async () => button(renderer, 'Copy 1 secret').props.onClick());
    await settle();

    // Assert
    expect(picking).toContain('replaces laptop’s');
    expect(text(renderer)).toContain('1 of them replaced the one already there.');
    expect(calls.filter(call => call.machine === 'laptop').map(call => call.path)).toContain('/v1/secrets/imports');
  });

  it('should keep the picks and say why when the copy is refused', async () => {
    // Arrange
    const { createClient } = machines({
      studio: path => {
        if (path === '/v1/secrets') return list(['API_KEY']);
        throw new FyHttpError('needs a passkey', 403, 'grant_step_up_required');
      },
      laptop: path => (path === '/v1/secrets' ? list([]) : OFFER),
    });
    const renderer = render(
      <SecretCopyPanel
        direction="from"
        here={LAPTOP}
        others={[STUDIO]}
        createClient={createClient}
        machineName={machine => machine.daemonName ?? ''}
        preselect={['API_KEY']}
      />,
    );
    await settle();

    // Act
    await runAsync(async () => button(renderer, 'Copy 1 secret').props.onClick());
    await settle();

    // Assert
    expect(text(renderer)).toContain('the passkey wasn’t confirmed');
    expect(box(renderer, 'API_KEY').props.checked).toBe(true);
  });

  it('should select all and none, and toggle one off', async () => {
    // Arrange
    const { createClient } = pair(['A_KEY', 'B_KEY']);
    const renderer = render(
      <SecretCopyPanel
        direction="from"
        here={LAPTOP}
        others={[STUDIO]}
        createClient={createClient}
        machineName={machine => machine.daemonName ?? ''}
      />,
    );
    await settle();

    // Act / Assert
    expect(button(renderer, 'Pick secrets to copy').props.disabled).toBe(true);
    await runAsync(async () => button(renderer, 'Select all').props.onClick());
    expect(button(renderer, 'Copy 2 secrets').props.disabled).toBe(false);
    await runAsync(async () => box(renderer, 'A_KEY').props.onChange({ target: { checked: false } }));
    expect(box(renderer, 'A_KEY').props.checked).toBe(false);
    await runAsync(async () => button(renderer, 'Select all').props.onClick());
    await runAsync(async () => button(renderer, 'Select none').props.onClick());
    expect(button(renderer, 'Pick secrets to copy').props.disabled).toBe(true);
  });

  it('should say when the source is damaged, empty or unreachable, and when there is nobody to copy with', async () => {
    // Arrange
    const damaged = machines({
      studio: () => list([], { health: 'damaged', diagnosis: 'key gone' }),
      laptop: () => {
        throw new Error('down');
      },
    });
    const empty = pair([]);
    const unreachable = machines({ laptop: () => list([]) });
    const props = {
      direction: 'from' as const,
      here: LAPTOP,
      machineName: (m: DaemonConnection) => m.daemonName ?? '',
    };

    // Act
    const views = [
      render(<SecretCopyPanel {...props} others={[STUDIO]} createClient={damaged.createClient} />),
      render(<SecretCopyPanel {...props} others={[STUDIO]} createClient={empty.createClient} />),
      render(<SecretCopyPanel {...props} others={[STUDIO]} createClient={unreachable.createClient} />),
      render(<SecretCopyPanel {...props} others={[]} createClient={empty.createClient} />),
    ];
    const loading = text(views[0] as ReactTestRenderer);
    await settle();

    // Assert
    expect(loading).toContain('Reading the secrets on studio');
    expect(text(views[0] as ReactTestRenderer)).toContain('cannot read its own secret store');
    expect(text(views[1] as ReactTestRenderer)).toContain('studio holds no secrets.');
    expect(text(views[2] as ReactTestRenderer)).toContain('is unreachable');
    expect(text(views[3] as ReactTestRenderer)).toContain('paired with no other machine');
  });

  it('should open from its launcher and close back to it', async () => {
    // Arrange
    const { createClient } = pair(['API_KEY']);
    const renderer = render(
      <SecretCopyLauncher
        label="Copy secrets from studio…"
        direction="from"
        here={LAPTOP}
        others={[STUDIO]}
        createClient={createClient}
        machineName={machine => machine.daemonName ?? ''}
      />,
    );

    // Act
    await runAsync(async () => button(renderer, 'Copy secrets from studio…').props.onClick());
    await settle();
    const opened = text(renderer);
    await runAsync(async () => button(renderer, 'Close').props.onClick());

    // Assert
    expect(opened).toContain('Copy secrets from another machine');
    expect(text(renderer)).toContain('Copy secrets from studio…');
  });
});

describe('the secret store offers a copy to another machine', () => {
  it('should open the copy panel from Settings › Secrets', async () => {
    // Arrange
    const { createClient } = pair(['API_KEY']);
    const renderer = render(
      <SecretsSurface connection={STUDIO} createClient={createClient as never} others={[LAPTOP]} />,
    );
    await settle();

    // Act
    await runAsync(async () => button(renderer, 'Copy to another machine…').props.onClick());
    await settle();
    await runAsync(async () => button(renderer, 'Close').props.onClick());
    await runAsync(async () => button(renderer, 'Copy to another machine…').props.onClick());
    await settle();

    // Assert
    expect(text(renderer)).toContain('Copy secrets to another machine');
    expect(text(renderer)).toContain('Secrets on studio');
  });
});
