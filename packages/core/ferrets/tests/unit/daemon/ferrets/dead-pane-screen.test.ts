import { expect, test } from 'bun:test';
import type { RedactionScope } from '@ferretry/kernel/contract';
import { milliseconds } from '@ferretry/std';
import {
  PERSON_ORIGIN,
  type FerretChangedPayload,
  type FerretRecord,
  type RunnerHandle,
} from '../../../../contract/index.ts';
import { ferretId } from '../../../../contract/testing/index.ts';
import { LastSnapshotCapture, LastSnapshotReading } from '../../../../daemon/lib/session/snapshot/index.ts';
import { additivesFixture } from './additives-fixture.ts';

/** A value a tool printed: it was NOT in the Vault when the pane died, and is added to it afterwards. */
const TOKEN = 'sk-late-vault-value-0123456789';
const SCREEN = `building\nERROR token ${TOKEN}\nKilled`;

/** The stored file, in memory: what was written when the frame was kept. */
function world() {
  let stored: string | undefined;
  let vault: readonly string[] = [];
  const redaction = {
    read: async <T>(fn: (scope: RedactionScope) => T | Promise<T>): Promise<T> => {
      const text = (value: string): string => vault.reduce((mask, secret) => mask.split(secret).join('*****'), value);
      return await fn({ text, cells: grid => grid, lines: lines => lines.map(text) });
    },
  };
  const capture = new LastSnapshotCapture({
    store: () => ({
      write: async (_id, text) => {
        stored = text;
      },
    }),
    redaction,
    sleep: async () => await new Promise<void>(() => {}),
    log: { warn: () => {} },
    bound: milliseconds(1_000),
  });
  const reading = new LastSnapshotReading({
    store: () => ({
      read: async () => (stored === undefined ? { kind: 'absent' as const } : { kind: 'read' as const, text: stored }),
    }),
    redaction,
  });
  const changes: FerretChangedPayload[] = [];
  const f = additivesFixture({
    lastSnapshot: async (ferret, runner, handle, deadPane) => await capture.capture(ferret, runner, handle, deadPane),
    storedLastSnapshot: async ferret => await reading.read(ferret),
    changed: payload => changes.push(payload),
  });
  return {
    f,
    changes,
    stored: () => stored,
    addToVault: (value: string) => {
      vault = [...vault, value];
    },
  };
}

async function ended(how: { status?: number; signal?: number }) {
  const w = world();
  await w.f.service.resume(w.f.id, undefined, { origin: PERSON_ORIGIN });
  const handle = w.f.registry.get(w.f.id)?.handle as RunnerHandle;
  w.f.runner.die(handle, how, SCREEN);
  const settled = await w.f.service.settleExited(w.f.id, handle, how, 'running', async () => true);
  expect(settled).toBe(true);
  return w;
}

test("a dead pane's screen is on NO surface every caller reads: not the cause, the journal, list(), get() or an event", async () => {
  for (const how of [{ signal: 9 }, { status: 3 }, { status: 0 }, {}]) {
    const w = await ended(how);
    const surfaces = JSON.stringify({
      record: w.f.registry.get(w.f.id),
      listed: await w.f.service.list(),
      got: await w.f.service.get(w.f.id),
      journal: w.f.history,
      events: w.changes,
    });
    expect(surfaces).not.toContain(TOKEN);
    expect(surfaces).not.toContain('building');
    expect(surfaces).not.toContain('lastLines');
    expect(surfaces).not.toContain('last words');
  }
});

test('the cause keeps only the signal or the exit status, and the journal the same', async () => {
  const w = await ended({ signal: 9 });
  expect(w.f.registry.get(w.f.id)?.cause).toEqual({ kind: 'signal', signal: 9 });
  expect(w.f.history.at(-1)?.data).toMatchObject({ pane: 'dead', exitCode: null, signal: 9 });
  expect(String(w.f.history.at(-1)?.data.reason)).toBe('the agent was ended by signal 9');
});

test('the screen is kept as the stored last screen, and read back only through the gated, re-masked lastSnapshot', async () => {
  const w = await ended({ signal: 9 });
  // Kept (the capture masks with the Vault as it was: the token was not in it).
  expect(w.stored()).toContain('Killed');
  // The Vault learns the value after the crash: the read masks it AGAIN, the file is never handed out as it is.
  w.addToVault(TOKEN);
  const read = await w.f.service.lastSnapshot(w.f.id);
  expect(read).toContain('Killed');
  expect(read).not.toContain(TOKEN);
  expect(read).toContain('*****');
  // The gate: a ferret that may not touch it is refused before the file is read.
  const stranger = ferretId('stranger');
  w.f.registry.put({ ...(w.f.registry.get(w.f.id) as FerretRecord), id: stranger, name: 'stranger' });
  await expect(w.f.service.lastSnapshot(w.f.id, stranger)).rejects.toMatchObject({ status: 403 });
  expect(await w.f.service.lastSnapshot(w.f.id, w.f.id)).toBe(read);
});

test('a dead pane is read through the dead-pane screen only, never a look, and a pane that is not provably dead keeps nothing', async () => {
  const w = world();
  await w.f.service.resume(w.f.id, undefined, { origin: PERSON_ORIGIN });
  const handle = w.f.registry.get(w.f.id)?.handle as RunnerHandle;
  // A live pane answers no dead screen: nothing is kept, and the settle still lands.
  w.f.runner.deadScreens.set(handle, SCREEN);
  expect(await w.f.service.settleExited(w.f.id, handle, { signal: 9 }, 'running', async () => true)).toBe(true);
  expect(w.stored()).toBeUndefined();
  expect(w.f.runner.looked).not.toContain(handle);
});
