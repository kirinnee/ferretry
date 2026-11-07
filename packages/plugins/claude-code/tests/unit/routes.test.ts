import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ApiResponse } from '@ferretry/kernel/contract';
import { HARNESS_UPDATE_CODES, PermissionAnswerResultSchema, HarnessDialogAnswerResultSchema } from '../../contract/index.ts';
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

const call = (body: unknown, extra: Record<string, unknown> = {}) =>
  ({
    request: { text: async () => JSON.stringify(body) },
    params: new Map([['ferretId', 'f1']]),
    ...extra,
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
    const route = updateStartRoute({ view: async () => view, start: async () => { started += 1; return view; } });

    const response = body(await route(call({}, { governance: { governed: true }, presentation: {} })));

    expect(response.status).toBe(403);
    expect(response.json.code).toBe('grant_step_up_required');
    expect(started).toBe(0);
  });

  test('G25 the passkey proof is spent once the update was accepted, and the answer is 202', async () => {
    const spent: string[] = [];
    const route = updateStartRoute(accepting(spent));

    const response = body(
      await route(
        call(
          {},
          {
            governance: { governed: true },
            presentation: { freshStepUp: true },
            spendFreshStepUp: () => spent.push('spent'),
          },
        ),
      ),
    );

    expect(response.status).toBe(202);
    expect(spent).toEqual(['spent']);
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

  test('a body that is not an update request is a 400', async () => {
    const route = updateStartRoute(accepting([]));

    const error = await refused(route(call({ target: 'not-a-version' })));

    expect(error).toMatchObject({ status: 400, code: 'invalid_body' });
  });
});
