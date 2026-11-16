/**
 * Kernel batch item #6: `kernel.config-changed` on `GET /v1/bus`. The real host publishes one frame per declared file
 * that moved (its plugin, path, state and disk etag — never text), and shows a frame only to a caller
 * `GET /v1/config/file` would let READ that file: Gate admits the caller for that route's descriptor, then Gate's
 * per-file judge (`judgeConfigAccess`, act `read`) admits it for that file. No plugin hears the event in-process.
 */
import { afterAll, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import { AdmissionPort, type Admission, type ConfigAccessJudgement } from '../../../contract/bound.ts';
import { defineConfig, defineEvent } from '../../../contract/define.ts';
import { ConfigChanged } from '../../../contract/kernel.ts';
import type { ConfigPort } from '../../../contract/ports.ts';
import type { SocketDownstream } from '../../../contract/socket.ts';
import { configFrameShown } from '../../../host/config/bus-frame.ts';
import { bootHost } from '../../../host/host.ts';
import type { LogRecord } from '../../../host/log.ts';
import { realAdapters } from '../../../host/wiring.ts';
import { definePlugin, implementDaemon } from '../../../manifest/index.ts';
import kernelManifest from '../../../plugin.ts';
import { fixedClock } from '../../../testing/clock.ts';
import { recordingAdmission, request } from './fixtures.ts';

const roots: string[] = [];
afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

/** A marker in the file's text that must never reach a frame (a raw credential would be refused on write). */
const PLANTED = 'PLANTED-marker-7f3a-in-the-text';

const limitsDef = defineConfig({
  file: 'limits.yaml',
  schema: z.strictObject({ limit: z.number().int().default(10), note: z.string().optional() }),
  axis: 'configure',
  loosens: (before, after) => (after.limit > (before?.limit ?? 10) ? ['raises the limit'] : []),
});
const Moved = defineEvent('board.card-moved', z.strictObject({ card: z.string() }));

const gate = definePlugin({
  id: 'gate',
  title: 'Gate',
  version: '5.0.0',
  api: 5,
  core: true,
  kinds: [],
  provides: { admission: AdmissionPort },
});
const board = definePlugin({
  id: 'board',
  title: 'Board',
  version: '5.0.0',
  api: 5,
  core: false,
  kinds: [],
  data: { publishes: [Moved], config: [limitsDef] },
});
// A plugin that asks to hear every plugin's config moves in-process: it is never told.
const snoop = definePlugin({
  id: 'snoop',
  title: 'Snoop',
  version: '5.0.0',
  api: 5,
  core: false,
  kinds: [],
  data: { subscribes: [ConfigChanged] },
});

function downstream() {
  const sent: { frame: string; permit: (() => boolean) | undefined }[] = [];
  const port: SocketDownstream = {
    send: (frame, permit) => {
      sent.push({ frame: String(frame), permit });
      return String(frame).length;
    },
    close: () => {},
    bufferedBytes: () => 0,
  };
  return { port, sent };
}

interface Rules {
  /** Whether Gate admits the caller for `GET /v1/config/file`'s own descriptor. */
  fileRoute: boolean;
  /** Gate's per-file judge; `undefined` leaves the judge out. */
  judge: ((input: ConfigAccessJudgement) => boolean) | undefined;
}

async function boot(rules: Rules) {
  const root = await mkdtemp(`${tmpdir()}/config-changed-bus-`);
  roots.push(root);
  const home = `${root}/home`;
  const base = recordingAdmission();
  const judged: ConfigAccessJudgement[] = [];
  const admission: Admission = {
    ...base,
    admit: input =>
      input.descriptor.path === '/v1/config/file' && !rules.fileRoute
        ? {
            outcome: 'refused',
            response: { status: 403, headers: new Map(), body: '{"error":"no","code":"forbidden"}' },
          }
        : base.admit(input),
    ...(rules.judge === undefined
      ? {}
      : {
          judgeConfigAccess: (input: ConfigAccessJudgement) => {
            judged.push(input);
            return (rules.judge as (input: ConfigAccessJudgement) => boolean)(input)
              ? { allowed: true as const }
              : {
                  allowed: false as const,
                  response: { status: 403, headers: new Map(), body: '{"error":"no","code":"forbidden"}' },
                };
          },
        }),
  };
  const records: LogRecord[] = [];
  let config: ConfigPort | undefined;
  let publish: ((card: string) => void) | undefined;
  const heard: unknown[] = [];
  const outcome = await bootHost({
    home,
    version: '5.0.0',
    adapters: {
      ...realAdapters(home, record => void records.push(record), { binary: 'fy' }),
      clock: fixedClock(),
      homeLock: async () => ({ release: async () => {} }),
    },
    implementations: [
      implementDaemon(gate, { build: () => ({ provides: { admission } }) }),
      implementDaemon(board, {
        build: ({ kernel }) => {
          config = kernel.config;
          publish = card => kernel.events.publish(Moved, { card });
          return {};
        },
      }),
      implementDaemon(snoop, {
        build: () => ({ subscribers: { [ConfigChanged.name]: (payload: unknown) => void heard.push(payload) } }),
      }),
    ],
  });
  if (outcome.kind !== 'running') throw new Error(outcome.sentence);
  if (config === undefined || publish === undefined) throw new Error('board was not built');
  const decision = await outcome.host.dispatcher.upgrade(request('GET', '/v1/bus'));
  if (decision.outcome !== 'accepted') throw new Error(`upgrade ${decision.outcome}`);
  const feed = downstream();
  const handler = await decision.attach(feed.port);
  await handler.open();
  return {
    host: outcome.host,
    home,
    config,
    publish,
    feed,
    judged,
    asked: base.asked,
    heard,
    records,
    frames: () => feed.sent.map(entry => JSON.parse(entry.frame) as { name: string; payload: unknown }),
  };
}

const flush = async (): Promise<void> => {
  await Bun.sleep(5);
};

test('a moved file is one kernel.config-changed frame: plugin, path, state and the etag the write answered', async () => {
  const booted = await boot({ fileRoute: true, judge: () => true });
  try {
    const written = await booted.config.write(limitsDef, undefined, 'limit: 5\n');
    if (written.kind !== 'written') throw new Error(written.kind);
    const held = await booted.config.write(limitsDef, undefined, 'limit: 50\n');
    if (held.kind !== 'held') throw new Error(held.kind);
    await flush();
    expect(booted.frames()).toEqual([
      {
        name: 'kernel.config-changed',
        payload: { plugin: 'board', path: 'limits.yaml', state: 'valid', etag: written.etag },
      },
      {
        name: 'kernel.config-changed',
        payload: { plugin: 'board', path: 'limits.yaml', state: 'held', etag: held.etag },
      },
    ]);
    // asked as GET /v1/config/file is: that route's descriptor, then the per-file read judge with admit's actor
    expect(booted.asked).toContain('route GET /v1/config/file');
    expect(booted.judged[0]).toMatchObject({ plugin: 'board', path: 'limits.yaml', act: 'read', actor: 'owner-tools' });
  } finally {
    await booted.host.stop();
  }
});

test("no frame carries the file's text: a planted marker in a note never reaches the bus", async () => {
  const booted = await boot({ fileRoute: true, judge: () => true });
  try {
    expect((await booted.config.write(limitsDef, undefined, `limit: 5\nnote: ${PLANTED}\n`)).kind).toBe('written');
    expect((await booted.config.write(limitsDef, undefined, { patch: { limit: 4 } })).kind).toBe('written');
    // the patch kept the note: the text on disk holds the planted value, the frames do not
    expect(await Bun.file(`${booted.home}/config/limits.yaml`).text()).toContain(PLANTED);
    await flush();
    expect(booted.frames()).toHaveLength(2);
    for (const frame of booted.frames())
      expect(Object.keys(frame.payload as object).toSorted()).toEqual(['etag', 'path', 'plugin', 'state']);
    expect(booted.feed.sent.some(entry => entry.frame.includes('PLANTED'))).toBe(false);
  } finally {
    await booted.host.stop();
  }
});

test('a caller the per-file read judge refuses gets no config frame, and still gets every other event', async () => {
  const booted = await boot({ fileRoute: true, judge: input => input.path !== 'limits.yaml' });
  try {
    await booted.config.write(limitsDef, undefined, 'limit: 5\n');
    booted.publish('F1');
    await flush();
    expect(booted.frames()).toEqual([{ name: 'board.card-moved', payload: { card: 'F1' } }]);
  } finally {
    await booted.host.stop();
  }
});

test('a caller Gate does not admit for GET /v1/config/file gets no config frame, and the file judge is not asked', async () => {
  const booted = await boot({ fileRoute: false, judge: () => true });
  try {
    await booted.config.write(limitsDef, undefined, 'limit: 5\n');
    await flush();
    expect(booted.frames()).toEqual([]);
    expect(booted.judged).toEqual([]);
  } finally {
    await booted.host.stop();
  }
});

test('with no per-file judge, or one that throws, the frame is not shown (a live feed fails closed)', async () => {
  for (const judge of [
    undefined,
    () => {
      throw new Error('judge broke');
    },
  ]) {
    const booted = await boot({ fileRoute: true, judge });
    try {
      await booted.config.write(limitsDef, undefined, 'limit: 5\n');
      await flush();
      expect(booted.frames()).toEqual([]);
    } finally {
      await booted.host.stop();
    }
  }
});

test('the pre-write permit asks the frame again: a caller whose read is taken away gets nothing', async () => {
  let allowed = true;
  const booted = await boot({ fileRoute: true, judge: () => allowed });
  try {
    await booted.config.write(limitsDef, undefined, 'limit: 5\n');
    await flush();
    expect(booted.feed.sent).toHaveLength(1);
    expect(booted.feed.sent[0]?.permit?.()).toBe(true);
    allowed = false;
    expect(booted.feed.sent[0]?.permit?.()).toBe(false);
  } finally {
    await booted.host.stop();
  }
});

test('a plugin that subscribes to kernel.config-changed in-process is never told, and the log says so', async () => {
  const booted = await boot({ fileRoute: true, judge: () => true });
  try {
    await booted.config.write(limitsDef, undefined, 'limit: 5\n');
    await flush();
    expect(booted.frames()).toHaveLength(1);
    expect(booted.heard).toEqual([]);
    expect(
      booted.records.some(
        record => record.message.includes('only the bus carries') && JSON.stringify(record).includes('snoop'),
      ),
    ).toBe(true);
  } finally {
    await booted.host.stop();
  }
});

// The frame rule on its own (`host/config/bus-frame.ts`): the branches a booted host cannot reach, because without Gate
// the bus itself refuses an authenticated socket.
const FILE_READ = kernelManifest.actions?.routes?.find(declared => declared.key === 'GET /v1/config/file');
const FRAME = { plugin: 'board', path: 'limits.yaml', state: 'valid', etag: 'e1' };

test('the frame rule: no Gate bound shows nothing', () => {
  if (FILE_READ === undefined) throw new Error('no GET /v1/config/file');
  expect(configFrameShown(undefined, request('GET', '/v1/bus'), FRAME, FILE_READ)).toBe(false);
});

test("the frame rule: a payload that is not the event's own shape shows nothing, and Gate is not asked", () => {
  if (FILE_READ === undefined) throw new Error('no GET /v1/config/file');
  const admission = { ...recordingAdmission(), judgeConfigAccess: () => ({ allowed: true as const }) };
  for (const payload of [undefined, {}, { ...FRAME, text: PLANTED }, { ...FRAME, state: 'pending' }])
    expect(configFrameShown(admission, request('GET', '/v1/bus'), payload, FILE_READ)).toBe(false);
  expect(admission.asked).toEqual([]);
  expect(configFrameShown(admission, request('GET', '/v1/bus'), FRAME, FILE_READ)).toBe(true);
});
