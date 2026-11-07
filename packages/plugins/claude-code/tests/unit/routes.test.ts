import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type ApiResponse, BodyTooLargeError } from '@ferretry/kernel/contract';
import { deviceStanding, ferretStanding, ownerStanding } from '@ferretry/core-gate/contract/testing';
import {
  HARNESS_UPDATE_CODES,
  PermissionAnswerResultSchema,
  HarnessDialogAnswerResultSchema,
} from '../../contract/index.ts';
import { DialogAnswerService } from '../../daemon/lib/dialog/service.ts';
import { parseHarnessDialog } from '../../daemon/lib/pane/harness-dialog.ts';
import { parsePermissionPrompt } from '../../daemon/lib/pane/permission-prompt.ts';
import { PermissionAnswerService } from '../../daemon/lib/permission/service.ts';
import { dialogRoute, permissionRoute, updateStartRoute } from '../../daemon/lib/routes.ts';
import { HarnessUpdateRefusal } from '../../daemon/lib/update/service.ts';

const fixture = (dir: string, name: string): string =>
  readFileSync(join(import.meta.dir, '../fixtures', dir, `${name}.txt`), 'utf8');
const BASH = fixture('permission-prompts', 'claude-2.1.220-bash');
const WRITE = fixture('permission-prompts', 'claude-2.1.220-write');
const SETTINGS = fixture('harness-dialogs', 'claude-2.1.220-settings-error');
const IDLE = '❯ \n  ? for shortcuts';
const TIMING = { settleReads: 3, settleMs: 1 } as const;
const sleep = async (): Promise<void> => {};

/** A pane that serves frames in order (the last repeats) and records every byte typed. */
class Pane {
  readonly writes: string[] = [];
  captures = 0;
  constructor(private readonly frames: readonly string[]) {}
  async capture(): Promise<string> {
    const frame = this.frames[Math.min(this.captures, this.frames.length - 1)] as string;
    this.captures += 1;
    return frame;
  }
  async write(_ferret: string, bytes: Uint8Array): Promise<number> {
    this.writes.push(new TextDecoder().decode(bytes));
    return bytes.length;
  }
}

const call = (body: unknown, extra: object = {}) =>
  ({
    request: { text: async () => JSON.stringify(body) },
    params: new Map([['ferretId', 'f1']]),
    ...extra,
  }) as never;

/** A call carrying exactly `text`, read the way every arrival reads one: over the route's bound is a 413. */
const rawCall = (text: string) =>
  ({
    request: {
      text: async (limit?: number) => {
        if (limit !== undefined && new TextEncoder().encode(text).byteLength > limit)
          throw new BodyTooLargeError(limit);
        return text;
      },
    },
    params: new Map([['ferretId', 'f1']]),
  }) as never;

const body = (response: ApiResponse): { status: number; json: Record<string, unknown>; text: string } => {
  const plain = response as { status: number; body: string };
  return { status: plain.status, json: JSON.parse(plain.body) as Record<string, unknown>, text: plain.body };
};

const refused = async (promise: Promise<unknown>): Promise<{ status: number; code?: string }> => {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  return error as { status: number; code?: string };
};

/**
 * A remote device as Gate admits it: governed, holding a fresh passkey proof until a route claims it. Each request
 * reads the standing again, as Gate stamps a new one per call — and `freshStepUp` is that admission's SNAPSHOT, so two
 * standings taken before either request runs both say fresh. The claim is atomic, as Access's is. `spent` counts every
 * claim and every spend, so a route that took the proof twice would show 2.
 */
function remoteDevice(fresh: boolean) {
  const state = { fresh, spent: 0 };
  const standing = () => ({
    ...deviceStanding('phone'),
    governance: { governed: true, decide: () => ({ allowed: true, refusal: 'granted' }) },
    presentation: { local: false, adminToken: false, actor: 'device:phone', stepUp: false, freshStepUp: state.fresh },
    claimFreshStepUp: () => {
      if (!state.fresh) return false;
      state.fresh = false;
      state.spent += 1;
      return true;
    },
    spendFreshStepUp: () => {
      state.spent += 1;
      state.fresh = false;
    },
  });
  return { state, standing };
}

