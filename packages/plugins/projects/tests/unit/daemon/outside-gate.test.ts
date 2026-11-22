import { describe, expect, test } from 'bun:test';
import { filesystemConfigure } from '../../../contract/index.ts';
import { ApiError, type CallContext } from '@ferretry/kernel/contract';
import { outsideHomeGate } from '../../../daemon/features/folders/outside-gate.ts';

type Decision = { allowed: boolean; refusal: string; steppedUp?: boolean };

/** A call with the standing Gate would hand it: the answer `governance.decide` gives, and how often a step-up was spent. */
function call(decision: Decision | undefined) {
  const asked: unknown[] = [];
  const spent = { count: 0 };
  const context = {
    ...(decision === undefined
      ? {}
      : {
          governance: {
            governed: true,
            decide: (demand: unknown) => {
              asked.push(demand);
              return decision;
            },
          },
          spendStepUp: () => {
            spent.count++;
          },
        }),
  } as unknown as CallContext;
  return { context, asked, spent };
}

const failure = async (run: () => Promise<unknown>): Promise<ApiError> => {
  try {
    await run();
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error('expected a refusal');
};

describe('outsideHomeGate (D3: a place outside the home needs filesystem.configure)', () => {
  test('asks for filesystem.configure, and a caller that holds it passes', async () => {
    const { context, asked, spent } = call({ allowed: true, refusal: 'granted' });
    await outsideHomeGate(context)();
    expect(asked).toEqual([filesystemConfigure]);
    expect(spent.count).toBe(0);
  });

  test('a step-up the machine wants asked every time is spent at the decision', async () => {
    const { context, spent } = call({ allowed: true, refusal: 'granted', steppedUp: true });
    await outsideHomeGate(context)();
    expect(spent.count).toBe(1);
  });

  test("a use-only device is refused with Gate's own grant code, naming nothing about the folder", async () => {
    const { context } = call({ allowed: false, refusal: 'device-not-granted' });
    const refused = await failure(outsideHomeGate(context));
    expect([refused.status, refused.code]).toEqual([403, 'grant_device_not_granted']);
    expect(refused.message).not.toMatch(/\//);
  });

  test('a device that only lacks the passkey step-up is told to step up, with the demand to satisfy', async () => {
    const { context } = call({ allowed: false, refusal: 'step-up-required' });
    const refused = await failure(outsideHomeGate(context));
    expect([refused.status, refused.code]).toEqual([403, 'grant_step_up_required']);
    expect(refused.extra).toEqual({ demand: filesystemConfigure });
  });

  test('a call with no standing is refused: a place outside the home is never read on a guess', async () => {
    const { context } = call(undefined);
    const refused = await failure(outsideHomeGate(context));
    expect([refused.status, refused.code]).toEqual([503, 'folder_gate_unavailable']);
  });
});
