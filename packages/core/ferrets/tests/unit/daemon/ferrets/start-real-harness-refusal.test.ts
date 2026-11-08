import { describe, expect, test } from 'bun:test';
import { err, type Result } from '@ferretry/std';
import {
  REAL_HARNESS_REFUSED,
  type RunningFerret,
  type RunSpec,
  type StartRefusal,
} from '../../../../contract/index.ts';
import { FakeHarness, FakeRunner } from '../../../../contract/testing/index.ts';
import { host } from './route-fixture.ts';

/**
 * A test-mode runner that refuses a launch reaching the owner's real Claude Code or Codex answers the closed
 * `real_harness` refusal (Terminals' tmux runner logs the harness and the path it found). Ferrets must say WHY in the
 * start's answer — never the generic "the harness could not start" — and leave nothing running.
 */

/** A runner whose launch guard refused every start. */
class RefusingRunner extends FakeRunner {
  override async start(_spec: RunSpec): Promise<Result<RunningFerret, StartRefusal>> {
    return err('real_harness');
  }
}

describe('terminals #23 a launch the test-mode guard refused (U1, Ferrets side)', () => {
  test('terminals #23 launch guard refusal is the start reason: 409 refused with the remedy, and the ferret is stopped', async () => {
    const h = await host([], { harness: new FakeHarness(), runner: new RefusingRunner() });

    const answer = await h.request('POST', '/v1/ferrets', {
      headers: { 'x-fy-request-id': 'real-harness-1' },
      body: { folder: '/work/a', name: 'wren' },
    });

    expect(answer.status).toBe(409);
    expect(answer.json<{ code: string }>().code).toBe('refused');
    expect(answer.body).toContain(REAL_HARNESS_REFUSED);
    expect(answer.body).not.toContain('a launch dependency failed');
    expect(REAL_HARNESS_REFUSED).toContain('a fake claude/codex first on the daemon PATH');
    const ferrets = (await h.request('GET', '/v1/ferrets')).json<{ state: string }[]>();
    expect(ferrets.every(ferret => ferret.state === 'stopped')).toBe(true);
  });
});
