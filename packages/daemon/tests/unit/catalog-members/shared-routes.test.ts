import { describe, it } from 'bun:test';
import type { SharedCatalogItem, SignedCatalogManifest } from '@ferretry/protocol';
import should from 'should';
import type { ApiRequest, ApiResponse } from '../../../src/lib/api/index.ts';
import type { AuditEntry } from '../../../src/lib/audit/types.ts';
import type { RedeemAdmission, RedeemReservation, Refused } from '../../../src/lib/catalog-members/admission.ts';
import {
  MemberDispatcher,
  type SharedCatalogReader,
  type SharedRouteDeps,
  sharedRoutes,
} from '../../../src/lib/catalog-members/shared-routes.ts';
import type { MemberPasskeyRefusal, MemberPasskeyService } from '../../../src/lib/catalog-members/passkeys.ts';
import { CatalogMemberRefusal } from '../../../src/lib/catalog-members/refusal.ts';
import type { Durable, MemberAccess } from '../../../src/lib/catalog-members/service.ts';
import { CatalogRefusal } from '../../../src/lib/shared-catalogs/refusal.ts';
import { jsonBody, request } from '../api/support.ts';
import { catalogId, DAEMON_ID, flush, iso, keyId, memberId, shareId, sharesDoc, T0 } from './support.ts';

const ORIGIN = 'https://app.ferretry.test';
const NOW = T0;
const UNLOCKED_UNTIL = T0 + 30 * 24 * 60 * 60 * 1_000;
const ITEM = `itm_${'B'.repeat(22)}`;
const CODE = `fy_share_${'C'.repeat(22)}`;
const SESSION = { memberId: memberId(1), keyId: keyId(1), appSession: 'app-session-1' };

const access = (overrides: Partial<MemberAccess> = {}): MemberAccess => ({
  memberId: memberId(1),
  keyId: keyId(1),
  label: 'Member 1',
  memberKey: 'key',
  clientName: 'Browser 1',
  catalogIds: [catalogId(1), catalogId(2)],
  passkeyCount: 1,
  ...overrides,
});

const manifest = (revision: number): SignedCatalogManifest =>
  ({ manifest: { revision } }) as unknown as SignedCatalogManifest;
const item = { id: ITEM, version: 2 } as unknown as SharedCatalogItem;

const deferred = () => {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>(done => {
    resolve = done;
  });
  return { promise, resolve };
};

const reservation = (added: readonly string[]): RedeemReservation => ({
  kind: 'redeem',
  reservationId: 'rsv-1',
  shareId: shareId(1),
  memberId: memberId(1),
  added,
});
const admitted = (added: readonly string[]): RedeemAdmission => ({
  ok: true,
  shares: sharesDoc(),
  reservation: reservation(added),
});
const refused = (refusal: Refused['refusal']): RedeemAdmission => ({
  ok: false,
  refusal,
  reason: 'other-member',
  shares: sharesDoc(),
  leftLive: false,
});

interface Rig {
  readonly dispatcher: MemberDispatcher;
  readonly deps: SharedRouteDeps;
  readonly calls: string[];
  readonly audit: AuditEntry[];
  readonly signed: string[];
  state: { access: MemberAccess | undefined; unlocked: boolean; admission: RedeemAdmission; persisted: Promise<void> };
  catalogs: { id: string; name: string; revision: number }[];
  passkey: (outcome: unknown) => void;
  failing: {
    audit: boolean;
    commit: Error | undefined;
    catalogs: Error | undefined;
    release: boolean;
    signing: Error | undefined;
  };
}

