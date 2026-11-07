/**
 * A PROVIDER'S REFUSAL KEEPS TODAY'S CODE. MCP, Skills and Runtimes provide Catalogs' `catalog.items` hook and throw
 * `CatalogItemRefusal` (exported from the contract) from their install and remove; the install routes answer it as the
 * fleet change it always was — `fleet_change_unknown` 404, any other code 409 — never a bare 500.
 */
import { beforeAll, describe, expect, it } from 'bun:test';
import { ApiError } from '@ferretry/kernel/contract';
import type { DaemonIdentity } from '../../../daemon/lib/relay-wire/index.ts';
import { CatalogItemRefusal } from '../../../contract/items/index.ts';
import { catalogInstallRoutes } from '../../../daemon/lib/routes/catalog-installs.ts';
import { newIdentity, skillItem } from '../../support/catalog-fixtures.ts';
import { GOVERNANCE, request, rig, runtimeTarget, STEP_UP, type Rig } from './service-support.ts';

let alice: DaemonIdentity;
beforeAll(async () => {
  alice = await newIdentity();
});

type Handle = (context: never) => Promise<unknown>;

function routeOf(r: Rig, method: string, path: string): Handle {
  const found = catalogInstallRoutes(r.inner).find(route => route.method === method && route.path === path);
  if (found === undefined) throw new Error(`no route ${method} ${path}`);
  return found.handle as unknown as Handle;
}

const call = (parts: Record<string, unknown>): never =>
  ({ governance: undefined, params: new Map(), request: { query: new Map(), headers: new Map() }, ...parts }) as never;

async function refusalOf(work: Promise<unknown>): Promise<ApiError> {
  try {
    await work;
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error('expected an ApiError');
}

async function installedInRuntime(r: Rig) {
  const preview = await r.service.preview('runtime', await request(alice, skillItem(alice.daemonId), runtimeTarget()));
  const installed = await r.service.apply(
    'runtime',
    { previewId: preview.previewId, secretBindings: {} },
    GOVERNANCE,
    STEP_UP,
  );
  return installed.install.installId;
}

describe('a provider that refuses an install or a remove', () => {
  it('should be a contract export a provider can throw, carrying its code and sentence', () => {
    // Act
    const refusal = new CatalogItemRefusal('fleet_change_unknown', 'that change is gone');

    // Assert
    expect(refusal).toBeInstanceOf(Error);
    expect(refusal.code).toBe('fleet_change_unknown');
    expect(refusal.message).toBe('that change is gone');
    expect(refusal.name).toBe('CatalogItemRefusal');
  });

  it('should answer fleet_change_unknown 404 when the provider refuses a remove with it', async () => {
    // Arrange
    const r = rig();
    const installId = await installedInRuntime(r);
    r.fleet.failApply = new CatalogItemRefusal('fleet_change_unknown', 'that change is gone');

    // Act
    const answered = await refusalOf(
      routeOf(
        r,
        'DELETE',
        '/v1/catalog-installs/runtime/:installId',
      )(call({ params: new Map([['installId', installId]]) })) as Promise<unknown>,
    );

    // Assert
    expect(answered.status).toBe(404);
    expect(answered.code).toBe('fleet_change_unknown');
    expect(answered.message).toBe('that change is gone');
  });

  it('should answer any other provider code 409, keeping the provider’s own code and sentence', async () => {
    // Arrange
    const r = rig();
    const installId = await installedInRuntime(r);
    r.fleet.failApply = new CatalogItemRefusal('fleet_change_stale', 'the runtime moved on');

    // Act
    const answered = await refusalOf(
      routeOf(
        r,
        'DELETE',
        '/v1/catalog-installs/runtime/:installId',
      )(call({ params: new Map([['installId', installId]]) })) as Promise<unknown>,
    );

    // Assert
    expect(answered.status).toBe(409);
    expect(answered.code).toBe('fleet_change_stale');
    expect(answered.message).toBe('the runtime moved on');
  });

  it('should not turn a plain Error from a provider into a refusal: it stays a failure', async () => {
    // Arrange
    const r = rig();
    const installId = await installedInRuntime(r);
    r.fleet.failApply = new Error('the provider broke');

    // Act
    const failure = await routeOf(
      r,
      'DELETE',
      '/v1/catalog-installs/runtime/:installId',
    )(call({ params: new Map([['installId', installId]]) })).then(
      () => undefined,
      (error: unknown) => error,
    );

    // Assert
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(ApiError);
  });
});
