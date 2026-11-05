/**
 * `POST /v1/fleet/runtimes/:runtimeId/check` at the daemon's front door: the HTTP shape only — the
 * runtime id it hands the service, the strict empty body, the shared schema, and which status a refusal
 * becomes. The check itself is `tests/unit/fleet/runtime-check.test.ts`.
 */
import { describe, it } from 'bun:test';
import type { FleetRuntimeCheckResult } from '@ferretry/protocol';
import should from 'should';
import { ApiDispatcher } from '../../../../src/lib/api/dispatcher.ts';
import { ApiRouter } from '../../../../src/lib/api/router.ts';
import { RuntimeCheckRefusal } from '../../../../src/lib/fleet/runtime-check.ts';
import {
  type FleetRuntimeCheckSubsystem,
  fleetRuntimeCheckRoutes,
} from '../../../../src/lib/runtime/mounts/fleet-runtime-check.ts';
import { jsonBody, request } from '../../api/support.ts';
import { CREDENTIALS, GRANTED, human } from './support.ts';

const PASSED: FleetRuntimeCheckResult = { ok: true, ms: 2_400, sentence: 'claude-default answered in 2.4 s.' };

function stub(check: FleetRuntimeCheckSubsystem['check'] = async () => PASSED): {
  subsystem: FleetRuntimeCheckSubsystem;
  asked: string[];
} {
  const asked: string[] = [];
  return {
    asked,
    subsystem: {
      check: async id => {
        asked.push(id);
        return await check(id);
      },
    },
  };
}

const dispatcher = (subsystem: FleetRuntimeCheckSubsystem): ApiDispatcher =>
  new ApiDispatcher(new ApiRouter(fleetRuntimeCheckRoutes(subsystem)), CREDENTIALS, GRANTED);

const post = (path: string, body = '{}') =>
  request({ method: 'POST', path, headers: { ...human, 'content-type': 'application/json' }, body });

describe('the runtime check mount', () => {
  it('should hand the service the runtime id from the path and answer through the shared schema, never cached', async () => {
    // Arrange
    const { subsystem, asked } = stub();

    // Act
    const response = await dispatcher(subsystem).dispatch(post('/v1/fleet/runtimes/claude-default/check'));

    // Assert
    should(response.status).equal(200);
    should(response.headers.get('cache-control')).equal('no-store');
    should(jsonBody(response)).deepEqual(PASSED);
    should(asked).deepEqual(['claude-default']);
  });

  it('should answer a failed check as 200 with its code: the check ran, the runtime did not pass', async () => {
    // Arrange
    const failed: FleetRuntimeCheckResult = {
      ok: false,
      ms: 30_000,
      code: 'timed_out',
      sentence: 'No answer in 30 seconds.',
    };
    const { subsystem } = stub(async () => failed);

    // Act
    const response = await dispatcher(subsystem).dispatch(post('/v1/fleet/runtimes/rt-1/check'));

    // Assert
    should(response.status).equal(200);
    should(jsonBody(response)).deepEqual(failed);
  });

  it('should answer 404 for an unknown runtime and 409 for a switched-off one, with the code', async () => {
    // Arrange
    const unknown = stub(async () => {
      throw new RuntimeCheckRefusal('fleet_runtime_unknown', 'There is no runtime nope on this machine.');
    });
    const disabled = stub(async () => {
      throw new RuntimeCheckRefusal('fleet_runtime_disabled', 'claude-default is switched off.');
    });

    // Act
    const missing = await dispatcher(unknown.subsystem).dispatch(post('/v1/fleet/runtimes/nope/check'));
    const off = await dispatcher(disabled.subsystem).dispatch(post('/v1/fleet/runtimes/claude-default/check'));

    // Assert
    should(missing.status).equal(404);
    should(jsonBody(missing)).deepEqual({
      error: 'There is no runtime nope on this machine.',
      code: 'fleet_runtime_unknown',
    });
    should(off.status).equal(409);
    should(jsonBody(off).code).equal('fleet_runtime_disabled');
  });

  it('should refuse a body with any field before the service is asked', async () => {
    // Arrange
    const { subsystem, asked } = stub();

    // Act
    const response = await dispatcher(subsystem).dispatch(
      post('/v1/fleet/runtimes/claude-default/check', JSON.stringify({ model: 'claude-opus-5-5' })),
    );

    // Assert
    should(response.status).equal(400);
    should(jsonBody(response).code).equal('invalid_request');
    should(asked).deepEqual([]);
  });

  it('should refuse an answer that carries a field the schema does not have', async () => {
    // Arrange — a service that grew an output field must fail the response, not leak it
    const { subsystem } = stub(async () => ({ ...PASSED, output: 'what the CLI printed' }) as never);

    // Act
    const response = await dispatcher(subsystem).dispatch(post('/v1/fleet/runtimes/claude-default/check'));

    // Assert
    should(response.status).equal(500);
    should(JSON.stringify(jsonBody(response))).not.containEql('what the CLI printed');
  });

  it('should be governed as fleet use', () => {
    // Act
    const [route] = fleetRuntimeCheckRoutes(stub().subsystem);

    // Assert
    should(route).containDeep({
      method: 'POST',
      path: '/v1/fleet/runtimes/:runtimeId/check',
      minimum: 'operator',
      caller: 'any',
      capability: { capability: 'fleet', axis: 'use' },
      noStore: true,
    });
  });
});
