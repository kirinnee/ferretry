import { describe, expect, test } from 'bun:test';
import { FakeRedaction } from '@ferretry/core-vault/contract/testing';
import type { SecretName } from '@ferretry/core-vault/contract';
import type { Redaction, RedactionScope } from '@ferretry/kernel/contract';
import { type Duration, milliseconds } from '@ferretry/std';
import type { FerretId, Runner, RunnerHandle, RunnerLook } from '../../../../../contract/index.ts';
import { ferretId } from '../../../../../contract/testing/index.ts';
import {
  LAST_SNAPSHOT_MAX_CHARS,
  LastSnapshotCapture,
  lastSnapshotText,
} from '../../../../../daemon/lib/session/snapshot/index.ts';

const FERRET: FerretId = ferretId('mw7bp88g-50e00159');
const HANDLE = '%7' as RunnerHandle;
/** A value the Vault holds: it must never reach the stored frame, whatever the runner hands over. */
const SECRET = 'sk-fixture-0123456789abcdef';

const masker = (values: readonly string[] = [SECRET]): Pick<Redaction, 'read'> & { reads: number } => {
  const redaction = {
    reads: 0,
    read: async <T>(fn: (scope: RedactionScope) => T | Promise<T>): Promise<T> => {
      redaction.reads += 1;
      const text = (s: string) => values.reduce((out, value) => out.split(value).join('*'.repeat(value.length)), s);
      return await fn({ text, cells: grid => grid, lines: lines => lines.map(text) });
    },
  };
  return redaction;
};

/** A runner whose one look answers `look` (a value, a hang, a throw) and nothing else. */
const runnerLooking = (look: () => Promise<RunnerLook | undefined>): Runner => ({ look }) as unknown as Runner;
const screen = (status: string | undefined): RunnerLook => ({
  frame: 'f',
  working: false,
  atPrompt: true,
  permission: false,
  ...(status === undefined ? {} : { status }),
});

/** A real-time sleep the capture can cancel, standing in for the kernel clock's. */
const sleep = async (delay: Duration, signal?: AbortSignal): Promise<void> =>
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, delay);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new Error('aborted'));
    });
  });

function world(options: { redaction?: Pick<Redaction, 'read'>; failWrite?: boolean; bound?: number } = {}) {
  const written: { ferret: string; text: string }[] = [];
  const logs: { message: string; fields: unknown }[] = [];
  const capture = new LastSnapshotCapture({
    store: id => ({
      write: async (asked, text) => {
        if (options.failWrite === true) throw new Error(`EACCES: open '/home/x/${SECRET}'`);
        written.push({ ferret: `${id}/${asked}`, text });
      },
    }),
    redaction: options.redaction ?? masker(),
    sleep,
    log: { warn: (message, fields) => logs.push({ message, fields }) },
    bound: milliseconds(options.bound ?? 2_000),
  });
  return { capture, written, logs };
}

/** A 40-character token, as an agent's `echo $TOKEN` would print it: long enough to wrap at an 80-column pane's edge. */
const WRAPPED = 'ghp_FAKEWRAPfixtureAAAABBBBCCCCDDDDEEEE';
const WRAP_HEAD = WRAPPED.slice(0, 20);
const WRAP_TAIL = WRAPPED.slice(20);