describe('the permission answer route', () => {
  const requestId = (frame: string): string => parsePermissionPrompt(frame)?.id as string;

  test('G31 the answer is one key into the pane that still shows the prompt, and its result never carries the choice', async () => {
    const pane = new Pane([BASH, BASH, IDLE]);
    const route = permissionRoute(new PermissionAnswerService(pane, sleep, TIMING));

    const response = body(await route(call({ kind: 'choice', requestId: requestId(BASH), number: 2 })));

    expect(response.status).toBe(200);
    expect(pane.writes).toEqual(['2']);
    expect(PermissionAnswerResultSchema.safeParse(response.json).success).toBe(true);
    expect(Object.keys(response.json).sort()).toEqual(['cleared', 'requestId']);
    expect(response.json.cleared).toBe(true);
  });

  test('G31 a prompt that changed is gone: 409 and nothing typed', async () => {
    const pane = new Pane([WRITE]);
    const route = permissionRoute(new PermissionAnswerService(pane, sleep, TIMING));

    const error = await refused(route(call({ kind: 'choice', requestId: requestId(BASH), number: 1 })));

    expect(error).toMatchObject({ status: 409, code: 'permission_prompt_gone' });
    expect(pane.writes).toEqual([]);
  });

  test('G31 a choice the prompt does not list is 400 and nothing typed', async () => {
    const pane = new Pane([BASH]);
    const route = permissionRoute(new PermissionAnswerService(pane, sleep, TIMING));

    const error = await refused(route(call({ kind: 'choice', requestId: requestId(BASH), number: 9 })));

    expect(error).toMatchObject({ status: 400, code: 'invalid_permission_choice' });
    expect(pane.writes).toEqual([]);
  });

  test('G31 a refusal is Escape alone', async () => {
    const pane = new Pane([BASH, IDLE]);
    const route = permissionRoute(new PermissionAnswerService(pane, sleep, TIMING));

    await route(call({ kind: 'deny', requestId: requestId(BASH) }));

    expect(pane.writes).toEqual(['\u001b']);
  });

  test('G31 a pane that cannot be read is a 409 console_input_failed, not a crash', async () => {
    const route = permissionRoute(
      new PermissionAnswerService(
        {
          capture: async () => {
            throw new Error('no pane');
          },
          write: async () => 0,
        },
        sleep,
        TIMING,
      ),
    );

    const error = await refused(route(call({ kind: 'deny', requestId: '0123456789abcdef' })));

    expect(error).toMatchObject({ status: 409, code: 'console_input_failed' });
  });
});

describe('the harness-dialog answer route', () => {
  const dialogId = (frame: string): string => parseHarnessDialog(frame)?.id as string;

  test('G32 the answer moves the cursor, checks it arrived, presses Enter, and its result never carries the choice', async () => {
    const moved = SETTINGS.replace('❯ 1. Fix with Claude', '  1. Fix with Claude').replace(
      '    2. Exit and fix manually',
      '  ❯ 2. Exit and fix manually',
    );
    const pane = new Pane([SETTINGS, SETTINGS, moved, IDLE]);
    const route = dialogRoute(new DialogAnswerService(pane, sleep, TIMING));

    const response = body(await route(call({ kind: 'choice', dialogId: dialogId(SETTINGS), number: 2 })));

    expect(response.status).toBe(200);
    expect(pane.writes).toEqual(['\u001b[B', '\r']);
    expect(HarnessDialogAnswerResultSchema.safeParse(response.json).success).toBe(true);
    expect(Object.keys(response.json).sort()).toEqual(['cleared', 'dialogId']);
  });

  test('G32 a dialog that is gone is a 409 and nothing is typed', async () => {
    const pane = new Pane([IDLE]);
    const route = dialogRoute(new DialogAnswerService(pane, sleep, TIMING));

    const error = await refused(route(call({ kind: 'escape', dialogId: dialogId(SETTINGS) })));

    expect(error).toMatchObject({ status: 409, code: 'harness_dialog_gone' });
    expect(pane.writes).toEqual([]);
  });

  test('G32 a row the dialog does not list is a 400', async () => {
    const pane = new Pane([SETTINGS]);
    const route = dialogRoute(new DialogAnswerService(pane, sleep, TIMING));

    const error = await refused(route(call({ kind: 'choice', dialogId: dialogId(SETTINGS), number: 8 })));

    expect(error).toMatchObject({ status: 400, code: 'invalid_dialog_choice' });
  });
});

