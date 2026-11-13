import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type ApiResponse, BodyTooLargeError, MAX_REQUEST_BODY_BYTES } from '@ferretry/kernel/contract';
import { deviceStanding, ferretStanding, ownerStanding } from '@ferretry/core-gate/contract/testing';
import {
  HARNESS_UPDATE_CODES,
  PermissionAnswerResultSchema,
  HarnessDialogAnswerResultSchema,
} from '../../contract/index.ts';
import { DialogAnswerService } from '../../daemon/lib/dialog/service.ts';
import type { FormKey } from '@ferretry/core-ferrets/contract';
import { withCursor } from '../support/key-pane.ts';
import { parseHarnessDialog } from '../../daemon/lib/pane/harness-dialog.ts';
import { parsePermissionPrompt } from '../../daemon/lib/pane/permission-prompt.ts';
import { PermissionAnswerService } from '../../daemon/lib/permission/service.ts';
import { dialogRoute, permissionRoute, promptRoute, updateStartRoute } from '../../daemon/lib/routes.ts';
import { HarnessUpdateRefusal } from '../../daemon/lib/update/service.ts';

const fixture = (dir: string, name: string): string =>
  readFileSync(join(import.meta.dir, '../fixtures', dir, `${name}.txt`), 'utf8');
const BASH = fixture('permission-prompts', 'claude-2.1.220-bash');
const WRITE = fixture('permission-prompts', 'claude-2.1.220-write');
const SETTINGS = fixture('harness-dialogs', 'claude-2.1.220-settings-error');
const IDLE = '❯ \n  ? for shortcuts';
const TIMING = { settleReads: 3, settleMs: 1 } as const;
const sleep = async (): Promise<void> => {};

