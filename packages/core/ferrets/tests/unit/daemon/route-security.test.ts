import { describe, expect, test } from 'bun:test';
import { CAPABILITIES, STEP_UP_ACTS, STEP_UP_REQUIRED_CODE } from '@ferretry/core-gate/contract';
import type { GrantDecision } from '@ferretry/core-gate/contract';
import { ApiError, type CallContext } from '@ferretry/kernel/contract';
import { terminalLaunchRefusal } from '../../../daemon/lib/route-security/launch.ts';
import { confirmRestore } from '../../../daemon/lib/route-security/restore.ts';
import { stateHomeLaunchRefusal } from '../../../daemon/lib/route-security/state-home.ts';

interface Standing {
  readonly presentation?: { readonly local: boolean };
  readonly governance?: { readonly governed: boolean; readonly decide: (demand: unknown) => GrantDecision };
  readonly spendStepUp?: () => void;
  readonly claimFreshStepUp?: (act: unknown) => boolean;
}
const callOf = (standing: Standing): CallContext => standing as unknown as CallContext;

const refusal = async (work: Promise<unknown> | (() => unknown)): Promise<ApiError> => {
  const outcome = await (typeof work === 'function' ? Promise.resolve().then(work) : work).then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(outcome).toBeInstanceOf(ApiError);
  return outcome as ApiError;
};

const decision = (allowed: boolean, refused: GrantDecision['refusal']): GrantDecision => ({
  allowed,
  refusal: refused,
});
const remote = { local: false } as const;
const roots = async (): Promise<readonly string[]> => ['/work/project', '/other/root/'];

describe('terminal launch refusal', () => {
  const request = { folder: '/work/project/sub' };

  test('refuses a launch the daemon cannot place because the carrier gave no presentation', async () => {
    const error = await refusal(terminalLaunchRefusal(callOf({}), request, roots));
    expect([error.status, error.code]).toEqual([503, 'launch_gate_unavailable']);
  });

  test('lets a local caller launch anything', async () => {
    await terminalLaunchRefusal(callOf({ presentation: { local: true } }), { folder: '/anywhere' }, undefined);
  });

  test('refuses a remote launch with no flags when the known project roots are not bound', async () => {
    const error = await refusal(terminalLaunchRefusal(callOf({ presentation: remote }), request, undefined));
    expect([error.status, error.code]).toEqual([503, 'launch_roots_unavailable']);
  });

  test('lets a remote launch inside a known project root through without asking terminal.use', async () => {
    const call = callOf({ presentation: remote });
    await terminalLaunchRefusal(call, { folder: '/work/project' }, roots);
    await terminalLaunchRefusal(call, request, roots);
    await terminalLaunchRefusal(call, { folder: '/other/root/deep' }, roots);
  });

  test('does not read a sibling folder that only shares a prefix as inside the project root', async () => {
    const error = await refusal(
      terminalLaunchRefusal(callOf({ presentation: remote }), { folder: '/work/project-two' }, roots),
    );
    expect([error.status, error.code]).toEqual([503, 'launch_gate_unavailable']);
  });

  test('refuses a flagged or outside launch when the daemon cannot decide terminal.use', async () => {
    const flagged = await refusal(
      terminalLaunchRefusal(
        callOf({ presentation: remote }),
        { ...request, options: { harnessFlags: ['--x'] } },
        undefined,
      ),
    );
    expect([flagged.status, flagged.code]).toEqual([503, 'launch_gate_unavailable']);
  });

  test('a flagged launch the grants allow spends the step-up once and is let through', async () => {
    let spent = 0;
    const asked: unknown[] = [];
    await terminalLaunchRefusal(
      callOf({
        presentation: remote,
        governance: {
          governed: true,
          decide: demand => {
            asked.push(demand);
            return decision(true, 'granted');
          },
        },
        spendStepUp: () => {
          spent += 1;
        },
      }),
      { ...request, options: { harnessFlags: ['--dangerous'] } },
      undefined,
    );
    expect(spent).toBe(1);
    expect(asked).toEqual([{ capability: CAPABILITIES.terminal, axis: 'use' }]);
  });

  test('an outside launch the grants allow is let through even when the carrier has no step-up to spend', async () => {
    await terminalLaunchRefusal(
      callOf({ presentation: remote, governance: { governed: true, decide: () => decision(true, 'granted') } }),
      { folder: '/elsewhere' },
      roots,
    );
  });

  test('an outside launch the grants refuse is 403 with the grant code', async () => {
    const error = await refusal(
      terminalLaunchRefusal(
        callOf({ presentation: remote, governance: { governed: true, decide: () => decision(false, 'not-granted') } }),
        { folder: '/elsewhere' },
        roots,
      ),
    );
    expect([error.status, error.code, error.extra]).toEqual([403, 'grant_not_granted', undefined]);
  });

  test('an outside launch that needs a fresh passkey names the step-up code and the demand', async () => {
    const error = await refusal(
      terminalLaunchRefusal(
        callOf({
          presentation: remote,
          governance: { governed: true, decide: () => decision(false, 'step-up-required') },
        }),
        { folder: '/elsewhere' },
        roots,
      ),
    );
    expect([error.status, error.code]).toEqual([403, STEP_UP_REQUIRED_CODE]);
    expect(error.extra).toEqual({ demand: { capability: CAPABILITIES.terminal, axis: 'use' } });
  });
});

