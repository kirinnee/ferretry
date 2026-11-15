// A ferret whose v4 harness is still in its pane at the switch (M3): v5 must see it idle when it is, and must restart it
// as a v5 harness at that idle moment. Proof run 6 (R6-9 check 1) found neither: `fy ps` said `working` for an idle
// harness, and nothing ever queued the restart, so the harness kept writing into a v4 config folder the new home lacks.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { FerretRecordSchema, RestartQueueEntrySchema } from '@ferretry/core-ferrets/contract';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { liveState, queuedRestarts, ferretsStep } from '../../src/steps/ferrets.ts';
import { fixture } from './ferret-fixture.ts';

let f: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => {
  f = await fixture();
});
afterEach(async () => {
  await f.clean();
});
const record = async (id: string) =>
  FerretRecordSchema.parse(JSON.parse(await readFile(join(f.to, 'state/ferrets', id, 'ferret.json'), 'utf8')));
const restarts = async (): Promise<Record<string, unknown> | undefined> => {
  const text = await readFile(join(f.to, 'state/ferrets/restarts.json'), 'utf8').catch(() => undefined);
  return text === undefined ? undefined : (JSON.parse(text) as Record<string, unknown>);
};

test('a v4 `running` ferret whose recorded turn is your-turn is converted idle, so the turn watch agrees with it', async () => {
  // v5's turn watch moves the registry only when it WRITES a turn change: an idle pane matches the carried `your-turn`,
  // so a record left `working` here stayed `working` for good (R6: joslin, status running, turnState your-turn).
  await f.session('idle1');
  await f.put('state/sessions/idle1/state.json', { id: 'idle1', turn: 0, status: 'running', turnState: 'your-turn' });
  await f.pane('idle1');
  await f.session('ask1');
  await f.put('state/sessions/ask1/state.json', { id: 'ask1', turn: 0, status: 'running', turnState: 'needs-input' });
  await f.pane('ask1');
  await f.session('busy1');
  await f.put('state/sessions/busy1/state.json', {
    id: 'busy1',
    turn: 0,
    status: 'awaiting_user',
    turnState: 'working',
  });
  await f.pane('busy1');
  expect((await ferretsStep.run(f.ctx())).status).toBe('converted');
  expect((await record('idle1')).state).toBe('idle');
  expect((await record('ask1')).state).toBe('idle');
  // The recorded turn wins over the coarser v4 status in both directions: it is what the carried state.json says.
  expect((await record('busy1')).state).toBe('working');
});

test('with no recorded turn the v4 status decides, as before', () => {
  expect(liveState({ status: 'running' })).toBe('working');
  expect(liveState({ status: 'awaiting_user' })).toBe('idle');
  expect(liveState({ status: 'starting', turnState: 'your-turn' })).toBe('starting');
  expect(liveState(undefined)).toBe('working');
});

test('every ferret still in its v4 pane is queued for a v5 restart; stopped and paneless ones are not', async () => {
  await f.session('live1');
  await f.put('state/sessions/live1/state.json', { id: 'live1', turn: 0, status: 'running', turnState: 'your-turn' });
  await f.pane('live1');
  await f.session('busy1');
  await f.put('state/sessions/busy1/state.json', { id: 'busy1', turn: 0, status: 'thinking', turnState: 'working' });
  await f.pane('busy1');
  await f.session('gone1');
  await f.put('state/sessions/gone1/state.json', { id: 'gone1', turn: 0, status: 'running' });
  await f.session('done1');
  await f.put('state/sessions/done1/state.json', { id: 'done1', turn: 0, status: 'completed' });
  await f.pane('done1');
  expect((await ferretsStep.run(f.ctx())).status).toBe('converted');
  const document = await restarts();
  expect(document).toBeDefined();
  // The kernel's own stamp comes first, and the body is exactly what the daemon's queue reader parses.
  expect(Object.keys(document ?? {})).toEqual(['format', 'queued']);
  expect(document?.format).toBe(1);
  const queued = (document?.queued as unknown[]).map(entry => RestartQueueEntrySchema.parse(entry));
  expect(queued.map(entry => entry.id).sort()).toEqual(['busy1', 'live1']);
  for (const entry of queued) {
    // Not tied to the out-of-date check, and the daemon's own recovery: it never runs as an agent (which fails closed).
    expect(entry).toMatchObject({ reason: 'mid-turn', onlyIfOutdated: false, requestedBy: 'owner' });
    expect(entry.origin).toEqual({ kind: 'daemon' });
  }
});

test('a home with no ferret left in a pane gets no restart queue', async () => {
  await f.session('done1');
  await f.put('state/sessions/done1/state.json', { id: 'done1', turn: 0, status: 'completed' });
  expect((await ferretsStep.run(f.ctx())).status).toBe('converted');
  expect(await restarts()).toBeUndefined();
});

test('a dry run writes no restart queue', async () => {
  await f.session('live1');
  await f.put('state/sessions/live1/state.json', { id: 'live1', turn: 0, status: 'running' });
  await f.pane('live1');
  expect((await ferretsStep.run(f.ctx(true))).status).toBe('converted');
  expect(await restarts()).toBeUndefined();
});

test('queuedRestarts names each queued ferret by id and callsign', () => {
  const at = '2026-11-14T00:00:00.000Z';
  expect(
    queuedRestarts(
      [
        { id: 'a', name: 'joslin', state: 'idle', handle: '%62' },
        { id: 'b', name: 'b', state: 'stopped', handle: '%1' },
        { id: 'c', name: 'c', state: 'working' },
      ],
      at,
    ).map(entry => [entry.id, entry.name, entry.since]),
  ).toEqual([['a', 'joslin', at]]);
});
