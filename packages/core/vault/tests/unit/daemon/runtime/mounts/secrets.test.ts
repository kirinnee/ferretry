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
import { MAX_SECRET_VALUE_LENGTH } from '../../../../../contract/index.ts';
import manifest from '../../../../../manifest.ts';
import { WebCryptoCloneCrypto } from '../../../../../daemon/adapters/secrets/webcrypto-clone-crypto.ts';
import { MAX_REQUEST_BODY_BYTES } from '../../../../../daemon/lib/api/body.ts';
import type { DaemonIdentity } from '../../../../../daemon/lib/secrets/clone-crypto.ts';
import { secretRouteHandlers } from '../../../../../daemon/lib/runtime/mounts/secrets.ts';
import { ChildEnvironments } from '../../../../../daemon/lib/secrets/child-environments.ts';
import { NO_REFERENCES } from '../../../../../daemon/lib/secrets/view.ts';
import { SecretDirectory, SecretVault } from '../../../../../daemon/lib/secrets/vault.ts';
import { SecretExportService, SecretImportService } from '../../../../../daemon/lib/secrets/clone.ts';
import { SecretStoreError } from '../../../../../daemon/lib/secrets/types.ts';
import { SecretUseService } from '../../../../../daemon/lib/secrets/use.ts';
import { EchoSecretChildRunner, FakeSecretCipher, MemorySecretDocuments } from '../../support.ts';

/**
 * The secret routes (today's `tests/unit/runtime/mounts/secrets.test.ts` and `secrets-agent-caller.test.ts`), at
 * handler level with Gate's standings: who may write the store, what a listing and a use answer, and the descriptors
 * the manifest declares for them.
 */

const CLOCK = { now: () => '2026-01-01T00:00:00.000Z' } as unknown as Clock;
const TOKEN = 'sk-live-0123456789';
const ENVS = new ChildEnvironments();

const CLONE_CRYPTO = new WebCryptoCloneCrypto();

/** A real Ed25519 identity for one machine, as the clone tests mint it. */
async function makeIdentity(): Promise<DaemonIdentity> {
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
    'sign',
    'verify',
  ])) as unknown as CryptoKeyPair;
  const der = await crypto.subtle.exportKey('pkcs8', pair.privateKey);
  const base64 = btoa(String.fromCharCode(...new Uint8Array(der)));
  return await CLONE_CRYPTO.importDaemonIdentity(
    ['-----BEGIN PRIVATE KEY-----', ...(base64.match(/.{1,64}/gu) ?? []), '-----END PRIVATE KEY-----', ''].join('\n'),
  );
}

