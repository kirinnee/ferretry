/**
 * c58-28b review round 1: the catalogue commits a runtime rename before the ferrets' session records are rewritten, and a
 * failed or interrupted rewrite (a transient config write failure, a crash between the two writes) is swallowed. A record
 * left on the OLD name must still start, resolving through the runtime's `ids.json` former names, so Resume and Restart are
 * never refused "no runtime ... exists" for a runtime that was only renamed.
 */
import { describe, expect, test } from 'bun:test';
import type { RuntimeFile } from '../../../contract/index.ts';
import { createRuntimesApi } from '../../../daemon/lib/service/runtimes-api.ts';
import { runtimeStartAnswer } from '../../../daemon/lib/service/runtime-start-answer.ts';

const FILE = { login: 'main', profile: 'default' } as unknown as RuntimeFile;
const logins = {
  list: async () => ({ logins: [{ id: 'main', harness: 'claude-code', status: { word: 'ready' } }] }) as never,
};

/** A machine where `work` was renamed to `play`: the files say `play`, `ids.json` remembers `work`. */
function renamedMachine(currentName?: (former: string) => Promise<string | undefined>) {
  const asked: string[] = [];
  const api = createRuntimesApi({
    runtimes: () => new Map([['play', FILE]]),
    profiles: () => new Map([['default', {} as never]]),
    defaultSetting: () => undefined,
    harnesses: () => ['claude-code'],
    logins,
    now: () => 0,
    currentName:
      currentName ??
      (async former => {
        asked.push(former);
        return former === 'work' ? 'play' : undefined;
      }),
  });
  return { asked, start: runtimeStartAnswer({ resolve: api.resolve, logins }) };
}

describe('a session record a runtime rename did not reach', () => {
  test('starts on the renamed runtime through its former name', async () => {
    const { start } = renamedMachine();

    expect(await start.resolve('work')).toEqual({ ok: true, harness: 'claude-code', login: 'main' });
  });

  test('a record already on the new name is unchanged and never asks the former names', async () => {
    const { asked, start } = renamedMachine();

    expect(await start.resolve('play')).toEqual({ ok: true, harness: 'claude-code', login: 'main' });
    expect(asked).toEqual([]);
  });

  test('a name no runtime ever carried is still refused', async () => {
    const { start } = renamedMachine();

    const refused = await start.resolve('ghost');

    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.sentence).toContain('no runtime ghost exists on this machine');
  });

  test('an unreadable ids.json refuses rather than guessing', async () => {
    const { start } = renamedMachine(async () => {
      throw new Error('ids.json could not be read');
    });

    expect((await start.resolve('work')).ok).toBe(false);
  });
});
