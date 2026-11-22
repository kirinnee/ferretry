/**
 * What the apply route logs when an apply is refused or not fully applied (C59 O5-10b R1 item 5): a change id only when
 * the daemon minted it, the kind the service resolved, and a FIXED code. Never a path segment, an error's name or a sentence.
 */
import { describe, expect, test } from 'bun:test';
import { ownerStanding } from '@ferretry/core-gate/contract/testing';
import { ApiError, type CallContext, jsonResponse, type Log } from '@ferretry/kernel/contract';
import { applyAsOneAct } from '../../../daemon/routes/apply-act.ts';

const MINTED = `fy_fprop_${'a'.repeat(22)}`;

function recorder(): { readonly log: Log; readonly lines: { message: string; fields: unknown }[] } {
  const lines: { message: string; fields: unknown }[] = [];
  const log = {
    debug() {},
    info() {},
    error() {},
    child: () => log,
    warn: (message: string, fields?: unknown) => {
      lines.push({ message, fields });
    },
  } as unknown as Log;
  return { log, lines };
}

const callOf = (signal?: AbortSignal): CallContext =>
  ({
    request: signal === undefined ? {} : { signal },
    params: new Map(),
    ...ownerStanding(),
  }) as unknown as CallContext;

const fields = (lines: readonly { fields: unknown }[]) => lines.map(line => line.fields);

describe('apply-act log lines', () => {
  test('an id this daemon did not mint is logged as `unrecognised`, never as the path segment', async () => {
    const { log, lines } = recorder();
    const failure = new ApiError(404, 'no such change', 'fleet_change_unknown');

    await expect(
      applyAsOneAct({
        call: callOf(),
        id: '../../etc/passwd secret-looking',
        log,
        answered: () => undefined,
        work: async () => {
          throw failure;
        },
      }),
    ).rejects.toBe(failure);

    expect(fields(lines)).toEqual([
      { change: 'unrecognised', kind: 'unknown', status: 404, code: 'fleet_change_unknown' },
    ]);
  });

  test("an error that is not the daemon's own is the fixed code `error`: its name and message are never logged", async () => {
    const { log, lines } = recorder();
    const strange = Object.assign(new Error('a sentence with /home/someone/secret'), { name: 'SensitiveErrorName' });

    await expect(
      applyAsOneAct({
        call: callOf(),
        id: MINTED,
        log,
        answered: () => undefined,
        work: async () => {
          throw strange;
        },
      }),
    ).rejects.toBe(strange);

    expect(fields(lines)).toEqual([{ change: MINTED, kind: 'unknown', status: 500, code: 'error' }]);
    expect(JSON.stringify(lines)).not.toContain('SensitiveErrorName');
    expect(JSON.stringify(lines)).not.toContain('secret');
  });

  test('what an executor reports held and refused behind a 200 is one line per state, from structured state', async () => {
    const { log, lines } = recorder();

    await applyAsOneAct({
      call: callOf(),
      id: MINTED,
      log,
      answered: () => undefined,
      work: async bracket => {
        bracket.left?.('held', 'setup.import');
        bracket.left?.('refused', 'setup.import');
        bracket.left?.('held', 'setup.import');
        return jsonResponse({ ok: true });
      },
    });

    expect(fields(lines)).toEqual([
      { change: MINTED, kind: 'setup.import', status: 200, code: 'held' },
      { change: MINTED, kind: 'setup.import', status: 200, code: 'refused' },
    ]);
  });

  test('a clean apply, and a kind that is no act, say nothing and open no act', async () => {
    const { log, lines } = recorder();

    await applyAsOneAct({
      call: callOf(),
      id: MINTED,
      log,
      answered: () => undefined,
      work: async bracket => {
        expect(bracket.open?.('machine.settings')).toBeUndefined();
        expect(bracket.open?.('setup.import')?.covered).toBe(false);
        return jsonResponse({ ok: true });
      },
    });

    expect(lines).toEqual([]);
  });

  test("the request's own signal is handed to the service", async () => {
    const { log } = recorder();
    const controller = new AbortController();

    await applyAsOneAct({
      call: callOf(controller.signal),
      id: MINTED,
      log,
      answered: () => undefined,
      work: async bracket => {
        expect(bracket.signal).toBe(controller.signal);
        return jsonResponse({ ok: true });
      },
    });
  });
});
