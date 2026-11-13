import { describe, expect, test } from 'bun:test';
import {
  TMUX_ABSENT_IMPACT,
  tmuxAvailabilityDoctor,
} from '../../../../daemon/adapters/tmux/tmux-availability-check.ts';
import manifest from '../../../../manifest.ts';
import { terminalsHalf } from '../../../support/daemon/half.ts';

/**
 * The `tmux` doctor row (today's REQUIRED `tmux` check, `daemon/src/lib/core/doctor.ts`): found is `ok`, absent is a
 * `fail` — so the report is not ready — with today's words. Asked through the whole half on the kernel's test host.
 */

describe('tmuxAvailabilityDoctor', () => {
  test('is ok and says where tmux was found when the lookup finds it', async () => {
    const asked: string[] = [];
    const finding = await tmuxAvailabilityDoctor(async name => {
      asked.push(name);
      return '/usr/bin/tmux';
    })();

    expect(finding).toEqual({ state: 'ok', detail: 'found on PATH at /usr/bin/tmux', fix: TMUX_ABSENT_IMPACT });
    // The one name every tmux launch in this plugin uses, and only that.
    expect(asked).toEqual(['tmux']);
  });

  test('fails, never warns, with today’s sentence when tmux cannot be found', async () => {
    const finding = await tmuxAvailabilityDoctor(async () => undefined)();

    expect(finding).toEqual({
      state: 'fail',
      detail: 'not found on PATH',
      fix: 'Sessions cannot start or be managed.',
    });
  });
});

describe('terminals tmux doctor row, through the half', () => {
  test('is declared and implemented, so the host never reports it as not built yet', async () => {
    expect(manifest.doctor).toContain('tmux');
    const half = await terminalsHalf();
    expect(await half.host.doctor('terminals', 'tmux')).toBeDefined();
  });

  test('is ok when tmux is an executable on the search path, launching nothing to find out', async () => {
    const launched: string[] = [];
    const half = await terminalsHalf({}, undefined, {
      spawn: (program, args) => {
        launched.push([program, ...args].join(' '));
        return { exitCode: 1, signal: null, stdout: '', stderr: 'not in this test' };
      },
      executables: ['/opt/tools/bin/tmux'],
      searchPath: '/usr/bin:/opt/tools/bin',
    });

    // The half's own boot work has run by now; only what the doctor row launches is counted.
    launched.length = 0;
    const finding = await half.host.doctor('terminals', 'tmux');

    expect(finding).toEqual({
      state: 'ok',
      detail: 'found on PATH at /opt/tools/bin/tmux',
      fix: TMUX_ABSENT_IMPACT,
    });
    expect(launched).toEqual([]);
  });

  test('fails when tmux is on no folder of the search path', async () => {
    const half = await terminalsHalf({}, undefined, {
      executables: ['/elsewhere/tmux'],
      searchPath: '/usr/bin:/bin',
    });

    expect(await half.host.doctor('terminals', 'tmux')).toEqual({
      state: 'fail',
      detail: 'not found on PATH',
      fix: TMUX_ABSENT_IMPACT,
    });
  });
});
