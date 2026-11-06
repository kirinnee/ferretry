import { beforeAll, describe, it } from 'bun:test';
import {
  mcpOAuthSecretNames,
  type SealedSecretBundle,
  type SecretExportResponse,
  type SecretImportOffer,
} from '@ferretry/protocol';
import type { DaemonIdentity } from '@ferretry/relay';
import { WebCryptoRelayCrypto } from '@ferretry/relay/adapters';
import should from 'should';
import type { AuthenticatedCredential } from '../../../../src/lib/api/authentication.ts';
import type { CallerGovernance } from '../../../../src/lib/api/capability.ts';
import { ApiError } from '../../../../src/lib/api/error.ts';
import type { ApiResponse } from '../../../../src/lib/api/http.ts';
import type { RouteContext } from '../../../../src/lib/api/route.ts';
import { ApiRouter } from '../../../../src/lib/api/router.ts';
import { ApiDispatcher, type CapabilityGuard } from '../../../../src/lib/api/index.ts';
import { SecretVault } from '../../../../src/lib/secrets/index.ts';
import { type SecretSubsystem, secretRoutes } from '../../../../src/lib/runtime/mounts/secrets.ts';
import { jsonBody, request } from '../../api/support.ts';
import { putSavedLogin } from '../../secrets/saved-login-fixture.ts';
import { FakeSecretCipher, MemoryLoginIndex, MemorySecretDocuments, secretSubsystem } from './support.ts';

/**
 * Copying secrets between machines, over the real route table and two real subsystems.
 *
 * The assertion that matters most: a governed caller cannot seal a single value for another machine
 * without a passkey proved FOR THIS ACT, and nothing any route answers carries a value in clear.
 */

const VALUE = 'sk-live-0123456789';
const NOW = Date.parse('2026-10-20T10:00:00.000Z');
const crypto_ = new WebCryptoRelayCrypto();

interface Caller {
  readonly kind: 'host' | 'device';
  readonly governed: boolean;
  readonly fresh?: boolean;
}

const HOST: Caller = { kind: 'host', governed: false };
const DEVICE: Caller = { kind: 'device', governed: true };
const FRESH_DEVICE: Caller = { kind: 'device', governed: true, fresh: true };

const CREDENTIAL: Record<Caller['kind'], AuthenticatedCredential> = {
  host: { kind: 'authenticated', tokenClass: 'admin' },
  device: { kind: 'authenticated', tokenClass: 'device', deviceId: 'd1' },
};
const ACTOR: Record<Caller['kind'], string> = { host: 'admin-cli', device: 'device:d1' };

interface Answer {
  readonly status: number;
  readonly body: Record<string, unknown>;
  readonly raw: string;
  readonly spent: number;
}

class Clock {
  ms = NOW;
  now(): string {
    return new Date(this.ms).toISOString();
  }
}

async function makeIdentity(): Promise<DaemonIdentity> {
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
    'sign',
    'verify',
  ])) as unknown as CryptoKeyPair;
  const der = await crypto.subtle.exportKey('pkcs8', pair.privateKey);
  const base64 = btoa(String.fromCharCode(...new Uint8Array(der)));
  return await crypto_.importDaemonIdentity(
    ['-----BEGIN PRIVATE KEY-----', ...(base64.match(/.{1,64}/gu) ?? []), '-----END PRIVATE KEY-----', ''].join('\n'),
  );
}

let sourceIdentity: DaemonIdentity;
let targetIdentity: DaemonIdentity;

beforeAll(async () => {
  [sourceIdentity, targetIdentity] = await Promise.all([makeIdentity(), makeIdentity()]);
});

