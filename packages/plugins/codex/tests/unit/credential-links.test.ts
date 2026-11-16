import { describe, expect, test } from 'bun:test';
import { followCredentialEnds } from '../../daemon/lib/credential-links.ts';

/** What the follower asked the harness to do, in order. */
function recorded() {
  const calls: string[] = [];
  const follow = followCredentialEnds({
    released: async ferret => void calls.push(`released ${ferret}`),
    revoked: async login => void calls.push(`revoked ${login}`),
  });
  return { calls, follow };
}

describe('the sign-in follows the ferret and the login', () => {
  test('a ferret that stopped, or is gone, is released', async () => {
    const { calls, follow } = recorded();

    await follow['ferrets.changed']({ ferret: 'a1', state: 'stopped' });
    await follow['ferrets.changed']({ ferret: 'a2', gone: true });

    expect(calls).toEqual(['released a1', 'released a2']);
  });

  test('a ferret that is starting, working, idle or has no state keeps its sign-in', async () => {
    const { calls, follow } = recorded();

    for (const state of ['starting', 'working', 'idle']) await follow['ferrets.changed']({ ferret: 'a1', state });
    await follow['ferrets.changed']({ ferret: 'a1' });

    expect(calls).toEqual([]);
  });

  test('a login removed, signed out or switched off is revoked', async () => {
    const { calls, follow } = recorded();

    for (const change of ['removed', 'signed-out', 'disabled'])
      await follow['logins.changed']({ loginId: 'work', change });

    expect(calls).toEqual(['revoked work', 'revoked work', 'revoked work']);
  });

  test('a login added, edited, switched on or only looked at keeps its sign-in in every home', async () => {
    const { calls, follow } = recorded();

    for (const change of ['added', 'edited', 'enabled', 'status'])
      await follow['logins.changed']({ loginId: 'work', change });

    expect(calls).toEqual([]);
  });
});