describe('the update start route', () => {
  const view = { harness: 'claude-code' } as never;
  const accepting = (spent: string[]) => ({
    view: async () => view,
    start: async () => view,
    settled: async () => {},
    spent,
  });

  test('G25 a ferret never starts an update', async () => {
    const route = updateStartRoute(accepting([]));

    const error = await refused(route(call({}, { credential: { tokenClass: 'ferret', ferret: 'f1' } })));

    expect(error).toMatchObject({ status: 403, code: 'forbidden' });
  });

  test('G25 a governed device without a fresh passkey proof is asked for one, and nothing starts', async () => {
    let started = 0;
    const route = updateStartRoute({
      view: async () => view,
      start: async () => {
        started += 1;
        return view;
      },
    });

    const response = body(await route(call({}, { governance: { governed: true }, presentation: {} })));

    expect(response.status).toBe(403);
    expect(response.json.code).toBe('grant_step_up_required');
    expect(started).toBe(0);
  });

  test('G25 the passkey proof is claimed before the update starts, and the answer is 202', async () => {
    const spent: string[] = [];
    const route = updateStartRoute(accepting(spent));

    const response = body(
      await route(
        call(
          {},
          {
            governance: { governed: true },
            presentation: { freshStepUp: true },
            claimFreshStepUp: () => spent.push('claimed') > 0,
            spendFreshStepUp: () => spent.push('spent'),
          },
        ),
      ),
    );

    expect(response.status).toBe(202);
    expect(spent).toEqual(['claimed']);
  });

  test('G25 a governed device whose standing cannot claim is refused, and nothing starts (fail closed)', async () => {
    let started = 0;
    const route = updateStartRoute({
      view: async () => view,
      start: async () => {
        started += 1;
        return view;
      },
    });

    const response = body(
      await route(call({}, { governance: { governed: true }, presentation: { freshStepUp: true } })),
    );

    expect([response.status, response.json.code, started]).toEqual([403, 'grant_step_up_required', 0]);
  });

  test('past the verified version is a 409 whose body names both versions', async () => {
    const route = updateStartRoute({
      view: async () => view,
      start: async () => {
        throw new HarnessUpdateRefusal(HARNESS_UPDATE_CODES.unverified, 'not verified', {
          target: '2.1.230',
          verified: '2.1.220',
        });
      },
    });

    const response = body(await route(call({})));

    expect(response.status).toBe(409);
    expect(response.json).toMatchObject({ code: 'harness_update_unverified', target: '2.1.230', verified: '2.1.220' });
  });

  test('any other refusal is a 409 carrying its own code', async () => {
    const route = updateStartRoute({
      view: async () => view,
      start: async () => {
        throw new HarnessUpdateRefusal(HARNESS_UPDATE_CODES.inProgress, 'busy');
      },
    });

    const error = await refused(route(call({})));

    expect(error).toMatchObject({ status: 409, code: 'harness_update_in_progress' });
  });

  test('a body that is not an update request is a 400 naming the field, as today', async () => {
    const route = updateStartRoute(accepting([]));

    const error = await refused(route(call({ target: 'not-a-version' })));

    expect(error).toMatchObject({ status: 400, code: 'invalid_request' });
  });

  test('a body that is not JSON is a 400, as today', async () => {
    const route = updateStartRoute(accepting([]));

    const error = await refused(route({ request: { text: async () => 'not json' }, params: new Map() } as never));

    expect(error).toMatchObject({ status: 400, code: 'invalid_json' });
  });

  test('a body over 4 KiB is 413 body_too_large, and an empty one is 400 invalid_json, as today', async () => {
    let started = 0;
    const route = updateStartRoute({
      view: async () => view,
      start: async () => {
        started += 1;
        return view;
      },
    });

    expect(await refused(route(rawCall(JSON.stringify({ target: 'x'.repeat(5 * 1024) }))))).toMatchObject({
      status: 413,
      code: 'body_too_large',
    });
    expect(await refused(route(rawCall('')))).toMatchObject({ status: 400, code: 'invalid_json' });
    expect(started).toBe(0);
  });

  test('G25 a ferret is refused before anything starts', async () => {
    let started = 0;
    const route = updateStartRoute({
      view: async () => view,
      start: async () => {
        started += 1;
        return view;
      },
    });

    const error = await refused(route(call({}, ferretStanding('F1' as never))));

    expect(error).toMatchObject({ status: 403, code: 'forbidden' });
    expect(started).toBe(0);
  });

  test('G25 the demand a governed device is asked for is fleet.configure', async () => {
    const route = updateStartRoute(accepting([]));

    const response = body(await route(call({}, remoteDevice(false).standing())));

    expect([response.status, response.json.demand]).toEqual([403, { capability: 'fleet', axis: 'configure' }]);
  });

  test('G25 a spent passkey proof does not start a second update', async () => {
    let started = 0;
    const route = updateStartRoute({
      view: async () => view,
      start: async () => {
        started += 1;
        return view;
      },
    });
    const phone = remoteDevice(true);

    const first = body(await route(call({}, phone.standing())));
    const second = body(await route(call({}, phone.standing())));

    expect([first.status, second.status, second.json.code, started, phone.state.spent]).toEqual([
      202,
      403,
      'grant_step_up_required',
      1,
      1,
    ]);
  });

  test('G25 the owner at the machine starts an update with no passkey, and nothing is spent', async () => {
    let spent = 0;
    const route = updateStartRoute(accepting([]));

    const response = body(
      await route(
        call(
          {},
          {
            ...ownerStanding(),
            claimFreshStepUp: () => {
              spent += 1;
              return true;
            },
            spendFreshStepUp: () => {
              spent += 1;
            },
          },
        ),
      ),
    );

    expect([response.status, spent]).toEqual([202, 0]);
  });

  test('G25 a refused update has used the proof up, so a retry with the same proof is refused', async () => {
    // Claim-first, no restore (today's claim-first routes): one proof admits one act, and the person confirms again.
    const route = updateStartRoute({
      view: async () => view,
      start: async () => {
        throw new HarnessUpdateRefusal(HARNESS_UPDATE_CODES.inProgress, 'busy');
      },
    });
    const phone = remoteDevice(true);

    const error = await refused(route(call({}, phone.standing())));
    const retry = body(await route(call({}, phone.standing())));

    expect([error.status, phone.state.spent]).toEqual([409, 1]);
    expect([retry.status, retry.json.code]).toEqual([403, 'grant_step_up_required']);
  });

  test('G25 two requests racing on one fresh proof: exactly one update starts, the other is asked again', async () => {
    let started = 0;
    const route = updateStartRoute({
      view: async () => view,
      start: async () => {
        started += 1;
        return view;
      },
    });
    const phone = remoteDevice(true);
    // Both standings are taken before either request runs: each admission saw the proof fresh.
    const [a, b] = [phone.standing(), phone.standing()];

    const answers = (await Promise.all([route(call({}, a)), route(call({}, b))])).map(body);

    expect(answers.map(each => each.status).sort()).toEqual([202, 403]);
    expect(answers.find(each => each.status === 403)?.json.code).toBe('grant_step_up_required');
    expect([started, phone.state.spent]).toEqual([1, 1]);
  });
});