describe('F-0326 the last screen a stop keeps (last-snapshot.txt)', () => {
  test('F-0326 a value wrapped across two pane rows is masked in both rows before it is written', async () => {
    // capture-pane without -J: the token printed at column 60 of an 80-column row comes back split by a \n.
    const first = `${'x'.repeat(60)}${WRAP_HEAD}`;
    const second = `${WRAP_TAIL} and the rest`;
    const unwrapped = `plain ${WRAPPED}`;
    // The Vault's own conformance fake: `text` masks within a row only, `lines` matches the rows as one run.
    const w = world({ redaction: new FakeRedaction(new Map([['GH_TOKEN' as SecretName, WRAPPED]])) });
    await w.capture.capture(
      FERRET,
      runnerLooking(async () => screen(`${first}\n${second}\n${unwrapped}`)),
      HANDLE,
    );
    const kept = w.written[0]?.text ?? '';
    expect(kept).not.toContain(WRAP_HEAD);
    expect(kept).not.toContain(WRAP_TAIL);
    expect(kept).not.toContain(WRAPPED);
    // Each half is starred in its own row, so the rows keep their place and their width.
    expect(kept.split('\n')).toEqual([
      `${'x'.repeat(60)}${'*'.repeat(WRAP_HEAD.length)}`,
      `${'*'.repeat(WRAP_TAIL.length)} and the rest`,
      'plain [redacted:GH_TOKEN]',
    ]);
  });

  test('F-0326 a value the harness UI broke inside its indent (⎿ then 5 spaces, over 3 rows) or its │ … │ box reaches the file in no row', async () => {
    // Claude Code hard-breaks a word longer than its box and starts each continuation row with the box's indent.
    const long = `FAKEJWTcapture.${'a1B2c3D4e5F6g7H8i9J0'.repeat(10)}`;
    const indented = [`  ⎿  ${long.slice(0, 75)}`, `     ${long.slice(75, 150)}`, `     ${long.slice(150)}`];
    const boxed = [`│ ${WRAPPED.slice(0, 28)} │`, `│ ${WRAPPED.slice(28).padEnd(28)} │`];
    const w = world({
      redaction: new FakeRedaction(
        new Map([
          ['JWT' as SecretName, long],
          ['GH_TOKEN' as SecretName, WRAPPED],
        ]),
      ),
    });
    await w.capture.capture(
      FERRET,
      runnerLooking(async () => screen([...indented, '', ...boxed, '> '].join('\n'))),
      HANDLE,
    );
    const kept = w.written[0]?.text ?? '';
    for (const value of [long, WRAPPED])
      for (let at = 0; at + 8 <= value.length; at += 1) expect(kept).not.toContain(value.slice(at, at + 8));
    expect(kept.split('\n')).toEqual([
      `  ⎿  ${'*'.repeat(75)}`,
      `     ${'*'.repeat(75)}`,
      `     ${'*'.repeat(long.length - 150)}`,
      '',
      `│ ${'*'.repeat(28)} │`,
      `│ ${'*'.repeat(WRAPPED.length - 28).padEnd(28)} │`,
      '> ',
    ]);
  });

  test('F-0326 the screen is masked before anything is written, even when the runner handed it over unmasked', async () => {
    const w = world();
    await w.capture.capture(
      FERRET,
      runnerLooking(async () => screen(`$ export TOKEN=${SECRET}\n> done`)),
      HANDLE,
    );
    expect(w.written).toEqual([
      { ferret: `${FERRET}/${FERRET}`, text: `$ export TOKEN=${'*'.repeat(SECRET.length)}\n> done` },
    ]);
    expect(JSON.stringify(w.written)).not.toContain(SECRET);
  });

  test('F-0326 an oversize screen keeps only its last characters, cut AFTER the mask so no half value survives', async () => {
    const w = world();
    // The value straddles the cut: cutting before masking would leave its second half, which no longer matches.
    const lead = 'x'.repeat(5_000);
    const half = Math.floor(SECRET.length / 2);
    const tail = 'y'.repeat(LAST_SNAPSHOT_MAX_CHARS - (SECRET.length - half));
    await w.capture.capture(
      FERRET,
      runnerLooking(async () => screen(`${lead}${SECRET}${tail}`)),
      HANDLE,
    );
    const kept = w.written[0]?.text ?? '';
    expect(kept.length).toBe(LAST_SNAPSHOT_MAX_CHARS);
    expect(kept.endsWith(tail)).toBe(true);
    expect(kept.startsWith('*'.repeat(SECRET.length - half))).toBe(true);
    expect(kept).not.toContain(SECRET.slice(half));
  });

  test('F-0326 a cut inside a surrogate pair drops the orphaned half', () => {
    const text = `\u{1F600}${'a'.repeat(LAST_SNAPSHOT_MAX_CHARS - 1)}`;
    const kept = lastSnapshotText(text);
    expect(kept).toBe('a'.repeat(LAST_SNAPSHOT_MAX_CHARS - 1));
    expect(lastSnapshotText('short')).toBe('short');
  });

  test('F-0326 a look that hangs is given up after the bound: the capture settles, and nothing is written later', async () => {
    const w = world({ bound: 20 });
    let release: ((look: RunnerLook) => void) | undefined;
    const hanging = new Promise<RunnerLook>(resolve => {
      release = resolve;
    });
    const started = Date.now();
    await w.capture.capture(
      FERRET,
      runnerLooking(async () => await hanging),
      HANDLE,
    );
    expect(Date.now() - started).toBeLessThan(1_000);
    release?.(screen('a late frame'));
    await Bun.sleep(10);
    expect(w.written).toEqual([]);
    expect(w.logs).toEqual([
      { message: "a ferret's last screen was not kept: reading it took too long", fields: { ferret: FERRET } },
    ]);
  });

  test('F-0326 a pane already gone, a runner that cannot look, or a blank screen keeps no file and says nothing', async () => {
    for (const runner of [
      runnerLooking(async () => undefined),
      runnerLooking(async () => screen(undefined)),
      runnerLooking(async () => screen('  \n \n')),
      {} as Runner,
    ]) {
      const w = world();
      await w.capture.capture(FERRET, runner, HANDLE);
      expect(w.written).toEqual([]);
      expect(w.logs).toEqual([]);
    }
  });

  test('F-0326 a look, a masker or a write that fails keeps no file, never rejects, and logs the ferret id only', async () => {
    const refusing: Pick<Redaction, 'read'> = {
      read: async () => {
        throw new Error(`the vault is locked (${SECRET})`);
      },
    };
    const cases = [world({}), world({ redaction: refusing }), world({ failWrite: true })];
    const looks = [
      runnerLooking(async () => {
        throw new Error(`capture-pane failed: ${SECRET}`);
      }),
      runnerLooking(async () => screen(`on screen ${SECRET}`)),
      runnerLooking(async () => screen(`on screen ${SECRET}`)),
    ];
    for (const [index, w] of cases.entries()) {
      await w.capture.capture(FERRET, looks[index] as Runner, HANDLE);
      expect(w.written).toEqual([]);
      expect(w.logs).toEqual([{ message: "a ferret's last screen could not be kept", fields: { ferret: FERRET } }]);
      expect(JSON.stringify(w.logs)).not.toContain(SECRET);
    }
  });

  test('F-0326 an id that is not a session id is never turned into a folder', async () => {
    const w = world();
    await w.capture.capture(
      ferretId('../../etc'),
      runnerLooking(async () => screen('x')),
      HANDLE,
    );
    expect(w.written).toEqual([]);
  });
});
