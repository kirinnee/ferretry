import { describe, expect, test } from 'bun:test';
import { REFUSAL_SENTENCES } from '@ferretry/kernel/contract';
import type {
  FormKey,
  HarnessDeliveryFailure,
  HarnessRefusal,
  RunnerFormCapture,
} from '@ferretry/core-ferrets/contract';
import { FakeFerrets } from '@ferretry/core-ferrets/contract/testing';
import { fixedClock, owner, testHost } from '@ferretry/kernel/testing';
import { err, ok } from '@ferretry/std';
import daemon from '../../daemon/index.ts';
import { parsePermissionPrompt } from '../../daemon/lib/pane/permission-prompt.ts';
import { withCursor } from '../support/key-pane.ts';

/**
 * The permission answer through the real daemon half and its ferret form pane (`FerretFormPane`), over Ferrets' form seam.
 * The fake is only the runner behind that seam: a pane that shows a recorded Claude Code prompt, moves its cursor on
 * Up/Down, drops to a prompt on Enter or Escape, and can be told to refuse. What is proved is the HTTP outcome of each
 * way the seam can say no, and which keys reached the pane.
 */

const read = async (name: string): Promise<string> =>
  await Bun.file(`${import.meta.dir}/../fixtures/${name}.txt`).text();
const IDLE = '❯ \n  ? for shortcuts';

interface Script {
  /** What a capture answers; the default shows the prompt (and the idle prompt once it was answered). */
  readonly capture?: () => ReturnType<typeof ok> | ReturnType<typeof err>;
  /** What a key answers instead of pressing it. */
  readonly key?: () => ReturnType<typeof ok> | ReturnType<typeof err>;
}

async function world(script: Script = {}) {
  const prompt = await read('permission-prompts/claude-2.1.220-bash');
  const id = parsePermissionPrompt(prompt)?.id as string;
  const keys: FormKey[] = [];
  let frame = prompt;
  const screen = (visible: string): RunnerFormCapture => ({
    alive: true,
    dead: false,
    promptReady: visible === IDLE,
    activeWork: false,
    visible,
    history: visible,
  });
  const ferrets = Object.assign(new FakeFerrets(), {
    harness: async () =>
      ({
        form: {
          capture: async () => script.capture?.() ?? ok(screen(frame)),
          key: async (key: FormKey) => {
            const refused = script.key?.();
            if (refused !== undefined) return refused;
            keys.push(key);
            if (key === 'Enter' || key === 'Escape') frame = IDLE;
            else frame = withCursor(frame, key === 'Down' ? 2 : 1);
            return ok(undefined);
          },
          paste: async () => ok(undefined),
        },
      }) as never,
  });
  const clock = fixedClock('2026-11-07T09:00:00Z');
  const host = await testHost({ fakes: { ferrets }, plugins: [daemon], clock });
  /** POSTs an answer and moves the driven clock while the service waits for the pane to settle. */
  const answer = async (body: Record<string, unknown>) => {
    let settled = false;
    const done = host
      .request('POST', '/v1/ferrets/f1/permission', { body: { requestId: id, ...body }, as: owner() })
      .finally(() => {
        settled = true;
      });
    for (let round = 0; round < 100 && !settled; round += 1) {
      await clock.advance(200);
      await Bun.sleep(0);
    }
    return await done;
  };
  return { host, keys, answer };
}

const refusing = (failure: HarnessRefusal | HarnessDeliveryFailure) => () => err(failure);

describe('answering a permission prompt through Ferrets’ form seam', () => {
  test('moves the cursor, then confirms with Enter, and says the prompt cleared', async () => {
    const { host, keys, answer } = await world();

    const response = await answer({ kind: 'choice', number: 2 });

    expect(response.status).toBe(200);
    expect(keys).toEqual(['Down', 'Enter']);
    expect(response.json()).toMatchObject({ cleared: true });
    await host.stop();
  });

  test('a pane the runner reports dead is a 409 pane_unknown, and nothing is pressed', async () => {
    const prompt = await read('permission-prompts/claude-2.1.220-bash');
    const { host, keys, answer } = await world({
      capture: () =>
        ok({ alive: true, dead: true, promptReady: false, activeWork: false, visible: prompt, history: prompt }),
    });

    const response = await answer({ kind: 'deny' });

    expect([response.status, response.json<{ code: string }>().code]).toEqual([409, 'pane_unknown']);
    expect(keys).toEqual([]);
    await host.stop();
  });

  test('a form that cannot be read says why, in the closed words of the seam', async () => {
    for (const [refused, status, code] of [
      ['no_pane', 409, 'pane_unknown'],
      ['plugin_unavailable', 503, 'plugin_unavailable'],
      ['held', 409, 'held'],
    ] as const) {
      const { host, keys, answer } = await world({ capture: refusing({ refused }) });

      const response = await answer({ kind: 'deny' });

      expect([response.status, response.json<{ code: string }>().code]).toEqual([status, code]);
      if (refused === 'held') expect(response.json<{ error: string }>().error).toBe(REFUSAL_SENTENCES.held);
      expect(keys).toEqual([]);
      await host.stop();
    }
  });

  test('a key the seam refuses is told apart: no pane to press at, a runner that is off, a composer that cannot take it, a held pane', async () => {
    const cases: readonly [HarnessDeliveryFailure, number, string][] = [
      [{ refused: 'no_pane' }, 409, 'pane_unknown'],
      [{ refused: 'not_ready', why: 'exited' } as HarnessDeliveryFailure, 409, 'pane_unknown'],
      [{ refused: 'plugin_unavailable' }, 503, 'plugin_unavailable'],
      [{ refused: 'composer_occupied', draft: 'half a thought' }, 409, 'console_input_failed'],
      [{ refused: 'composer_unreadable' }, 409, 'console_input_failed'],
      [{ refused: 'quarantined' }, 409, 'quarantined'],
    ];
    for (const [failure, status, code] of cases) {
      const { host, keys, answer } = await world({ key: refusing(failure) });

      const response = await answer({ kind: 'deny' });

      expect([response.status, response.json<{ code: string }>().code]).toEqual([status, code]);
      expect(keys).toEqual([]);
      await host.stop();
    }
  });

  test('a key that was typed but not proved to have landed is a 409 console_input_failed that says it may have reached the terminal', async () => {
    const { host, answer } = await world({ key: refusing({ unconfirmed: true, stranded: false }) });

    const response = await answer({ kind: 'deny' });

    expect(response.status).toBe(409);
    expect(response.json<{ code: string; error: string }>()).toMatchObject({
      code: 'console_input_failed',
      error: 'the key may not have reached the terminal',
    });
    await host.stop();
  });
});