/** One route, driven as `caller`; an `ApiError` read back as the dispatcher would answer it. */
async function drive(
  subsystem: SecretSubsystem,
  path: string,
  body: unknown,
  caller: Caller = HOST,
  governance: 'present' | 'absent' = 'present',
): Promise<Answer> {
  const found = new ApiRouter(secretRoutes(subsystem)).lookup('POST', path);
  if (found.kind !== 'matched') throw new Error(`no route POST ${path}`);
  let spent = 0;
  const caller_: CallerGovernance = {
    governed: caller.governed,
    decide: () => ({ allowed: true, refusal: 'granted' }),
  };
  const context: RouteContext = {
    request: request({
      method: 'POST',
      path,
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    params: found.params,
    actor: ACTOR[caller.kind],
    credential: CREDENTIAL[caller.kind],
    ...(governance === 'present' ? { governance: caller_ } : {}),
    presentation: {
      loopback: caller.kind === 'host',
      adminToken: caller.kind === 'host',
      actor: ACTOR[caller.kind],
      stepUp: caller.fresh === true,
      freshStepUp: caller.fresh === true,
    },
    spendFreshStepUp: () => {
      spent += 1;
    },
  };
  let response: ApiResponse;
  try {
    response = await found.route.handle(context);
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    return { status: error.status, body: { error: error.message, code: error.code }, raw: '', spent };
  }
  return { status: response.status, body: jsonBody(response) as Record<string, unknown>, raw: response.body, spent };
}

async function machines() {
  const clock = new Clock();
  const sourceDocuments = new MemorySecretDocuments();
  const source = secretSubsystem({ documents: sourceDocuments, identity: sourceIdentity, clock });
  const target = secretSubsystem({ identity: targetIdentity, clock });
  await source.directory.put('API_KEY', VALUE);
  return { clock, source, target };
}

async function sealed(
  source: SecretSubsystem,
  target: SecretSubsystem,
): Promise<{ offer: SecretImportOffer; bundle: SealedSecretBundle }> {
  const opened = await drive(target, '/v1/secrets/imports', undefined);
  const offer = opened.body as unknown as SecretImportOffer;
  const exported = await drive(
    source,
    `/v1/secrets/exports/${offer.importId}`,
    { offer, names: ['API_KEY'] },
    FRESH_DEVICE,
  );
  return { offer, bundle: (exported.body as unknown as SecretExportResponse).bundle };
}

describe('the secret clone routes', () => {
  it('should add three routes, none of which answers a value', () => {
    // Arrange / Act
    const paths = secretRoutes(secretSubsystem()).map(route => `${route.method} ${route.path}`);

    // Assert
    should(paths).containDeep([
      'POST /v1/secrets/imports',
      'POST /v1/secrets/imports/:importId',
      'POST /v1/secrets/exports/:importId',
    ]);
    const clone = secretRoutes(secretSubsystem()).filter(route => /imports|exports/u.test(route.path));
    should(clone.every(route => route.capability?.axis === 'configure' && route.noStore === true)).be.true();
  });

  it('should open an import with only public facts', async () => {
    // Arrange
    const { target } = await machines();

    // Act
    const answer = await drive(target, '/v1/secrets/imports', undefined);

    // Assert
    should(answer.status).equal(201);
    should(answer.body.daemonId).equal(targetIdentity.daemonId);
  });

  it('should refuse to open an import when this machine cannot read its identity', async () => {
    // Act
    const answer = await drive(secretSubsystem(), '/v1/secrets/imports', undefined);

    // Assert
    should(answer.status).equal(503);
    should(answer.body.code).equal('identity_unavailable');
  });

  it('should ask a governed caller for a passkey for THIS act, even when unlocked', async () => {
    // Arrange
    const { source, target } = await machines();
    const offer = (await drive(target, '/v1/secrets/imports', undefined)).body as unknown as SecretImportOffer;

    // Act
    const answer = await drive(source, `/v1/secrets/exports/${offer.importId}`, { offer, names: ['API_KEY'] }, DEVICE);

    // Assert
    should(answer.status).equal(403);
    should(answer.body).containDeep({
      code: 'grant_step_up_required',
      demand: { capability: 'secrets', axis: 'configure', act: 'clone-secrets' },
    });
    should(answer.spent).equal(0);
  });

  it('should seal for a caller who just proved a passkey, and spend that proof', async () => {
    // Arrange
    const { source, target } = await machines();
    const offer = (await drive(target, '/v1/secrets/imports', undefined)).body as unknown as SecretImportOffer;

    // Act
    const answer = await drive(
      source,
      `/v1/secrets/exports/${offer.importId}`,
      { offer, names: ['API_KEY'] },
      FRESH_DEVICE,
    );

    // Assert
    should(answer.status).equal(200);
    should(answer.spent).equal(1);
    should(answer.body.names).deepEqual(['API_KEY']);
    should(answer.raw).not.containEql(VALUE);
  });

  it('should seal for the owner at the machine without a passkey', async () => {
    // Arrange
    const { source, target } = await machines();
    const offer = (await drive(target, '/v1/secrets/imports', undefined)).body as unknown as SecretImportOffer;

    // Act
    const answer = await drive(source, `/v1/secrets/exports/${offer.importId}`, { offer, names: ['API_KEY'] }, HOST);

    // Assert
    should(answer.status).equal(200);
  });

  it('should refuse to seal a sign-in token, whoever asks and whatever the vault holds', async () => {
    // Arrange — an MCP server's access token is the one sign-in the vault holds; the owner decided it is not copied.
    const { source, target } = await machines();
    const token = mcpOAuthSecretNames('linear', 'https://mcp.example.com/mcp').access;
    await source.directory.put(token, VALUE);
    const offer = (await drive(target, '/v1/secrets/imports', undefined)).body as unknown as SecretImportOffer;

    // Act
    const answer = await drive(source, `/v1/secrets/exports/${offer.importId}`, { offer, names: [token] }, HOST);

    // Assert
    should(answer.status).equal(400);
    should(answer.raw).not.containEql(VALUE);
  });

  it('should refuse rather than guess when the boundary handed over no governance', async () => {
    // Arrange
    const { source, target } = await machines();
    const offer = (await drive(target, '/v1/secrets/imports', undefined)).body as unknown as SecretImportOffer;

    // Act
    const answer = await drive(
      source,
      `/v1/secrets/exports/${offer.importId}`,
      { offer, names: ['API_KEY'] },
      FRESH_DEVICE,
      'absent',
    );

    // Assert
    should(answer.status).equal(500);
  });

  it('should file the copy on the target once, and refuse a replay', async () => {
    // Arrange
    const { source, target } = await machines();
    const { offer, bundle } = await sealed(source, target);

    // Act
    const first = await drive(target, `/v1/secrets/imports/${offer.importId}`, { bundle }, DEVICE);
    const replay = await drive(target, `/v1/secrets/imports/${offer.importId}`, { bundle }, DEVICE);

    // Assert
    should(first.status).equal(200);
    should(first.body).deepEqual({
      importId: offer.importId,
      sourceDaemonId: sourceIdentity.daemonId,
      imported: ['API_KEY'],
      filedAt: new Date(NOW).toISOString(),
      kept: [],
    });
    should(replay.status).equal(409);
    should(replay.body.code).equal('import_spent');
  });

  it('should answer each refusal with its own status', async () => {
    // Arrange
    const { source, target, clock } = await machines();
    const { offer, bundle } = await sealed(source, target);
    const tampered = await drive(
      target,
      `/v1/secrets/imports/${offer.importId}`,
      { bundle: { ...bundle, names: ['OTHER'] } },
      DEVICE,
    );
    const late = await sealed(source, target);
    clock.ms += 10 * 60_000;

    // Act
    const expired = await drive(target, `/v1/secrets/imports/${late.offer.importId}`, { bundle: late.bundle }, DEVICE);
    const unknownPath = await drive(target, '/v1/secrets/imports/not-an-import', { bundle }, DEVICE);
    const expiredOffer = await drive(
      source,
      `/v1/secrets/exports/${late.offer.importId}`,
      { offer: late.offer, names: ['API_KEY'] },
      FRESH_DEVICE,
    );
    clock.ms = NOW;
    const missing = await sealedMissing(source, target);

    // Assert
    should(tampered.status).equal(400);
    should(tampered.body.code).equal('bundle_invalid');
    should(expired.status).equal(410);
    should(unknownPath.status).equal(404);
    should(expiredOffer.status).equal(410);
    should(missing.status).equal(404);
    should(missing.body.code).equal('unknown_secret');
  });
});

/** An export naming a secret the source does not hold. */
async function sealedMissing(source: SecretSubsystem, target: SecretSubsystem): Promise<Answer> {
  const offer = (await drive(target, '/v1/secrets/imports', undefined)).body as unknown as SecretImportOffer;
  return await drive(source, `/v1/secrets/exports/${offer.importId}`, { offer, names: ['MISSING'] }, FRESH_DEVICE);
}

describe('a key this machine already holds, through the import route', () => {
  const OLD = 'old-api-value-here';
  const OTHER = 'a-key-the-copy-does-not-name';
  const PASSWORD = 'hunter2-UNIQUE-pw';

  /** A target holding two keys and a saved login with a password; a source holding a new value for one of them. */
  async function world() {
    const clock = new Clock();
    const sourceDocuments = new MemorySecretDocuments();
    const source = secretSubsystem({ documents: sourceDocuments, identity: sourceIdentity, clock });
    const targetDocuments = new MemorySecretDocuments();
    const loginIndex = new MemoryLoginIndex();
    const loginSealed = new MemorySecretDocuments();
    const target = secretSubsystem({
      documents: targetDocuments,
      identity: targetIdentity,
      clock,
      loginIndex,
      loginSealed,
    });
    await source.directory.put('API_KEY', VALUE);
    await target.directory.put('API_KEY', OLD);
    await target.directory.put('OTHER_KEY', OTHER);
    await putSavedLogin(target.accounts as NonNullable<typeof target.accounts>, 'GITHUB', {
      label: 'GitHub',
      match: ['github.com'],
      username: 'kirinnee',
      password: PASSWORD,
    });
    const values = async () => [...(await new SecretVault(targetDocuments, new FakeSecretCipher()).values())];
    /** The secret store as the disk holds it, timestamps included. */
    const store = async () => JSON.stringify(await targetDocuments.read());
    /** Everything a login keeps: its index and its sealed document, as the stores hold them. */
    const logins = async () => JSON.stringify([loginIndex.document, await loginSealed.read()]);
    return { clock, source, target, values, store, logins };
  }

  it('should keep it, and every other secret and every login, byte-identical, and say it was kept', async () => {
    // Arrange
    const { source, target, values, store, logins } = await world();
    const { offer, bundle } = await sealed(source, target);
    const before = await values();
    const storeBefore = await store();
    const loginsBefore = await logins();

    // Act
    const answer = await drive(target, `/v1/secrets/imports/${offer.importId}`, { bundle }, DEVICE);

    // Assert
    should(answer.status).equal(200);
    should(answer.body.kept).deepEqual(['API_KEY']);
    should(answer.body.imported).deepEqual([]);
    should(answer.body).not.have.property('replaced');
    should(await values()).deepEqual(before);
    should(await store()).equal(storeBefore);
    should(await logins()).equal(loginsBefore);
    should(answer.raw).not.containEql(VALUE);
    should(answer.raw).not.containEql(OLD);
  });

  it('should refuse a request that asks to replace one, whoever it names, before anything is filed', async () => {
    // Arrange
    const { source, target, store } = await world();
    const { offer, bundle } = await sealed(source, target);
    const storeBefore = await store();
    const signIn = mcpOAuthSecretNames('linear', 'https://mcp.example.com/mcp').access;

    // Act
    const answers = [
      await drive(target, `/v1/secrets/imports/${offer.importId}`, { bundle, replace: ['API_KEY'] }, DEVICE),
      await drive(target, `/v1/secrets/imports/${offer.importId}`, { bundle, replace: [signIn] }, DEVICE),
    ];

    // Assert
    should(answers.map(answer => answer.status)).deepEqual([400, 400]);
    should(await store()).equal(storeBefore);
    // The import was not spent by a request that never parsed: the same bundle still files, and still keeps.
    const again = await drive(target, `/v1/secrets/imports/${offer.importId}`, { bundle }, DEVICE);
    should(again.status).equal(200);
    should(again.body.kept).deepEqual(['API_KEY']);
    should(await store()).equal(storeBefore);
  });

  it('should refuse a governed caller who may not configure secrets', async () => {
    // Arrange — the real boundary in front of the real routes, a guard that refuses secrets.configure only.
    const { source, target, values } = await world();
    const { offer, bundle } = await sealed(source, target);
    const before = await values();
    const guard: CapabilityGuard = {
      decide: demand =>
        demand.capability === 'secrets' && demand.axis === 'configure'
          ? { allowed: false, refusal: 'not-granted' }
          : { allowed: true, refusal: 'granted' },
      governance: () => ({ governed: true, decide: () => ({ allowed: false, refusal: 'not-granted' }) }),
      explain: () => 'the operator of this machine has not let this device change secrets',
    };
    const dispatcher = new ApiDispatcher(
      new ApiRouter(secretRoutes(target)),
      { admin: 'admin-secret', warden: 'warden-secret', devices: { has: () => true } },
      guard,
    );

    // Act
    const response = await dispatcher.dispatch(
      request({
        method: 'POST',
        path: `/v1/secrets/imports/${offer.importId}`,
        headers: { authorization: 'Bearer admin-secret', 'content-type': 'application/json' },
        body: JSON.stringify({ bundle }),
      }),
    );

    // Assert
    should(response.status).equal(403);
    should(await values()).deepEqual(before);
  });
});
