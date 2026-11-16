/** Parity row J-0145 (docs/design/rebuild-parity.md, packs). */
import { describe, expect, test } from 'bun:test';
import type { RuntimesApi } from '@ferretry/plugin-runtimes/contract';
import { RuntimeLaunchProbe } from '../../../daemon/adapters/launch-probe.ts';
import manifest from '../../../manifest.ts';

describe('the timers Packs arms', () => {
  test('J-0145 the start check has no deadline timer of its own and Packs arms no job: it runs only on a person’s Clean up', async () => {
    // Today's probe spawned the launcher under a `setTimeout` deadline. On this base the check is Runtimes' own
    // resolution, answered at once, so there is no timer to arm; and no job, so nothing checks a runtime unattended.
    expect((manifest as { data: { jobs?: unknown } }).data.jobs ?? []).toEqual([]);
    expect(manifest.actions?.routes?.find(route => route.key === 'POST /v1/pack/routing/clean-up')?.caller).toBe(
      'person',
    );
    const resolved: string[] = [];
    const runtimes = {
      resolve: async (id: string) => {
        resolved.push(id);
        return { ok: false, refusal: 'not_signed_in', sentence: 'claude-work needs signing in.' };
      },
    } as unknown as RuntimesApi;
    let now = 1_000;
    const probe = new RuntimeLaunchProbe(
      () => runtimes,
      () => (now += 5),
    );

    const outcome = await probe.probe({ wrapper: 'claude-work', harness: 'claude-code', cwd: '/', timeoutMs: 30_000 });

    expect(resolved).toEqual(['claude-work']);
    expect(outcome).toEqual({
      ok: false,
      ms: 5,
      reason: 'it cannot be launched: claude-work needs signing in.',
      code: 'not_logged_in',
    });
  });
});