function subsystem(documents = new MemorySecretDocuments(), identityKey?: DaemonIdentity) {
  const cipher = new FakeSecretCipher();
  const directory = new SecretDirectory(documents, cipher, CLOCK);
  const vault = new SecretVault(documents, cipher);
  const runner = new EchoSecretChildRunner(ENVS, env => `token=${env.TOKEN ?? ''}`);
  const crypto = CLONE_CRYPTO;
  const identity = { load: async () => identityKey };
  let changes = 0;
  let seals = 0;
  // Counts every seal that actually ran, so a refusal before it is visible as zero.
  const exports = new SecretExportService({ crypto, identity, vault, clock: CLOCK });
  const seal = exports.seal.bind(exports);
  Object.assign(exports, {
    seal: async (...args: Parameters<typeof seal>) => {
      seals += 1;
      return await seal(...args);
    },
  });
  const handlers = secretRouteHandlers({
    directory,
    references: NO_REFERENCES,
    uses: new SecretUseService(vault, runner, ENVS),
    imports: new SecretImportService({ crypto, identity, directory, clock: CLOCK }),
    exports,
    changed: () => {
      changes += 1;
    },
  });
  return { directory, handlers, runner, changes: () => changes, seals: () => seals };
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
      // Honours the bound the handler reads under, as the kernel's request does: past it, the read throws.
      text: async (limitBytes?: number) => {
        const text = body === undefined ? '' : JSON.stringify(body);
        if (limitBytes !== undefined && new TextEncoder().encode(text).byteLength > limitBytes)
          throw new Error('over the body limit');
        return text;
      },
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

  /**
   * Copies secrets from a source machine to a target through the real handlers: the target opens an import, the
   * source seals the chosen names to it, the target files the bundle. Answers each step's JSON.
   */
  async function copied(
    prepare: (machines: { source: SecretDirectory; target: SecretDirectory }) => Promise<void>,
    names: readonly string[],
  ) {
    const [sourceIdentity, targetIdentity] = await Promise.all([makeIdentity(), makeIdentity()]);
    const source = subsystem(new MemorySecretDocuments(), sourceIdentity);
    const target = subsystem(new MemorySecretDocuments(), targetIdentity);
    await prepare({ source: source.directory, target: target.directory });
    const opened = await target.handlers['POST /v1/secrets/imports'](call(ownerStanding()));
    const offer = JSON.parse(opened.body) as { readonly importId: string };
    const exportPath = { importId: offer.importId };
    const sealed = await source.handlers['POST /v1/secrets/exports/:importId'](
      call(ownerStanding(), { offer, names }, exportPath),
    );
    const { bundle } = JSON.parse(sealed.body) as { readonly bundle: unknown };
    const filed = await target.handlers['POST /v1/secrets/imports/:importId'](
      call(ownerStanding(), { bundle }, { importId: offer.importId }),
    );
    const bodyBytes = new TextEncoder().encode(JSON.stringify({ bundle })).byteLength;
    return { offer, exportPath, sealed, filed, target, bodyBytes };
  }

  /**
   * Today's audit rule for the two copy routes (`lib/audit/routes.ts`): the subject is the `importId` PATH parameter,
   * and the only field of the answer read is a list of names — `names` at the source, `imported` at the target.
   */
  const ruleRead = (importId: string, answer: string, field: 'names' | 'imported') => ({
    subject: importId,
    names: (JSON.parse(answer) as Record<string, readonly string[]>)[field],
  });

  it('S156 both ends name the same import id, names only, and the receiver records only names it imported', async () => {
    // Arrange — the target already holds DB_PASSWORD, so a copy of it is kept, not imported.
    const VALUE = 'correct-horse-battery-staple';
    const { offer, exportPath, sealed, filed } = await copied(
      async ({ source, target }) => {
        await source.put('API_KEY', TOKEN);
        await source.put('DB_PASSWORD', VALUE);
        await target.put('DB_PASSWORD', 'the-target-own-value');
      },
      ['API_KEY', 'DB_PASSWORD'],
    );

    // Act — what today's rule records at each end.
    const result = JSON.parse(filed.body) as { importId: string; imported: string[]; kept: string[] };
    const sourceRecord = ruleRead(exportPath.importId, sealed.body, 'names');
    const targetRecord = ruleRead(offer.importId, filed.body, 'imported');

    // Assert — the same import id at both ends (and in the target's own answer).
    should(sealed.status).equal(200);
    should(filed.status).equal(200);
    should(sourceRecord.subject).equal(targetRecord.subject);
    should(result.importId).equal(offer.importId);
    // Names only: the fields the rule reads are names, and no value is anywhere the rule could read it.
    should(sourceRecord.names).deepEqual(['API_KEY', 'DB_PASSWORD']);
    for (const answer of [sealed.body, filed.body]) {
      should(answer).not.containEql(TOKEN);
      should(answer).not.containEql(VALUE);
    }
    // The receiver records only what it actually imported; a kept name is reported, never recorded as filed.
    should(targetRecord.names).deepEqual(['API_KEY']);
    should(result.kept).deepEqual(['DB_PASSWORD']);
    // And the descriptors name the kinds: `secrets.used` at the source, `secrets.changed` at the target.
    const kind = (key: string) => (descriptor(key)?.audit as { readonly record?: string } | undefined)?.record;
    should(kind('POST /v1/secrets/exports/:importId')).equal('secrets.used');
    should(kind('POST /v1/secrets/imports/:importId')).equal('secrets.changed');
    should(kind('POST /v1/secrets/use')).equal('secrets.used');
    should(kind('POST /v1/secrets')).equal('secrets.changed');
    should(kind('DELETE /v1/secrets/:name')).equal('secrets.changed');
  });

  it("should file a valid import bundle past half a mebibyte, under today's request body bound", async () => {
    // Arrange — 40 secrets at the 16 KiB value ceiling seal to a bundle of roughly 875 KB.
    const names = Array.from({ length: 40 }, (_, index) => `BIG_${String(index).padStart(2, '0')}`);
    const { filed, target, bodyBytes } = await copied(async ({ source }) => {
      for (const [index, name] of names.entries())
        await source.put(name, `${name}-`.padEnd(MAX_SECRET_VALUE_LENGTH, String.fromCharCode(97 + (index % 26))));
    }, names);

    // Assert — today's bound (MAX_REQUEST_BODY_BYTES), not a tighter one, so the whole batch is filed.
    should(bodyBytes).be.above(512 * 1024);
    should(bodyBytes).be.below(MAX_REQUEST_BODY_BYTES);
    should(filed.status).equal(200);
    should((JSON.parse(filed.body) as { imported: string[] }).imported).deepEqual(names);
    should((await target.directory.list()).length).equal(40);
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

  describe('S159 S147 one proof, one seal: the proof is claimed before anything is sealed', () => {
    /** ONE fresh passkey proof: `claim` takes it in one step (Gate's registry), `taken` counts the winners. */
    function oneProof() {
      let held = true;
      let taken = 0;
      const claim = (() => {
        if (!held) return false;
        held = false;
        taken += 1;
        return true;
      }) as NonNullable<ReturnType<typeof ownerStanding>['claimFreshStepUp']>;
      return { claim, taken: () => taken };
    }
    /** A governed device the admission snapshot says is FRESH — every call is built so before any of them runs. */
    const governedOn = (claim: NonNullable<ReturnType<typeof ownerStanding>['claimFreshStepUp']>) => {
      const base = deviceStanding('phone', undefined, true);
      return {
        ...base,
        presentation: { ...base.presentation, freshStepUp: true },
        governance: { governed: true, decide: () => ({ allowed: true, refusal: 'granted' as const }) },
        claimFreshStepUp: claim,
      };
    };

    /** A source machine and a real offer from a target, so a seal that runs produces a real bundle. */
    async function sourceAndOffer() {
      const [sourceIdentity, targetIdentity] = await Promise.all([makeIdentity(), makeIdentity()]);
      const source = subsystem(new MemorySecretDocuments(), sourceIdentity);
      const target = subsystem(new MemorySecretDocuments(), targetIdentity);
      await source.directory.put('API_KEY', TOKEN);
      const opened = await target.handlers['POST /v1/secrets/imports'](call(ownerStanding()));
      const offer = JSON.parse(opened.body) as { readonly importId: string };
      const seal = (standing: ReturnType<typeof governedOn> | ReturnType<typeof ownerStanding>) =>
        source.handlers['POST /v1/secrets/exports/:importId'](
          call(standing as never, { offer, names: ['API_KEY'] }, { importId: offer.importId }),
        );
      return { source, seal };
    }

    it('S159 two seals admitted on ONE fresh proof, both snapshotted fresh before either runs: exactly one seals, nothing is sealed for the other', async () => {
      // Arrange
      const { source, seal } = await sourceAndOffer();
      const proof = oneProof();
      const first = governedOn(proof.claim);
      const second = governedOn(proof.claim);

      // Act
      const answers = await Promise.all([seal(first), seal(second)]);

      // Assert
      should(answers.map(answer => answer.status).sort()).deepEqual([200, 403]);
      const refused = answers.find(answer => answer.status === 403);
      should(JSON.parse(refused?.body ?? '{}')).match({
        code: 'grant_step_up_required',
        demand: { act: 'clone-secrets' },
      });
      should(refused?.body).not.containEql('bundle');
      should(source.seals()).equal(1);
      should(proof.taken()).equal(1);
      for (const answer of answers) should(answer.body).not.containEql(TOKEN);
    });

    it('S159 a seal and a config loosening on one fresh proof, the loosening judged first: exactly one acts, nothing is sealed', async () => {
      // Arrange — the other act takes the proof through the claim every admitted call carries, as Gate's judge does.
      const { source, seal } = await sourceAndOffer();
      const proof = oneProof();
      const standing = governedOn(proof.claim);

      // Act
      const loosening = standing.claimFreshStepUp() ? 'apply' : 'hold';
      const answer = await seal(standing);

      // Assert
      should([loosening, answer.status]).deepEqual(['apply', 403]);
      should(source.seals()).equal(0);
      should(proof.taken()).equal(1);
    });

    it('S159 one fresh proof and no race: the seal runs and the proof is gone, so the next seal asks again', async () => {
      // Arrange
      const { source, seal } = await sourceAndOffer();
      const proof = oneProof();

      // Act
      const sealed = await seal(governedOn(proof.claim));
      const again = await seal(governedOn(proof.claim));

      // Assert
      should(sealed.status).equal(200);
      should(JSON.parse(sealed.body)).have.property('bundle');
      should(again.status).equal(403);
      should(source.seals()).equal(1);
      should(proof.taken()).equal(1);
    });

    it('S159 the owner at the machine claims no proof at all', async () => {
      // Arrange
      const { source, seal } = await sourceAndOffer();
      const proof = oneProof();

      // Act
      const sealed = await seal({ ...ownerStanding(), claimFreshStepUp: proof.claim });

      // Assert
      should(sealed.status).equal(200);
      should(source.seals()).equal(1);
      should(proof.taken()).equal(0);
    });
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
    const error = await refusal(
      handlers['POST /v1/secrets/use'](call(ownerStanding(), { command: ['env'], cwd: 'rel' })),
    );
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

describe('the secret routes: a domain failure answers as its HTTP status, never a 500', () => {
  it('S6 should answer a use of a secret this daemon does not hold as 404 unknown_secret, naming only the name', async () => {
    const { handlers } = subsystem();

    const error = await refusal(
      handlers['POST /v1/secrets/use'](call(FERRET, { command: ['env'], cwd: '/srv/app', secrets: ['MISSING'] })),
    );

    should(error.status).equal(404);
    should(error.code).equal('unknown_secret');
    should(error.message).containEql('MISSING');
  });

  it('S141 should answer a store that fails a write or a delete with the status its failure maps to', async () => {
    const { directory, handlers } = subsystem();
    Object.assign(directory, {
      put: async () => {
        throw new SecretStoreError('full', 'the store is full');
      },
      remove: async () => {
        throw new SecretStoreError('unreadable', 'the store could not be read');
      },
    });

    const put = await refusal(handlers['POST /v1/secrets'](call(ownerStanding(), { name: 'TOKEN', value: TOKEN })));
    const removed = await refusal(
      handlers['DELETE /v1/secrets/:name'](call(ownerStanding(), undefined, { name: 'TOKEN' })),
    );

    should([put.status, put.code]).eql([409, 'full']);
    should([removed.status, removed.code]).eql([500, 'unreadable']);
  });

  it('S141 should let a failure that is not a domain failure through as itself', async () => {
    const { directory, handlers } = subsystem();
    const broken = new Error('a genuine bug');
    Object.assign(directory, {
      put: async () => {
        throw broken;
      },
    });

    await handlers['POST /v1/secrets'](call(ownerStanding(), { name: 'TOKEN', value: TOKEN })).then(
      () => should.fail('', '', 'a genuine bug must not be dressed as an answer'),
      (error: unknown) => should(error).equal(broken),
    );
  });

  it('S156 should refuse filing the same bundle twice (409 import_spent), and an unknown import (404)', async () => {
    const [sourceIdentity, targetIdentity] = await Promise.all([makeIdentity(), makeIdentity()]);
    const source = subsystem(new MemorySecretDocuments(), sourceIdentity);
    const target = subsystem(new MemorySecretDocuments(), targetIdentity);
    await source.directory.put('API_KEY', TOKEN);
    const offer = JSON.parse((await target.handlers['POST /v1/secrets/imports'](call(ownerStanding()))).body) as {
      readonly importId: string;
    };
    const sealed = await source.handlers['POST /v1/secrets/exports/:importId'](
      call(ownerStanding(), { offer, names: ['API_KEY'] }, { importId: offer.importId }),
    );
    const { bundle } = JSON.parse(sealed.body) as { readonly bundle: { readonly importId: string } };
    const params = { importId: offer.importId };

    await target.handlers['POST /v1/secrets/imports/:importId'](call(ownerStanding(), { bundle }, params));
    const again = await refusal(
      target.handlers['POST /v1/secrets/imports/:importId'](call(ownerStanding(), { bundle }, params)),
    );
    const stranger = await refusal(
      source.handlers['POST /v1/secrets/imports/:importId'](call(ownerStanding(), { bundle }, params)),
    );

    should([again.status, again.code]).eql([409, 'import_spent']);
    should([stranger.status, stranger.code]).eql([404, 'import_unknown']);
  });

  it('S159 should refuse sealing a secret this machine does not hold (404), and an offer that names this machine (400)', async () => {
    const [sourceIdentity, targetIdentity] = await Promise.all([makeIdentity(), makeIdentity()]);
    const source = subsystem(new MemorySecretDocuments(), sourceIdentity);
    const target = subsystem(new MemorySecretDocuments(), targetIdentity);
    await source.directory.put('API_KEY', TOKEN);
    const offered = async (machine: ReturnType<typeof subsystem>) =>
      JSON.parse((await machine.handlers['POST /v1/secrets/imports'](call(ownerStanding()))).body) as {
        readonly importId: string;
      };
    const there = await offered(target);
    const here = await offered(source);

    const missing = await refusal(
      source.handlers['POST /v1/secrets/exports/:importId'](
        call(ownerStanding(), { offer: there, names: ['MISSING'] }, { importId: there.importId }),
      ),
    );
    const sameMachine = await refusal(
      source.handlers['POST /v1/secrets/exports/:importId'](
        call(ownerStanding(), { offer: here, names: ['API_KEY'] }, { importId: here.importId }),
      ),
    );

    should([missing.status, missing.code]).eql([404, 'unknown_secret']);
    should([sameMachine.status, sameMachine.code]).eql([400, 'same_machine']);
  });
});