describe('restoring a cut-off ferret', () => {
  test('is for the owner alone: a ferret caller is refused', async () => {
    const error = await refusal(() => confirmRestore(callOf({}), true)());
    expect([error.status, error.code]).toEqual([403, 'owner_only']);
  });

  test('is refused when the daemon cannot say what this device may do', async () => {
    const error = await refusal(() => confirmRestore(callOf({}), false)());
    expect([error.status, error.code]).toEqual([403, 'grant_undetermined']);
  });

  test('is let through for an ungoverned caller without asking the grants', () => {
    confirmRestore(
      callOf({
        governance: {
          governed: false,
          decide: () => {
            throw new Error('must not decide');
          },
        },
      }),
      false,
    )();
  });

  test('is refused with the grant code when the device may not change the fleet', async () => {
    const error = await refusal(() =>
      confirmRestore(
        callOf({ governance: { governed: true, decide: () => decision(false, 'device-not-granted') } }),
        false,
      )(),
    );
    expect([error.status, error.code]).toEqual([403, 'grant_device_not_granted']);
  });

  test('needs a fresh passkey for the act even when the grants only ask for a step-up', async () => {
    const error = await refusal(() =>
      confirmRestore(
        callOf({
          governance: { governed: true, decide: () => decision(false, 'step-up-required') },
          claimFreshStepUp: () => false,
        }),
        false,
      )(),
    );
    expect([error.status, error.code]).toEqual([403, STEP_UP_REQUIRED_CODE]);
    expect(error.extra).toEqual({
      demand: { capability: CAPABILITIES.fleet, axis: 'configure', act: STEP_UP_ACTS.resumeCutOff },
    });
  });

  test('is let through once this device has claimed a fresh passkey for the act', () => {
    const claimed: unknown[] = [];
    confirmRestore(
      callOf({
        governance: { governed: true, decide: () => decision(true, 'granted') },
        claimFreshStepUp: act => {
          claimed.push(act);
          return true;
        },
      }),
      false,
    )();
    expect(claimed).toEqual([STEP_UP_ACTS.resumeCutOff]);
  });
});

describe('a ferret starting inside the state home', () => {
  const reach = (holding: (path: string) => Promise<string | undefined>) => ({ holding });

  test('is not asked of a person: only a ferret caller is fenced', async () => {
    await stateHomeLaunchRefusal(false, undefined, '/anywhere');
  });

  test('is refused when the daemon cannot resolve its own state home', async () => {
    const none = await refusal(stateHomeLaunchRefusal(true, undefined, '/work'));
    expect([none.status, none.code]).toEqual([503, 'state_home_unresolved']);
    const broken = await refusal(
      stateHomeLaunchRefusal(
        true,
        reach(async () => {
          throw new Error('stat failed');
        }),
        '/work',
      ),
    );
    expect([broken.status, broken.code]).toEqual([503, 'state_home_unresolved']);
  });

  test('is let through when the folder is not held by the state home', async () => {
    await stateHomeLaunchRefusal(
      true,
      reach(async () => undefined),
      '/work/project',
    );
  });

  test('is refused with the state home named when the folder is inside it', async () => {
    const error = await refusal(
      stateHomeLaunchRefusal(
        true,
        reach(async () => '/fy-home'),
        '/fy-home/x',
      ),
    );
    expect([error.status, error.code]).toEqual([403, 'state_home']);
    expect(error.message).toContain('/fy-home');
  });
});
