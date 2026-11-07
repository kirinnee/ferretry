/**
 * A FERRET THROUGH CATALOGS GETS NO SECRET NAMES, on a preview and on an install, with the caller derived by the ROUTE from
 * a real ferret credential (not a hand-made `{ mayListSecrets: false }`). Gate marks a ferret's call local, so it arrives
 * ungoverned and the `secrets` capability allows it: only the caller's kind keeps the picker for a person.
 */
import { beforeAll, describe, expect, it } from 'bun:test';
import { ApiError } from '@ferretry/kernel/contract';
import type { DaemonIdentity } from '../../../daemon/lib/relay-wire/index.ts';
import { catalogInstallRoutes } from '../../../daemon/lib/routes/catalog-installs.ts';
import { mcpItem, newIdentity } from '../../support/catalog-fixtures.ts';
import { projectTarget, request, rig, type Rig } from './service-support.ts';

let alice: DaemonIdentity;
beforeAll(async () => {
  alice = await newIdentity();
});

type Handle = (context: never) => Promise<{ status: number; body: string }>;

function routeOf(r: Rig, method: string, path: string): Handle {
  const found = catalogInstallRoutes(r.inner).find(route => route.method === method && route.path === path);
  if (found === undefined) throw new Error(`no route ${method} ${path}`);
  return found.handle as unknown as Handle;
}

/** A call as Gate hands it over: an ungoverned caller (allowed everything) is how a ferret and the host's shell arrive. */
const call = (credential: unknown, body: unknown): never =>
  ({
    credential,
    actor: undefined,
    governance: { governed: false, decide: () => ({ allowed: true }) },
    params: new Map(),
    request: { query: new Map(), headers: new Map(), text: async () => JSON.stringify(body) },
  }) as never;

const FERRET = { kind: 'authenticated', tokenClass: 'ferret', ferret: 'f1' };
const DEVICE = { kind: 'authenticated', tokenClass: 'device', principal: { holder: 'dev_a' } };
const HOST = undefined;

const PREVIEW = '/v1/catalog-installs/project/preview';
const APPLY = '/v1/catalog-installs/project';

async function asked(r: Rig) {
  r.secrets = new Set(['ACME_TOKEN_OWN']);
  return await request(alice, mcpItem(alice.daemonId), projectTarget());
}

describe('catalog installs: a ferret is told no secret names (the caller is derived from a real ferret credential)', () => {
  it('§3.7 should not ask the Vault for any secret name, nor say `held`, on a ferret’s preview through Catalogs', async () => {
    const r = rig();
    const body = await asked(r);
    const answer = await routeOf(r, 'POST', PREVIEW)(call(FERRET, body));
    expect(answer.status).toBe(200);
    expect(r.secretNameReads).toBe(0);
    const preview = JSON.parse(answer.body) as { secrets: { placeholder: string; held?: boolean }[] };
    expect(preview.secrets).toEqual([{ placeholder: 'ACME_TOKEN' }]);
    expect('held' in (preview.secrets[0] ?? {})).toBe(false);
  });

  it('§3.7 should tell a ferret’s preview the same whether the secret is held or not', async () => {
    const r = rig();
    const body = await asked(r);
    const held = await routeOf(r, 'POST', PREVIEW)(call(FERRET, body));
    r.secrets = new Set();
    const missing = await routeOf(r, 'POST', PREVIEW)(call(FERRET, body));
    expect(JSON.parse(held.body).secrets).toEqual(JSON.parse(missing.body).secrets);
    expect(r.secretNameReads).toBe(0);
  });

  it('§3.7 should refuse a ferret’s install through Catalogs and ask the Vault for no secret name', async () => {
    const r = rig();
    const body = await asked(r);
    // A person previews; the ferret tries to apply that preview, binding to a name it would like to probe.
    const person = await routeOf(r, 'POST', PREVIEW)(call(DEVICE, body));
    const { previewId } = JSON.parse(person.body) as { previewId: string };
    const readsAfterPerson = r.secretNameReads;
    const refused = await routeOf(
      r,
      'POST',
      APPLY,
    )(call(FERRET, { previewId, secretBindings: { ACME_TOKEN: 'ACME_TOKEN_OWN' } })).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(refused).toBeInstanceOf(ApiError);
    expect((refused as ApiError).status).toBe(403);
    expect(r.secretNameReads).toBe(readsAfterPerson);
    expect(r.store.state.installs).toEqual([]);
  });

  it('§3.7 should still give a person on the host or a paired device the names for the picker', async () => {
    for (const credential of [HOST, DEVICE]) {
      const r = rig();
      const body = await asked(r);
      const answer = await routeOf(r, 'POST', PREVIEW)(call(credential, body));
      expect(answer.status).toBe(200);
      expect(r.secretNameReads).toBe(1);
      expect(JSON.parse(answer.body).secrets).toEqual([{ placeholder: 'ACME_TOKEN', held: false }]);
    }
  });
});