function rig(): Rig {
  const calls: string[] = [];
  const audit: AuditEntry[] = [];
  const signed: string[] = [];
  const state: Rig['state'] = {
    access: access(),
    unlocked: true,
    admission: admitted([catalogId(1)]),
    persisted: Promise.resolve(),
  };
  const failing: Rig['failing'] = {
    audit: false,
    commit: undefined,
    catalogs: undefined,
    release: false,
    signing: undefined,
  };
  const catalogs: Rig['catalogs'] = [{ id: catalogId(1), name: 'Alpha', revision: 3 }];
  let outcome: unknown;
  const passkeys = {
    unlockExpiresAt: (id: string) => {
      calls.push(`unlockExpiresAt:${id}`);
      return state.unlocked ? UNLOCKED_UNTIL : undefined;
    },
    passkeyCount: async () => 2,
    registrationOptions: async (_caller: unknown, origin: string) => {
      calls.push(`registrationOptions:${origin}`);
      return outcome;
    },
    register: async () => outcome,
    unlockOptions: async (_caller: unknown, origin: string) => {
      calls.push(`unlockOptions:${origin}`);
      return outcome;
    },
    unlock: async () => outcome,
  } as unknown as MemberPasskeyService;
  const reader: SharedCatalogReader = {
    catalogs: async () => {
      if (failing.catalogs !== undefined) throw failing.catalogs;
      return catalogs;
    },
    signedManifest: async id => {
      signed.push(id);
      if (failing.signing !== undefined) throw failing.signing;
      return manifest(7);
    },
    frozenItem: async (id, itemId, version) => {
      calls.push(`frozenItem:${id}:${itemId}:${String(version)}`);
      if (failing.signing !== undefined) throw failing.signing;
      return item;
    },
  };
  const deps: SharedRouteDeps = {
    members: {
      ready: async () => {
        calls.push('ready');
      },
      access: async id => {
        calls.push(`access:${id}`);
        return state.access;
      },
      admitRedeem: (code, member, now): Durable<RedeemAdmission> => {
        calls.push(`admitRedeem:${code}:${member}:${String(now)}`);
        return Object.assign({ ...state.admission }, { persisted: state.persisted });
      },
      commitRedeem: async (held, by) => {
        calls.push(`commitRedeem:${held.reservationId}:${by.keyId}:${by.clientName}`);
        if (failing.commit !== undefined) throw failing.commit;
      },
      release: async held => {
        calls.push(`release:${held.reservationId}`);
        if (failing.release) throw new Error('release failed');
      },
      removeKey: async (member, key) => {
        calls.push(`removeKey:${member}:${key}`);
        return {} as never;
      },
    },
    passkeys,
    catalogs: reader,
    publisher: () => ({ daemonId: DAEMON_ID, daemonName: 'studio', carriers: [] }),
    audit: {
      record: async entry => {
        if (failing.audit) throw new Error('audit failed');
        audit.push(entry);
      },
    },
    now: () => NOW,
  };
  return {
    dispatcher: new MemberDispatcher(deps),
    deps,
    calls,
    audit,
    signed,
    state,
    catalogs,
    passkey: next => {
      outcome = next;
    },
    failing,
  };
}

