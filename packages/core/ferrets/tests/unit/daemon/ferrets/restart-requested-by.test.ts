import { expect, test } from 'bun:test';
import { ferretActor } from '@ferretry/core-gate/contract';
import { ferretStanding, ownerStanding } from '@ferretry/core-gate/contract/testing';
import type { CallContext, CallStanding } from '@ferretry/kernel/contract';
import type { FerretId, LaunchOrigin } from '../../../../contract/index.ts';
import {
  type SessionRestartSubsystem,
  sessionRestartRoutes,
} from '../../../../daemon/lib/runtime/mounts/session-restart.ts';

/** A restart subsystem that only remembers who each restart was journalled as, and the launch origin it carried. */
function recording(): {
  readonly subsystem: SessionRestartSubsystem;
  readonly by: (string | undefined)[];
  readonly origins: LaunchOrigin[];
} {
  const by: (string | undefined)[] = [];
  const origins: LaunchOrigin[] = [];
  const subsystem = {
    restart: async (_request: unknown, origin: LaunchOrigin, _id?: string, requestedBy?: string) => {
      origins.push(origin);
      by.push(requestedBy);
      return { restarted: [], queued: [], skipped: [] };
    },
    status: async () => ({ outdated: [], waiting: [] }),
    cancel: async () => ({ cleared: 0 }),
    drain: async () => undefined,
  } as unknown as SessionRestartSubsystem;
  return { subsystem, by, origins };
}

const post = async (subsystem: SessionRestartSubsystem, standing: CallStanding) => {
  const body = JSON.stringify({ scope: 'all' });
  const request = { headers: new Headers(), text: async () => body };
  await sessionRestartRoutes(subsystem)['POST /v1/restarts']({ ...standing, request } as unknown as CallContext);
};

test('G12 a restart through the admin token naming a ferret is journalled as that ferret’s, as its own token is', async () => {
  const { subsystem, by, origins } = recording();
  const owner = ownerStanding();
  await post(subsystem, { ...owner, actor: ferretActor('lead') } as CallStanding);
  await post(subsystem, ferretStanding('lead' as FerretId));
  await post(subsystem, owner);
  expect(by).toEqual(['session:lead', 'session:lead', 'owner']);
  // The launch origin rides beside the journal name: the admin token naming a ferret is that agent's, a person's own call is a person's.
  expect(origins).toEqual([
    { kind: 'agent', ferret: 'lead' as FerretId },
    { kind: 'agent', ferret: 'lead' as FerretId },
    { kind: 'person' },
  ]);
});
