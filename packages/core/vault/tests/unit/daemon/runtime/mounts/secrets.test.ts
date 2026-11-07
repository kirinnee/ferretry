import { describe, it } from 'bun:test';
import { deviceStanding, ferretStanding, ownerStanding } from '@ferretry/core-gate/contract/testing';
import {
  ApiError,
  type ApiResponse,
  type CallContext,
  type Clock,
  type FerretId,
  type LocalArrival,
} from '@ferretry/kernel/contract';
import should from 'should';
import manifest from '../../../../../manifest.ts';
import { WebCryptoCloneCrypto } from '../../../../../daemon/adapters/secrets/webcrypto-clone-crypto.ts';
import { secretRouteHandlers } from '../../../../../daemon/lib/runtime/mounts/secrets.ts';
import {
  ChildEnvironments,
  NO_REFERENCES,
  SecretDirectory,
  SecretExportService,
  SecretImportService,
  SecretStoreError,
  SecretUseService,
  SecretVault,
} from '../../../../../daemon/lib/secrets/index.ts';
import { EchoSecretChildRunner, FakeSecretCipher, MemorySecretDocuments } from '../../support.ts';

/**
 * The secret routes (today's `tests/unit/runtime/mounts/secrets.test.ts` and `secrets-agent-caller.test.ts`), at
 * handler level with Gate's standings: who may write the store, what a listing and a use answer, and the descriptors
 * the manifest declares for them.
 */

const CLOCK = { now: () => '2026-01-01T00:00:00.000Z' } as unknown as Clock;
const TOKEN = 'sk-live-0123456789';
const ENVS = new ChildEnvironments();

function subsystem(documents = new MemorySecretDocuments()) {
  const cipher = new FakeSecretCipher();
  const directory = new SecretDirectory(documents, cipher, CLOCK);
  const vault = new SecretVault(documents, cipher);
  const runner = new EchoSecretChildRunner(ENVS, env => `token=${env.TOKEN ?? ''}`);
  const crypto = new WebCryptoCloneCrypto();
  const identity = { load: async () => undefined };
  let changes = 0;
  const handlers = secretRouteHandlers({
    directory,
    references: NO_REFERENCES,
    uses: new SecretUseService(vault, runner, ENVS),
    imports: new SecretImportService({ crypto, identity, directory, clock: CLOCK }),
    exports: new SecretExportService({ crypto, identity, vault, clock: CLOCK }),
    changed: () => {
      changes += 1;
    },
  });
  return { directory, handlers, runner, changes: () => changes };
}

/** A call as the kernel hands one to a handler: the request, the raw path parameters, Gate's standing. */
function call(
  standing: ReturnType<typeof ownerStanding>,
  body?: unknown,
  params: Record<string, string> = {},
): CallContext {
  return {
    request: {
      method: 'POST',
      path: '/v1/secrets',
      query: new Map(),
      headers: new Map(),
      arrival: { kind: 'local', privileged: false } as unknown as LocalArrival,
      text: async () => (body === undefined ? '' : JSON.stringify(body)),
    },
    params: new Map(Object.entries(params)),
    ...standing,
  } as CallContext;
}

const FERRET = ferretStanding('F1' as FerretId);

