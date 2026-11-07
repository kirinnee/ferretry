import { expect, test } from 'bun:test';
import { ferretActor } from '@ferretry/core-gate/contract';
import { ferretStanding, ownerStanding } from '@ferretry/core-gate/contract/testing';
import type { CallContext, CallStanding } from '@ferretry/kernel/contract';
import type { FerretId } from '../../../../contract/index.ts';
import {
  type SessionRestartSubsystem,
  sessionRestartRoutes,
} from '../../../../daemon/lib/runtime/mounts/session-restart.ts';

/** A restart subsystem that only remembers who each restart was journalled as. */
function recording(): { readonly subsystem: SessionRestartSubsystem; readonly by: (string | undefined)[] } {
  const by: (string | undefined)[] = [];
  const subsystem = {
    restart: async (_request: unknown, _id?: string, requestedBy?: string) => {
      by.push(requestedBy);
      return { restarted: [], queued: [], skipped: [] };
    },
    status: async () => ({ outdated: [], waiting: [] }),
    cancel: async () => ({ cleared: 0 }),
    drain: async () => undefined,
  } as unknown as SessionRestartSubsystem;
  return { subsystem, by };
}

const post = async (subsystem: SessionRestartSubsystem, standing: CallStanding) => {
  const body = JSON.stringify({ scope: 'all' });
  const request = { headers: new Headers(), text: async () => body };
  await sessionRestartRoutes(subsystem)['POST /v1/restarts']({ ...standing, request } as unknown as CallContext);
};

test('G12 a restart through the admin token naming a ferret is journalled as that ferret’s, as its own token is', async () => {
  const { subsystem, by } = recording();
  const owner = ownerStanding();
  await post(subsystem, { ...owner, actor: ferretActor('lead') } as CallStanding);
  await post(subsystem, ferretStanding('lead' as FerretId));
  await post(subsystem, owner);
  expect(by).toEqual(['session:lead', 'session:lead', 'owner']);
});
