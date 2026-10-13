/**
 * The credentials surface at the daemon's front door: the list and **Check now**
 * (docs/design/account-model.md §7).
 *
 * The service behind it is a stub here, because what the mount owns is the HTTP shape: which status a
 * refusal becomes, that both answers are parsed through the shared schema and never cached, and that a
 * check is handed the caller's governance rather than deciding it.
 */
import { describe, it } from 'bun:test';
import type { FleetCredentialCheckRequest, FleetCredentialList, FleetCredentialView } from '@ferretry/protocol';
import should from 'should';
import type { CallerGovernance } from '../../../../src/lib/api/capability.ts';
import { ApiDispatcher } from '../../../../src/lib/api/dispatcher.ts';
import { ApiRouter } from '../../../../src/lib/api/router.ts';
import { FleetCredentialRefusal } from '../../../../src/lib/fleet/credentials-service.ts';
import {
  type FleetCredentialsSubsystem,
  fleetCredentialRoutes,
} from '../../../../src/lib/runtime/mounts/fleet-credentials.ts';
import { jsonBody, request } from '../../api/support.ts';
import { CREDENTIALS, GRANTED, human } from './support.ts';

const VIEW: FleetCredentialView = {
  id: 'work',
  harness: 'claude',
  store: 'ferretry',
  email: 'person@example.com',
  needsLabel: false,
  sharedWithTerminal: false,
  status: {
    word: 'ready',
    label: 'Ready',
    reason: 'not_checked_yet',
    explanation: 'This login is present and current.',
    lastCheckInconclusive: false,
  },
  usage: { fiveHour: {}, weekly: {} },
  usedBy: ['claude-work'],
  signIn: { available: true },
  checkNow: { available: true },
  signOut: {
    available: true,
    sentence: 'Sign out of person@example.com? 1 runtime will need sign-in.',
    runtimesAffected: 1,
    signsOutTerminal: false,
  },
};

const LIST: FleetCredentialList = { format: 2, machine: 'studio', credentials: [VIEW] };

interface Checked {
  readonly id: string;
  readonly request: FleetCredentialCheckRequest;
  readonly governance: CallerGovernance | undefined;
}

function dispatcher(subsystem: FleetCredentialsSubsystem): ApiDispatcher {
  return new ApiDispatcher(new ApiRouter(fleetCredentialRoutes(subsystem)), CREDENTIALS, GRANTED);
}

function recording(check: FleetCredentialsSubsystem['check']): {
  readonly subsystem: FleetCredentialsSubsystem;
  readonly calls: Checked[];
} {
  const calls: Checked[] = [];
  return {
    calls,
    subsystem: {
      list: async () => LIST,
      check: async (id, body, governance) => {
        calls.push({ id, request: body, governance });
        return await check(id, body, governance);
      },
    },
  };
}

const post = (path: string, body = '{}') =>
  request({ method: 'POST', path, headers: { ...human, 'content-type': 'application/json' }, body });

describe('the fleet credentials mount', () => {
  it('should list every credential through the shared schema and never let it be cached', async () => {
    // Arrange
    const { subsystem } = recording(async () => VIEW);

    // Act
    const response = await dispatcher(subsystem).dispatch(request({ path: '/v1/fleet/credentials', headers: human }));

    // Assert
    should(response.status).equal(200);
    should(jsonBody(response)).deepEqual(LIST);
    should(response.headers.get('cache-control')).equal('no-store');
  });

  it('should run Check now on the named login with the caller governance and answer its row', async () => {
    // Arrange
    const { subsystem, calls } = recording(async () => VIEW);

    // Act
    const response = await dispatcher(subsystem).dispatch(
      post('/v1/fleet/credentials/work/check', JSON.stringify({ operatorPassword: 'correct horse' })),
    );

    // Assert
    should(response.status).equal(200);
    should(jsonBody(response)).deepEqual(VIEW);
    should(response.headers.get('cache-control')).equal('no-store');
    should(calls).have.length(1);
    should(calls[0]?.id).equal('work');
    should(calls[0]?.request).deepEqual({ operatorPassword: 'correct horse' });
    should(calls[0]?.governance).containDeep({ governed: false, passwordSet: false, confirmChange: false });
  });

  it('should answer 404 for a login that does not exist', async () => {
    // Arrange
    const { subsystem } = recording(async id => {
      throw new FleetCredentialRefusal('fleet_credential_unknown', `no login "${id}" exists on this machine`);
    });

    // Act
    const response = await dispatcher(subsystem).dispatch(post('/v1/fleet/credentials/ghost/check'));

    // Assert
    should(response.status).equal(404);
    should(jsonBody(response)).deepEqual({
      error: 'no login "ghost" exists on this machine',
      code: 'fleet_credential_unknown',
    });
  });

  it('should answer 409 for every other refusal, in its own words', async () => {
    // Arrange
    const { subsystem } = recording(async () => {
      throw new FleetCredentialRefusal('fleet_credential_unavailable', 'Migrate this machine first.');
    });

    // Act
    const response = await dispatcher(subsystem).dispatch(post('/v1/fleet/credentials/work/check'));

    // Assert
    should(response.status).equal(409);
    should(jsonBody(response)).deepEqual({
      error: 'Migrate this machine first.',
      code: 'fleet_credential_unavailable',
    });
  });

  it('should refuse a login id that cannot be decoded before asking the service', async () => {
    // Arrange
    const { subsystem, calls } = recording(async () => VIEW);

    // Act
    const response = await dispatcher(subsystem).dispatch(post('/v1/fleet/credentials/%E0/check'));

    // Assert
    should(response.status).equal(400);
    should(jsonBody(response).code).equal('bad_request');
    should(calls).have.length(0);
  });

  it('should leave an unexpected failure to the dispatcher rather than dress it as a refusal', async () => {
    // Arrange
    const subsystem: FleetCredentialsSubsystem = {
      list: async () => {
        throw new Error('the disk went away');
      },
      check: async () => VIEW,
    };

    // Act
    const response = await dispatcher(subsystem).dispatch(request({ path: '/v1/fleet/credentials', headers: human }));

    // Assert
    should(response.status).equal(500);
    should(jsonBody(response).code).equal('internal_error');
  });

  it('should refuse a check body with a field the contract does not name', async () => {
    // Arrange
    const { subsystem, calls } = recording(async () => VIEW);

    // Act
    const response = await dispatcher(subsystem).dispatch(
      post('/v1/fleet/credentials/work/check', JSON.stringify({ token: 'nope' })),
    );

    // Assert
    should(response.status).equal(400);
    should(calls).have.length(0);
  });
});