async function refusal(work: Promise<ApiResponse>): Promise<ApiError> {
  try {
    await work;
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error('expected a refusal');
}

const descriptor = (key: string) => manifest.actions.routes.find(route => route.key === key);

describe('the secret routes', () => {
  it('S6 S28 no route returns a value: there is no read of one secret, and a listing carries names and instants', async () => {
    // Arrange
    const { directory, handlers } = subsystem();
    await directory.put('TOKEN', TOKEN);

    // Act
    const listing = await handlers['GET /v1/secrets']();

    // Assert
    should(manifest.actions.routes.map(route => route.key)).not.containEql('GET /v1/secrets/:name');
    should(listing.body).not.containEql(TOKEN);
    should(JSON.parse(listing.body).secrets).deepEqual([
      { name: 'TOKEN', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
    ]);
  });

  it('S157 a put answers the summary only, never what it stored', async () => {
    // Arrange
    const { handlers, changes } = subsystem();

    // Act
    const answer = await handlers['POST /v1/secrets'](call(ownerStanding(), { name: 'TOKEN', value: TOKEN }));

    // Assert
    should(answer.status).equal(200);
    should(answer.body).not.containEql(TOKEN);
    should(changes()).equal(1);
  });

  it('S31 a ferret can still list names and use a secret by name', async () => {
    // Arrange
    const { directory, handlers } = subsystem();
    await directory.put('TOKEN', TOKEN);

    // Act
    const used = await handlers['POST /v1/secrets/use'](
      call(FERRET, { command: ['printenv', 'TOKEN'], cwd: '/srv/app', secrets: ['TOKEN'] }),
    );

    // Assert — the child had the value; the ferret got only the mask.
    should(used.status).equal(200);
    should(JSON.parse(used.body).stdout).equal('token=[redacted:TOKEN]');
    should(used.body).not.containEql(TOKEN);
  });

  it('S32 a ferret cannot set, replace or delete a secret, and is told the two ways a value reaches the store', async () => {
    // Arrange
    const { directory, handlers } = subsystem();
    await directory.put('TOKEN', TOKEN);

    // Act
    const put = await refusal(handlers['POST /v1/secrets'](call(FERRET, { name: 'TOKEN', value: 'attacker-value' })));
    const removed = await refusal(handlers['DELETE /v1/secrets/:name'](call(FERRET, undefined, { name: 'TOKEN' })));

    // Assert
    for (const error of [put, removed]) {
      should(error.status).equal(403);
      should(error.message).containEql('input request');
      should(error.message).containEql('secure copy');
    }
    should((await directory.list()).length).equal(1);
  });

  it('S38 the list and the use sit on secrets.use; set, delete and the copy routes on secrets.configure', () => {
    // Assert
    const axis = (key: string) => descriptor(key)?.capability?.axis;
    should(axis('GET /v1/secrets')).equal('use');
    should(axis('POST /v1/secrets/use')).equal('use');
    for (const key of [
      'POST /v1/secrets',
      'DELETE /v1/secrets/:name',
      'POST /v1/secrets/imports',
      'POST /v1/secrets/imports/:importId',
      'POST /v1/secrets/exports/:importId',
    ]) {
      should(axis(key)).equal('configure');
      should(descriptor(key)?.caller).equal('person');
    }
    for (const route of manifest.actions.routes) should(route.noStore).be.true();
  });

  it('S151 filing a copy is secrets.configure, the person only', () => {
    should(descriptor('POST /v1/secrets/imports/:importId')?.capability?.axis).equal('configure');
    should(descriptor('POST /v1/secrets/imports/:importId')?.caller).equal('person');
  });

  it("S156 a use and an export are recorded as secrets.used, a put, delete and import as secrets.changed", () => {
    const kind = (key: string) => (descriptor(key)?.audit as { readonly record?: string } | undefined)?.record;
    should(kind('POST /v1/secrets/use')).equal('secrets.used');
    should(kind('POST /v1/secrets/exports/:importId')).equal('secrets.used');
    should(kind('POST /v1/secrets')).equal('secrets.changed');
    should(kind('DELETE /v1/secrets/:name')).equal('secrets.changed');
    should(kind('POST /v1/secrets/imports/:importId')).equal('secrets.changed');
  });

  it('S159 S147 sealing for another machine needs a passkey for that act, even from an unlocked device', async () => {
    // Arrange — a governed device that is unlocked (stepped up) but has not proved a passkey for THIS act.
    const { handlers } = subsystem();
    const governed = {
      ...deviceStanding('phone', undefined, true),
      governance: { governed: true, decide: () => ({ allowed: true, refusal: 'granted' as const }) },
    };
    const offer = {
      v: 1,
      importId: 'fy_secret_import_AAAAAAAAAAAAAAAAAAAAAA',
      daemonId: `fy_daemon_${'A'.repeat(43)}`,
      identityKey: 'AAAA',
      publicKey: 'AAAA',
      expiresAt: '2026-01-01T00:05:00.000Z',
      signature: 'AAAA',
    };

    // Act
    const answer = await handlers['POST /v1/secrets/exports/:importId'](
      call(governed as never, { offer, names: ['TOKEN'] }, { importId: offer.importId }),
    );

    // Assert — refused before anything is opened; the clone is kept and the keys are offered again on a retry.
    should(answer.status).equal(403);
    should(JSON.parse(answer.body)).match({ code: 'grant_step_up_required', demand: { act: 'clone-secrets' } });
  });

  it('S141 a listing over a damaged store says damaged with a diagnosis, never an empty list', async () => {
    // Arrange
    const { handlers } = subsystem(new MemorySecretDocuments(new SecretStoreError('key_missing', 'gone')));

    // Act
    const listing = JSON.parse((await handlers['GET /v1/secrets']()).body);

    // Assert
    should(listing.health).equal('damaged');
    should(listing.diagnosis).containEql('key');
  });

  it('S64 a use naming a secret the store does not hold is refused 404, nothing spawned', async () => {
    // Arrange
    const { handlers, runner } = subsystem();

    // Act
    const error = await refusal(
      handlers['POST /v1/secrets/use'](call(ownerStanding(), { command: ['env'], cwd: '/srv', secrets: ['NOPE'] })),
    );

    // Assert
    should(error.status).equal(404);
    should(error.code).equal('unknown_secret');
    should(runner.spec).be.undefined();
  });

  it('should refuse a relative working directory with 400 invalid_cwd', async () => {
    const { handlers } = subsystem();
    const error = await refusal(handlers['POST /v1/secrets/use'](call(ownerStanding(), { command: ['env'], cwd: 'rel' })));
    should(error.status).equal(400);
    should(error.code).equal('invalid_cwd');
  });

  it('S150 an import takes { bundle } and nothing else', async () => {
    const { handlers } = subsystem();
    const error = await refusal(
      handlers['POST /v1/secrets/imports/:importId'](
        call(ownerStanding(), { bundle: {}, overwrite: true }, { importId: 'fy_secret_import_AAAAAAAAAAAAAAAAAAAAAA' }),
      ),
    );
    should(error.status).equal(400);
  });

  it('should answer identity_unavailable (503) while the kernel offers no identity to sign with', async () => {
    const { handlers } = subsystem();
    const error = await refusal(handlers['POST /v1/secrets/imports'](call(ownerStanding())));
    should(error.status).equal(503);
    should(error.code).equal('identity_unavailable');
  });
});
