import { describe, it } from 'bun:test';
import { ArchivedSessionsSchema } from '../../../../../daemon/lib/protocol/session.ts';
import should from 'should';
import {
  ARCHIVED_SESSIONS_LIMIT_DEFAULT,
  ARCHIVED_SESSIONS_LIMIT_MAX,
  type SessionArchiveSubsystem,
  sessionArchiveRoutes,
} from '../../../../../daemon/lib/runtime/mounts/session-archive.ts';
import { sessionView } from '../../../../support/daemon/session-view.ts';
import { jsonOf, requestOf } from '../../support/requests.ts';
import { refusalOf } from '../../support/calls.ts';

function archive(count = 3): { subsystem: SessionArchiveSubsystem; limits: number[] } {
  const limits: number[] = [];
  return {
    limits,
    subsystem: {
      count: () => count,
      list: async limit => {
        limits.push(limit);
        return [sessionView('old-1'), sessionView('old-2')].slice(0, limit);
      },
    },
  };
}

async function ask(subsystem: SessionArchiveSubsystem, query: Array<[string, string]> = []) {
  return await sessionArchiveRoutes(subsystem)['GET /v1/archived-sessions'](
    requestOf({ path: '/v1/archived-sessions', query: Object.fromEntries(query) }),
  );
}

describe('the archived sessions mount', () => {
  it('should answer how many are archived and the newest ones in full, in the shape the client parses', async () => {
    const { subsystem, limits } = archive();

    const response = await ask(subsystem);

    should(response.status).equal(200);
    const body = ArchivedSessionsSchema.parse(jsonOf(response));
    should(body.count).equal(3);
    should(body.sessions.map(view => view.config.id)).deepEqual(['old-1', 'old-2']);
    should(limits).deepEqual([ARCHIVED_SESSIONS_LIMIT_DEFAULT]);
  });

  it('should answer only the count, and read no session, for a limit of zero', async () => {
    const { subsystem, limits } = archive(7);

    const body = ArchivedSessionsSchema.parse(jsonOf(await ask(subsystem, [['limit', '0']])));

    should(body).deepEqual({ count: 7, sessions: [] });
    should(limits).deepEqual([]);
  });

  it('should pass a limit through', async () => {
    const { subsystem, limits } = archive();

    await ask(subsystem, [['limit', '1']]);

    should(limits).deepEqual([1]);
  });

  it('should refuse a limit that is not a whole number in range, and any other parameter', async () => {
    const { subsystem } = archive();

    for (const bad of ['-1', '1.5', 'many', String(ARCHIVED_SESSIONS_LIMIT_MAX + 1)])
      should((await refusalOf(ask(subsystem, [['limit', bad]])))?.status).equal(400);
    should((await refusalOf(ask(subsystem, [['offset', '1']])))?.status).equal(400);
  });
});
