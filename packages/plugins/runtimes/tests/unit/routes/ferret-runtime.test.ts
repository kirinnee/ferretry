import { describe, expect, it } from 'bun:test';
import type { RuntimesAssembly } from '../../../daemon/index.ts';
import {
  SessionRuntimeError,
  type FerretRuntimeSubsystem,
  type SessionRuntimeFailure,
} from '../../../daemon/routes/ferret-runtime.ts';
import { hostRuntimes } from './support.ts';

const hosted = async (runtime?: FerretRuntimeSubsystem) =>
  await hostRuntimes({
    catalog: {} as RuntimesAssembly['catalog'],
    setup: {} as RuntimesAssembly['setup'],
    recommend: {
      recommend: async () => {
        throw new Error('unused');
      },
    },
    runtime,
  });

describe('per-ferret runtime route mounts', () => {
  it('R-0171 serves the injected live model catalog through :id with no-store', async () => {
    const ids: string[] = [];
    const catalog = { harness: 'codex', source: 'codex-app-server', choices: [] };
    const { host } = await hosted({
      models: async id => {
        ids.push(id);
        return catalog;
      },
      control: async () => ({}),
    });
    const response = await host.request('GET', '/v1/ferrets/ferret-1/runtime-models');
    expect(response.status).toBe(200);
    expect(response.json()).toEqual(catalog);
    expect(ids).toEqual(['ferret-1']);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect((await host.request('GET', '/v1/ferrets/ferret-1')).status).toBe(404);
  });

  it('R-0365 passes independent model, effort, fast and compact controls and requires a caller request id', async () => {
    const calls: unknown[] = [];
    const { host } = await hosted({
      models: async () => ({}),
      control: async (...args) => {
        calls.push(args);
        return { changed: true };
      },
    });
    const path = '/v1/ferrets/ferret-1/runtime';
    const missing = await host.request('POST', path, { body: { action: 'model' } });
    expect(missing.status).toBe(400);
    expect(missing.json<{ code: string }>().code).toBe('missing_request_id');
    expect(calls).toEqual([]);
    for (const body of [
      { action: 'model' },
      { action: 'effort', effort: 'high' },
      { action: 'fast', fast: false },
      { action: 'compact' },
    ]) {
      expect((await host.request('POST', path, { body, headers: { 'x-fy-request-id': 'request-1' } })).status).toBe(
        200,
      );
      expect(calls.at(-1)).toEqual(['ferret-1', body, 'request-1']);
    }
    expect(
      (await host.request('POST', path, { body: { action: 'effort' }, headers: { 'x-fy-request-id': 'request-2' } }))
        .status,
    ).toBe(400);
    expect(calls).toHaveLength(4);
  });

  it('R-0365 preserves the copied refusal status and code taxonomy', async () => {
    const failures: readonly [SessionRuntimeFailure, number, string][] = [
      ['invalid', 400, 'invalid_request'],
      ['not_found', 404, 'not-found'],
      ['refused', 409, 'runtime_control_refused'],
      ['unsupported', 422, 'runtime_control_unsupported'],
      ['catalog_unavailable', 503, 'runtime_catalog_unavailable'],
      ['conflict', 409, 'request_id_reused'],
      ['unsettled', 409, 'runtime_control_unsettled'],
      ['failed', 500, 'runtime_control_failed'],
    ];
    for (const [failure, status, code] of failures) {
      const { host } = await hosted({
        models: async () => {
          throw new SessionRuntimeError(failure, 'refused');
        },
        control: async () => ({}),
      });
      const response = await host.request('GET', '/v1/ferrets/f-1/runtime-models');
      expect(response.status).toBe(status);
      expect(response.json<{ code: string }>().code).toBe(code);
    }
  });

  it('R-0171 refuses unavailable assembly and invalid path parameters without guessing', async () => {
    const { host } = await hosted();
    expect((await host.request('GET', '/v1/ferrets/f-1/runtime-models')).status).toBe(503);
    expect(
      (
        await host.request('POST', '/v1/ferrets/f-1/runtime', {
          body: { action: 'model' },
          headers: { 'x-fy-request-id': 'r' },
        })
      ).status,
    ).toBe(409);
    expect((await host.request('GET', '/v1/ferrets/a%2Fb/runtime-models')).status).toBe(400);
  });
});