/** A pane that serves frames in order (the last repeats) and records every key pressed. */
class Pane {
  readonly writes: string[] = [];
  captures = 0;
  constructor(private readonly frames: readonly string[]) {}
  async capture(): Promise<string> {
    const frame = this.frames[Math.min(this.captures, this.frames.length - 1)] as string;
    this.captures += 1;
    return frame;
  }
  async key(_ferret: string, key: FormKey): Promise<void> {
    this.writes.push(key);
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

  test('G31 the answer moves the cursor, checks it arrived, presses Enter, and its result never carries the choice', async () => {
    const pane = new Pane([BASH, withCursor(BASH, 2), IDLE]);
    const route = permissionRoute(new PermissionAnswerService(pane, sleep, TIMING));

    const response = body(await route(call({ kind: 'choice', requestId: requestId(BASH), number: 2 })));

    expect(response.status).toBe(200);
    expect(pane.writes).toEqual(['Down', 'Enter']);
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

  test('G31 a prompt whose cursor cannot be read is a 409 permission_cursor_unknown and nothing is typed', async () => {
    const bare = BASH.replace(/^(\s*)❯\s(?=1\.)/mu, '$1  ');
    expect(parsePermissionPrompt(bare)?.selected).toBeUndefined();
    const pane = new Pane([bare]);
    const route = permissionRoute(new PermissionAnswerService(pane, sleep, TIMING));

    const error = await refused(route(call({ kind: 'choice', requestId: requestId(BASH), number: 1 })));

    expect(error).toMatchObject({ status: 409, code: 'permission_cursor_unknown' });
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

    expect(pane.writes).toEqual(['Escape']);
  });

  test('G31 a pane that cannot be read is a 409 console_input_failed, not a crash', async () => {
    const route = permissionRoute(
      new PermissionAnswerService(
        {
          capture: async () => {
            throw new Error('no pane');
          },
          key: async () => {},
        },
        sleep,
        TIMING,
      ),
    );

    const error = await refused(route(call({ kind: 'deny', requestId: '0123456789abcdef' })));

    expect(error).toMatchObject({ status: 409, code: 'console_input_failed' });
  });
});

describe('the ferret id in the path and a pane that fails', () => {
  test('G31 G32 a path with no usable ferret id is a 400 before the body is read or the pane touched', async () => {
    const pane = new Pane([BASH]);
    const permission = permissionRoute(new PermissionAnswerService(pane, sleep, TIMING));
    const dialog = dialogRoute(new DialogAnswerService(pane, sleep, TIMING));
    const answer = { kind: 'deny', requestId: '0123456789abcdef' };

    for (const bad of ['', '..', '%2e%2e', 'a%2Fb', '%E0%A4%A']) {
      const params = new Map([['ferretId', bad]]);
      expect(await refused(permission(call(answer, { params })))).toMatchObject({
        status: 400,
        code: 'invalid_ferret_id',
      });
      expect(await refused(dialog(call({ kind: 'escape', dialogId: '0123456789abcdef' }, { params })))).toMatchObject({
        status: 400,
        code: 'invalid_ferret_id',
      });
    }
    expect(await refused(permission(call(answer, { params: new Map() })))).toMatchObject({ code: 'invalid_ferret_id' });
    expect(pane.captures).toBe(0);
  });

  test('G32 a pane that cannot be read is a 409 console_input_failed for a dialog too, and a pane gone is pane_unknown', async () => {
    const unreadable = dialogRoute(
      new DialogAnswerService(
        {
          capture: async () => {
            throw new Error('no pane');
          },
          key: async () => {},
        },
        sleep,
        TIMING,
      ),
    );
    const unknown = dialogRoute(
      new DialogAnswerService(
        {
          capture: async () => {
            throw Object.assign(new Error('that ferret has no pane'), { name: 'PaneUnknown' });
          },
          key: async () => {},
        },
        sleep,
        TIMING,
      ),
    );
    const escapeInput = { kind: 'escape', dialogId: '0123456789abcdef' };

    expect(await refused(unreadable(call(escapeInput)))).toMatchObject({ status: 409, code: 'console_input_failed' });
    expect(await refused(unknown(call(escapeInput)))).toMatchObject({ status: 409, code: 'pane_unknown' });
  });

  test('G31 a failure that is not an Error is passed up as it came, not dressed as a pane refusal', async () => {
    const route = permissionRoute(
      new PermissionAnswerService(
        {
          capture: async () => {
            throw 'the pane library threw a bare string';
          },
          key: async () => {},
        },
        sleep,
        TIMING,
      ),
    );

    const thrown = await route(call({ kind: 'deny', requestId: '0123456789abcdef' })).then(
      () => undefined,
      (caught: unknown) => caught,
    );

    expect(thrown).toBe('the pane library threw a bare string');
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
    expect(pane.writes).toEqual(['Down', 'Enter']);
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

  test('G32 a dialog whose cursor cannot be read is a 409 dialog_cursor_unknown that says so, and nothing is typed', async () => {
    const bare = SETTINGS.replace('❯ 1. Fix with Claude', '  1. Fix with Claude');
    const pane = new Pane([bare]);
    const route = dialogRoute(new DialogAnswerService(pane, sleep, TIMING));

    const error = await refused(route(call({ kind: 'choice', dialogId: dialogId(SETTINGS), number: 1 })));

    expect(error).toMatchObject({ status: 409, code: 'dialog_cursor_unknown' });
    expect((error as unknown as Error).message).toContain('could not be read safely');
    expect((error as unknown as Error).message).toContain('nothing was sent');
    expect(pane.writes).toEqual([]);
  });

  test('G32 a row the dialog does not list is a 400', async () => {
    const pane = new Pane([SETTINGS]);
    const route = dialogRoute(new DialogAnswerService(pane, sleep, TIMING));

    const error = await refused(route(call({ kind: 'choice', dialogId: dialogId(SETTINGS), number: 8 })));

    expect(error).toMatchObject({ status: 400, code: 'invalid_dialog_choice' });
  });
});

/** The answer routes read their body the way today's `session-permission.ts` / `session-dialog.ts` do: bounded, and
 *  refused with the kernel's own codes. Nothing reaches the pane on a refusal. */
describe.each([
  [
    'G31 the permission answer route',
    (pane: Pane) => permissionRoute(new PermissionAnswerService(pane, sleep, TIMING)),
    { kind: 'deny', requestId: parsePermissionPrompt(BASH)?.id },
    [BASH, IDLE],
  ],
  [
    'G32 the dialog answer route',
    (pane: Pane) => dialogRoute(new DialogAnswerService(pane, sleep, TIMING)),
    { kind: 'escape', dialogId: parseHarnessDialog(SETTINGS)?.id },
    [SETTINGS, IDLE],
  ],
])('%s reads its body as today', (_name, makeRoute, valid, validFrames) => {
  test('a body over the transport bound is 413 body_too_large, read with that bound', async () => {
    const pane = new Pane([BASH]);
    const limits: (number | undefined)[] = [];
    const oversize = {
      request: {
        text: async (limit?: number) => {
          limits.push(limit);
          throw new BodyTooLargeError(limit ?? 0);
        },
      },
      params: new Map([['ferretId', 'f1']]),
    } as never;

    const error = await refused(makeRoute(pane)(oversize));

    expect(error).toMatchObject({ status: 413, code: 'body_too_large' });
    expect(limits).toEqual([MAX_REQUEST_BODY_BYTES]);
    expect(pane.writes).toEqual([]);
  });

  test('an empty body is 400 invalid_json, not an empty object', async () => {
    const pane = new Pane([BASH]);

    const error = await refused(makeRoute(pane)(rawCall('')));

    expect(error).toMatchObject({ status: 400, code: 'invalid_json' });
    expect(pane.writes).toEqual([]);
  });

  test('a body that is not JSON is 400 invalid_json', async () => {
    const pane = new Pane([BASH]);

    const error = await refused(makeRoute(pane)(rawCall('{nope')));

    expect(error).toMatchObject({ status: 400, code: 'invalid_json' });
    expect(pane.writes).toEqual([]);
  });

  test('a body that is not the schema is 400 invalid_request and never echoes its values', async () => {
    const pane = new Pane([BASH]);

    const error = (await refused(
      makeRoute(pane)(rawCall(JSON.stringify({ kind: 'choice', number: 'SECRET-VALUE' }))),
    )) as {
      status: number;
      code?: string;
      message?: string;
    };

    expect(error).toMatchObject({ status: 400, code: 'invalid_request' });
    expect(error.message ?? '').not.toContain('SECRET-VALUE');
    expect(pane.writes).toEqual([]);
  });

  test('a valid body is answered as before', async () => {
    const pane = new Pane(validFrames);

    const response = body(await makeRoute(pane)(rawCall(JSON.stringify(valid))));

    expect(response.status).toBe(200);
    expect(pane.writes).toEqual(['Escape']);
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

describe('the prompt read: what the ferret is stopped on, as Ferrets records and masks it', () => {
  const PROMPT = {
    turnState: 'needs-input',
    prompt: 'Do you want to proceed?',
    permissionRequest: { id: '0123456789abcdef', tool: 'Read' },
  } as const;
  const get = (call_: ReturnType<typeof call>) => call_;

  test('it answers exactly what Ferrets served, for the ferret in the path, and an owner names no caller', async () => {
    const asked: { ferret: string; caller: string | undefined }[] = [];
    const route = promptRoute({
      prompt: async (ferret, caller) => {
        asked.push({ ferret, caller });
        return PROMPT;
      },
    });

    const answer = body(await route(get(call({}, ownerStanding()))));

    expect(answer.status).toBe(200);
    expect(answer.json).toEqual(PROMPT);
    expect(asked).toEqual([{ ferret: 'f1', caller: undefined }]);
  });

  test('a ferret asking passes its own id to Ferrets, so Ferrets’ rule decides what it may read', async () => {
    const asked: (string | undefined)[] = [];
    const route = promptRoute({
      prompt: async (_ferret, caller) => {
        asked.push(caller);
        return {};
      },
    });

    await route(get(call({}, ferretStanding('F1' as never))));

    expect(asked).toEqual(['F1']);
  });

  test('a ferret reading another ferret’s prompt is refused as Ferrets refuses it, and nothing is served', async () => {
    const route = promptRoute({
      prompt: async () => {
        throw Object.assign(new Error('a ferret acts only on itself and its helpers'), {
          status: 403,
          code: 'forbidden',
        });
      },
    });

    const error = await refused(route(get(call({}, ferretStanding('F2' as never)))));

    expect(error).toMatchObject({ status: 403, code: 'forbidden' });
  });

  test('a ferret this daemon does not know is 404, and a pane that records nothing is an empty object', async () => {
    const missing = await refused(promptRoute({ prompt: async () => undefined })(get(call({}, ownerStanding()))));
    const nothing = body(await promptRoute({ prompt: async () => ({}) })(get(call({}, ownerStanding()))));

    expect(missing).toMatchObject({ status: 404, code: 'not_found' });
    expect([nothing.status, nothing.json]).toEqual([200, {}]);
  });

  test('a Ferrets that cannot say answers 503 plugin_unavailable, never an empty prompt', async () => {
    const error = await refused(promptRoute({})(get(call({}, ownerStanding()))));

    expect(error).toMatchObject({ status: 503, code: 'plugin_unavailable' });
  });
});
