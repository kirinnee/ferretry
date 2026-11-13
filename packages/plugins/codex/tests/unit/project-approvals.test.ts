import { describe, expect, test } from 'bun:test';
import type { FerretId } from '@ferretry/kernel/contract';
import { codexConformance, fakeCodex } from '../../contract/testing/index.ts';
import { CODEX_PROJECT_SERVERS_NOT_TAKEN, codexProjectApprovals } from '../../daemon/lib/project-approvals.ts';

describe('Codex project server approvals', () => {
  test('Codex takes no project server’s sign-in (as today), so it answers not-taken, never all approved', async () => {
    // Act
    const answer = await codexProjectApprovals();

    // Assert
    expect(answer).toEqual({ state: 'not-taken', reason: CODEX_PROJECT_SERVERS_NOT_TAKEN });
  });

  test('the fake answers not-taken by default, records the query, and passes the conformance suite', async () => {
    // Arrange
    const fake = fakeCodex();
    const query = { ferret: 'f1' as FerretId, root: '/work/app', servers: ['docs'] };

    // Act
    const answer = await fake.approvedProjectServers(query);

    // Assert
    expect(answer.state).toBe('not-taken');
    expect(fake.approvalQueries).toEqual([query]);
    expect((await codexConformance(fakeCodex)).ok).toBe(true);
  });
});