const call = (
  dispatcher: MemberDispatcher,
  method: string,
  path: string,
  options: { body?: unknown; headers?: Record<string, string>; member?: typeof SESSION | null } = {},
): Promise<ApiResponse> => {
  const base = request({
    method,
    path,
    headers: options.headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const member = options.member === undefined ? SESSION : options.member;
  const built: ApiRequest = member === null ? base : { ...base, member };
  return dispatcher.dispatch(built);
};

const ME = '/v1/shared/me';
const manifestPath = (id = catalogId(1)) => `/v1/shared/catalogs/${id}/manifest`;
const itemPath = (id = catalogId(1), itemId = ITEM, version = '2') =>
  `/v1/shared/catalogs/${id}/items/${itemId}/${version}`;

const registrationOptions = {
  challenge: 'AAAA',
  rp: { id: 'app.ferretry.test', name: 'Ferretry' },
  user: { id: 'AAAA', name: 'member', displayName: 'member' },
  pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
  timeout: 60_000,
  excludeCredentials: [],
};
const registration = { credentialId: 'AAAA', clientDataJSON: 'AAAA', attestationObject: 'AAAA' };
const passkeyView = { id: 'AAAA', origin: ORIGIN, createdAt: iso(T0) };
const stepUpOptions = {
  challenge: 'AAAA',
  rpId: 'app.ferretry.test',
  allowCredentials: [{ type: 'public-key', id: 'AAAA' }],
  timeout: 60_000,
};
const assertion = { credentialId: 'AAAA', clientDataJSON: 'AAAA', authenticatorData: 'AAAA', signature: 'AAAA' };
const granted = { unlockedUntil: iso(UNLOCKED_UNTIL) };

const KEY_TIER: readonly (readonly [string, unknown])[] = [
  ['/v1/shared/passkeys/options', { origin: ORIGIN }],
  ['/v1/shared/passkeys', registration],
  ['/v1/shared/unlock/options', { origin: ORIGIN }],
  ['/v1/shared/unlock', assertion],
];

const UNLOCKED_TIER: readonly (readonly [string, string, unknown])[] = [
  ['GET', ME, undefined],
  ['GET', manifestPath(), undefined],
  ['GET', itemPath(), undefined],
  ['POST', '/v1/shared/redeem', { code: CODE }],
  ['DELETE', '/v1/shared/me/keys/self', undefined],
];

describe('the member route table', () => {
  it('should be the nine routes the sessions serve, none of them under another prefix', () => {
    // Act
    const routes = sharedRoutes(rig().deps);

    // Assert
    should(routes.map(route => `${route.method} ${route.path} ${route.needs}`)).deepEqual([
      'POST /v1/shared/passkeys/options key',
      'POST /v1/shared/passkeys key',
      'POST /v1/shared/unlock/options key',
      'POST /v1/shared/unlock key',
      'GET /v1/shared/me unlocked',
      'GET /v1/shared/catalogs/:catalogId/manifest unlocked',
      'GET /v1/shared/catalogs/:catalogId/items/:itemId/:version unlocked',
      'POST /v1/shared/redeem unlocked',
      'DELETE /v1/shared/me/keys/self unlocked',
    ]);
    should(new MemberDispatcher(rig().deps).routes.length).equal(9);
  });
});

describe('the member dispatcher at its boundary', () => {
  it('should refuse a request that carries no member before it reads anything', async () => {
    // Arrange
    const { dispatcher, calls } = rig();

    // Act
    const response = await call(dispatcher, 'GET', ME, { member: null });

    // Assert
    should(response.status).equal(401);
    should(jsonBody(response).code).equal('unauthorized');
    should(calls).deepEqual([]);
  });

  it('should say 404 for a route it does not have and 405, with Allow, for a wrong verb', async () => {
    // Arrange
    const { dispatcher, calls } = rig();

    // Act
    const unknown = await call(dispatcher, 'GET', '/v1/shared/nothing');
    const outside = await call(dispatcher, 'GET', '/v1/sessions');
    const wrongVerb = await call(dispatcher, 'PUT', ME);

    // Assert
    should(unknown.status).equal(404);
    should(outside.status).equal(404);
    should(wrongVerb.status).equal(405);
    should(wrongVerb.headers.get('allow')).equal('GET');
    should(calls).deepEqual([]);
  });

  it('should answer one 401 on EVERY route when the key is gone', async () => {
    // Arrange
    const { dispatcher, state } = rig();
    state.access = undefined;

    // Act
    const answers = [
      ...(await Promise.all(KEY_TIER.map(([path, body]) => call(dispatcher, 'POST', path, { body })))),
      ...(await Promise.all(UNLOCKED_TIER.map(([method, path, body]) => call(dispatcher, method, path, { body })))),
    ];

    // Assert
    should(answers).length(9);
    for (const answer of answers) {
      should(answer.status).equal(401);
      should(jsonBody(answer).code).equal('unauthorized');
      should(answer.headers.get('cache-control')).equal('no-store');
    }
    should(new Set(answers.map(answer => answer.body)).size).equal(1);
  });

  it('should answer that same 401 when the filed key belongs to another member', async () => {
    // Arrange
    const { dispatcher, state } = rig();
    state.access = access({ memberId: memberId(2) });

    // Act
    const response = await call(dispatcher, 'GET', ME);

    // Assert
    should(response.status).equal(401);
    should(jsonBody(response).code).equal('unauthorized');
  });

  it('should re-read the grants on every request, so a take-back is felt on the next one', async () => {
    // Arrange
    const { dispatcher, state, calls } = rig();

    // Act
    const first = await call(dispatcher, 'GET', manifestPath());
    state.access = access({ catalogIds: [catalogId(2)] });
    const second = await call(dispatcher, 'GET', manifestPath());

    // Assert
    should(first.status).equal(200);
    should(second.status).equal(404);
    should(calls.filter(entry => entry.startsWith('access:'))).length(2);
  });

  it('should let a not-yet-unlocked member reach only the key-tier routes', async () => {
    // Arrange
    const { dispatcher, state, passkey } = rig();
    state.unlocked = false;
    passkey({ ok: true, value: registrationOptions });

    // Act
    const locked = await Promise.all(
      UNLOCKED_TIER.map(([method, path, body]) => call(dispatcher, method, path, { body })),
    );
    const open = await call(dispatcher, 'POST', '/v1/shared/passkeys/options', { body: { origin: ORIGIN } });

    // Assert
    for (const answer of locked) {
      should(answer.status).equal(403);
      should(jsonBody(answer).code).equal('member_locked');
    }
    should(open.status).equal(200);
  });

  it('should mark every answer no-store, the successful ones included', async () => {
    // Arrange
    const { dispatcher } = rig();

    // Act
    const me = await call(dispatcher, 'GET', ME);
    const missing = await call(dispatcher, 'GET', manifestPath(catalogId(9)));

    // Assert
    should(me.headers.get('cache-control')).equal('no-store');
    should(missing.headers.get('cache-control')).equal('no-store');
  });
});

describe('the key-tier routes: passkeys and unlock', () => {
  it('should hand back registration options for the browser origin', async () => {
    // Arrange
    const { dispatcher, passkey, calls } = rig();
    passkey({ ok: true, value: registrationOptions });

    // Act
    const response = await call(dispatcher, 'POST', '/v1/shared/passkeys/options', { body: { origin: ORIGIN } });

    // Assert
    should(response.status).equal(200);
    should(jsonBody(response).challenge).equal('AAAA');
    should(calls).containEql(`registrationOptions:${ORIGIN}`);
  });

  it('should answer 201 with the passkey view for a registration', async () => {
    // Arrange
    const { dispatcher, passkey } = rig();
    passkey({ ok: true, value: passkeyView });

    // Act
    const response = await call(dispatcher, 'POST', '/v1/shared/passkeys', { body: registration });

    // Assert
    should(response.status).equal(201);
    should(jsonBody(response).id).equal('AAAA');
  });

  it('should hand back unlock options and then the unlock grant', async () => {
    // Arrange
    const { dispatcher, passkey } = rig();

    // Act
    passkey({ ok: true, value: stepUpOptions });
    const options = await call(dispatcher, 'POST', '/v1/shared/unlock/options', { body: { origin: ORIGIN } });
    passkey({ ok: true, value: granted });
    const unlocked = await call(dispatcher, 'POST', '/v1/shared/unlock', { body: assertion });

    // Assert
    should(options.status).equal(200);
    should(jsonBody(options).rpId).equal('app.ferretry.test');
    should(unlocked.status).equal(200);
    should(jsonBody(unlocked).unlockedUntil).equal(iso(UNLOCKED_UNTIL));
  });

  const REFUSALS: readonly (readonly [MemberPasskeyRefusal, number, string])[] = [
    ['origin-not-allowed', 403, 'member_origin_not_allowed'],
    ['registration-closed', 403, 'member_registration_closed'],
    ['too-many-passkeys', 409, 'member_too_many_passkeys'],
    ['no-passkey', 404, 'member_no_passkey'],
    ['not-verified', 401, 'member_not_verified'],
  ];

  for (const [refusal, status, code] of REFUSALS) {
    it(`should answer ${String(status)} ${code} when a passkey step refuses with ${refusal}`, async () => {
      // Arrange
      const { dispatcher, passkey } = rig();
      passkey({ ok: false, refusal });

      // Act
      const answers = await Promise.all([
        call(dispatcher, 'POST', '/v1/shared/passkeys/options', { body: { origin: ORIGIN } }),
        call(dispatcher, 'POST', '/v1/shared/passkeys', { body: registration }),
        call(dispatcher, 'POST', '/v1/shared/unlock/options', { body: { origin: ORIGIN } }),
        call(dispatcher, 'POST', '/v1/shared/unlock', { body: assertion }),
      ]);

      // Assert
      for (const answer of answers) {
        should(answer.status).equal(status);
        should(jsonBody(answer).code).equal(code);
      }
    });
  }

  it('should refuse a malformed body with 400 before the passkey service hears of it', async () => {
    // Arrange
    const { dispatcher, calls } = rig();

    // Act
    const response = await call(dispatcher, 'POST', '/v1/shared/passkeys/options', {
      body: { origin: 'not an origin' },
    });

    // Assert
    should(response.status).equal(400);
    should(calls.filter(entry => entry.startsWith('registrationOptions'))).length(0);
  });
});

describe('GET /v1/shared/me', () => {
  it('should answer who the browser is, its granted catalogs that still exist, and when it locks', async () => {
    // Arrange
    const { dispatcher } = rig();

    // Act
    const response = await call(dispatcher, 'GET', ME);
    const body = jsonBody(response);

    // Assert
    should(response.status).equal(200);
    should(body.memberId).equal(memberId(1));
    should(body.keyId).equal(keyId(1));
    should(body.label).equal('Member 1');
    should(body.daemonId).equal(DAEMON_ID);
    should(body.daemonName).equal('studio');
    should(body.unlockExpiresAt).equal(iso(UNLOCKED_UNTIL));
    should(body.passkeys).equal(2);
    // catalogId(2) is granted but gone from the publisher; catalogId(1) is granted and held.
    should(body.catalogs).deepEqual([{ catalogId: catalogId(1), name: 'Alpha', revision: 3 }]);
  });

  it('should name no catalog the member is not granted', async () => {
    // Arrange
    const { dispatcher, state, catalogs } = rig();
    catalogs.push({ id: catalogId(3), name: 'Gamma', revision: 1 });
    state.access = access({ catalogIds: [] });

    // Act
    const body = jsonBody(await call(dispatcher, 'GET', ME));

    // Assert
    should(body.catalogs).deepEqual([]);
  });
});

describe('GET /v1/shared/catalogs/:catalogId/manifest', () => {
  it('should sign and serve the manifest, tagged with its revision', async () => {
    // Arrange
    const { dispatcher, signed } = rig();

    // Act
    const response = await call(dispatcher, 'GET', manifestPath());

    // Assert
    should(response.status).equal(200);
    should(response.headers.get('etag')).equal('"7"');
    should(signed).deepEqual([catalogId(1)]);
  });

  it('should answer 304 from the listed revision WITHOUT signing anything', async () => {
    // Arrange
    const { dispatcher, signed } = rig();

    // Act
    const response = await call(dispatcher, 'GET', manifestPath(), { headers: { 'if-none-match': '"3"' } });

    // Assert
    should(response.status).equal(304);
    should(response.body).equal('');
    should(response.headers.get('etag')).equal('"3"');
    should(signed).deepEqual([]);
  });

  it('should serve the whole manifest when the tag asked for is an old revision', async () => {
    // Arrange
    const { dispatcher, signed } = rig();

    // Act
    const response = await call(dispatcher, 'GET', manifestPath(), { headers: { 'if-none-match': '"2"' } });

    // Assert
    should(response.status).equal(200);
    should(signed).deepEqual([catalogId(1)]);
  });

  it('should answer 404 for a catalog the member is not granted, with the same words as one that is unknown', async () => {
    // Arrange
    const { dispatcher, state } = rig();
    state.access = access({ catalogIds: [catalogId(1)] });

    // Act
    const notGranted = await call(dispatcher, 'GET', manifestPath(catalogId(2)));
    const unknown = await call(dispatcher, 'GET', manifestPath(catalogId(9)));
    const malformed = await call(dispatcher, 'GET', manifestPath('nope'));

    // Assert
    for (const answer of [notGranted, unknown, malformed]) {
      should(answer.status).equal(404);
      should(jsonBody(answer).code).equal('catalog_unknown');
    }
    should(notGranted.body).equal(unknown.body);
  });

  it('should answer 404 for a granted catalog the publisher no longer lists', async () => {
    // Arrange
    const { dispatcher, state } = rig();
    state.access = access({ catalogIds: [catalogId(1), catalogId(2)] });

    // Act
    const response = await call(dispatcher, 'GET', manifestPath(catalogId(2)));

    // Assert
    should(response.status).equal(404);
  });
});

describe('GET /v1/shared/catalogs/:catalogId/items/:itemId/:version', () => {
  it('should serve a frozen item at a version', async () => {
    // Arrange
    const { dispatcher, calls } = rig();

    // Act
    const response = await call(dispatcher, 'GET', itemPath());

    // Assert
    should(response.status).equal(200);
    should(jsonBody(response).id).equal(ITEM);
    should(calls).containEql(`frozenItem:${catalogId(1)}:${ITEM}:2`);
  });

  it('should answer 404 item_unknown for a malformed item id or version, before any read', async () => {
    // Arrange
    const { dispatcher, calls } = rig();

    // Act
    const answers = await Promise.all([
      call(dispatcher, 'GET', itemPath(catalogId(1), 'itm_short')),
      call(dispatcher, 'GET', itemPath(catalogId(1), ITEM, '0')),
      call(dispatcher, 'GET', itemPath(catalogId(1), ITEM, '1x')),
      call(dispatcher, 'GET', itemPath(catalogId(1), ITEM, '1234567890')),
    ]);

    // Assert
    for (const answer of answers) {
      should(answer.status).equal(404);
      should(jsonBody(answer).code).equal('item_unknown');
    }
    should(calls.filter(entry => entry.startsWith('frozenItem'))).length(0);
  });

  it('should answer 404 catalog_unknown for a catalog the member is not granted', async () => {
    // Arrange
    const { dispatcher, state } = rig();
    state.access = access({ catalogIds: [] });

    // Act
    const response = await call(dispatcher, 'GET', itemPath());

    // Assert
    should(response.status).equal(404);
    should(jsonBody(response).code).equal('catalog_unknown');
  });

  const REFUSALS: readonly (readonly [CatalogRefusal['refusal'], number])[] = [
    ['catalog_unknown', 404],
    ['item_unknown', 404],
    ['item_withdrawn', 409],
    ['signing_unavailable', 503],
    ['store_damaged', 500],
  ];

  for (const [refusal, status] of REFUSALS) {
    it(`should map the publisher's ${refusal} to ${String(status)}`, async () => {
      // Arrange
      const { dispatcher, failing } = rig();
      failing.signing = new CatalogRefusal(refusal, 'because');

      // Act
      const response = await call(dispatcher, 'GET', itemPath());

      // Assert
      should(response.status).equal(status);
      should(jsonBody(response).code).equal(refusal);
    });
  }

  it('should answer 500 internal_error, saying nothing of the cause, for an unknown failure', async () => {
    // Arrange
    const { dispatcher, failing } = rig();
    failing.signing = new Error('/home/secret/path exploded');

    // Act
    const response = await call(dispatcher, 'GET', itemPath());

    // Assert
    should(response.status).equal(500);
    should(jsonBody(response).code).equal('internal_error');
    should(response.body).not.containEql('secret');
  });
});

describe('POST /v1/shared/redeem', () => {
  it('should burn, commit and answer the catalogs added, named as the publisher names them', async () => {
    // Arrange
    const { dispatcher, state, calls } = rig();
    // catalogId(9) was added by the code but is gone from the publisher: it is not named.
    state.admission = admitted([catalogId(1), catalogId(9)]);

    // Act
    const response = await call(dispatcher, 'POST', '/v1/shared/redeem', { body: { code: CODE } });

    // Assert
    should(response.status).equal(200);
    should(jsonBody(response)).deepEqual({ added: [{ catalogId: catalogId(1), name: 'Alpha' }] });
    should(calls).containEql(`admitRedeem:${CODE}:${memberId(1)}:${String(NOW)}`);
    should(calls).containEql(`commitRedeem:rsv-1:${keyId(1)}:Browser 1`);
    should(calls.filter(entry => entry.startsWith('release'))).length(0);
    should(calls.indexOf('ready')).be.lessThan(calls.findIndex(entry => entry.startsWith('admitRedeem')));
  });

  it('should answer an empty added list for a redeem that adds nothing', async () => {
    // Arrange
    const { dispatcher, state } = rig();
    state.admission = admitted([]);

    // Act
    const response = await call(dispatcher, 'POST', '/v1/shared/redeem', { body: { code: CODE } });

    // Assert
    should(response.status).equal(200);
    should(jsonBody(response)).deepEqual({ added: [] });
  });

  it('should not answer a redeem that adds nothing until the burn is on disk', async () => {
    // Arrange
    const { dispatcher, state } = rig();
    state.admission = admitted([]);
    const disk = deferred();
    state.persisted = disk.promise;
    let answer: ApiResponse | undefined;

    // Act
    const pending = call(dispatcher, 'POST', '/v1/shared/redeem', { body: { code: CODE } }).then(response => {
      answer = response;
    });
    await flush();
    const beforeDisk = answer;
    disk.resolve();
    await pending;

    // Assert
    should(beforeDisk).be.undefined();
    should(answer?.status).equal(200);
  });

  it('should not answer a refusal (the Q5 cross-member one included) until the burn is on disk', async () => {
    // Arrange
    const { dispatcher, state, calls } = rig();
    state.admission = refused('share_other_member');
    const disk = deferred();
    state.persisted = disk.promise;
    let answer: ApiResponse | undefined;

    // Act
    const pending = call(dispatcher, 'POST', '/v1/shared/redeem', { body: { code: CODE } }).then(response => {
      answer = response;
    });
    await flush();
    const beforeDisk = answer;
    disk.resolve();
    await pending;

    // Assert
    should(beforeDisk).be.undefined();
    should(answer?.status).equal(409);
    should(jsonBody(answer as ApiResponse).code).equal('share_other_member');
    should(calls.filter(entry => entry.startsWith('commitRedeem'))).length(0);
    should(calls.filter(entry => entry.startsWith('release'))).length(0);
  });

  const REFUSED: readonly (readonly [Refused['refusal'], number])[] = [
    ['share_refused', 409],
    ['share_other_member', 409],
    ['share_new_member', 409],
    ['members_full', 409],
    ['member_unknown', 404],
    ['member_key_unknown', 404],
    ['catalog_unknown', 404],
    ['share_unknown', 404],
  ];

  for (const [refusal, status] of REFUSED) {
    it(`should answer ${String(status)} ${refusal} when the admission refuses with it`, async () => {
      // Arrange
      const { dispatcher, state } = rig();
      state.admission = refused(refusal);

      // Act
      const response = await call(dispatcher, 'POST', '/v1/shared/redeem', { body: { code: CODE } });

      // Assert
      should(response.status).equal(status);
      should(jsonBody(response).code).equal(refusal);
    });
  }

  it('should release the reservation, and answer 500, when the commit fails', async () => {
    // Arrange
    const { dispatcher, failing, calls } = rig();
    failing.commit = new Error('disk full');

    // Act
    const response = await call(dispatcher, 'POST', '/v1/shared/redeem', { body: { code: CODE } });

    // Assert
    should(response.status).equal(500);
    should(calls).containEql('release:rsv-1');
  });

  it('should still answer when releasing the reservation fails too', async () => {
    // Arrange
    const { dispatcher, failing } = rig();
    failing.commit = new CatalogMemberRefusal('catalog_unknown', 'a catalog is gone');
    failing.release = true;

    // Act
    const response = await call(dispatcher, 'POST', '/v1/shared/redeem', { body: { code: CODE } });

    // Assert
    should(response.status).equal(404);
    should(jsonBody(response).code).equal('catalog_unknown');
  });

  it('should refuse a malformed code before the admission step spends anything', async () => {
    // Arrange
    const { dispatcher, calls } = rig();

    // Act
    const response = await call(dispatcher, 'POST', '/v1/shared/redeem', { body: { code: 'fy_share_short' } });

    // Assert
    should(response.status).equal(400);
    should(calls.filter(entry => entry.startsWith('admitRedeem'))).length(0);
  });
});

describe('DELETE /v1/shared/me/keys/self', () => {
  it('should remove this browser key and audit it as the member leaving, never as the owner', async () => {
    // Arrange
    const { dispatcher, calls, audit } = rig();

    // Act
    const response = await call(dispatcher, 'DELETE', '/v1/shared/me/keys/self');

    // Assert
    should(response.status).equal(200);
    should(jsonBody(response)).deepEqual({ keyId: keyId(1) });
    should(calls).containEql(`removeKey:${memberId(1)}:${keyId(1)}`);
    should(audit).deepEqual([
      {
        event: 'catalog.member.key-removed',
        actor: { kind: 'anonymous' },
        subject: memberId(1),
        outcome: 'succeeded',
        detail: { memberLabel: 'Member 1', keyId: keyId(1), by: 'member' },
      },
    ]);
  });

  it('should still answer when the audit log cannot be written', async () => {
    // Arrange
    const { dispatcher, failing } = rig();
    failing.audit = true;

    // Act
    const response = await call(dispatcher, 'DELETE', '/v1/shared/me/keys/self');

    // Assert
    should(response.status).equal(200);
  });
});
