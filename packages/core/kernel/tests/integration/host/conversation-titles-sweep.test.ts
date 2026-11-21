import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { FakeAsks } from '../../../../asks/contract/testing/index.ts';
import { Harnesses, Runners } from '../../../../ferrets/contract/index.ts';
import type { HarnessHistoryFiles, HarnessHistorySource } from '../../../../ferrets/contract/index.ts';
import { FakeHarness, FakeRunner } from '../../../../ferrets/contract/testing/index.ts';
import { FakeGate, ownerStanding, StandInAdmission } from '../../../../gate/contract/testing/index.ts';
import { FakeVault } from '../../../../vault/contract/testing/index.ts';
import { definePlugin, implementDaemon } from '../../../manifest/index.ts';
import { daemonImplementations } from '../../../src/generated/plugins.ts';
import { type TestHost, testHost } from '../../../testing/index.ts';

/**
 * r11 S11: a title Claude Code writes AFTER the first exchange reaches the ferret (what the drawer reads), through the daemon's
 * own wiring and nothing else. The REAL Ferrets and the REAL Conversation halves (as the generated registry builds them) meet
 * on the harness's history source: a fake Claude transcript the test appends to. The clock is driven, so the 5 s title sweep
 * (`startTitleSweep`, started by `buildReading`) fires when the test winds it; nothing asks the index in between (no listing,
 * no search, no refresh). Pinned: (1) a late `ai-title` reaches the ferret's stored title within the sweep, recorded `auto`;
 * (2) an owner's Rename survives a later `ai-title`; (3) a ferret the CLI never titled keeps the title made from its first
 * exchange. Take `startTitleSweep` or `titleOffer` out of `daemon/reading.ts` and (1) fails.
 *
 * CI only (integration tier). Fixture values only.
 */

const real = (id: string) => {
  const found = daemonImplementations.find(implementation => implementation.manifest.id === id);
  if (found === undefined) throw new Error(`the generated registry has no ${id} half`);
  return found;
};

const encoder = new TextEncoder();

/** A history tree the test writes to: a file is its bytes and a modification time that moves on every write. */
class Tree implements HarnessHistoryFiles {
  readonly files = new Map<string, { bytes: Uint8Array; modifiedMs: number }>();
  #clock = 1_770_000_000_000;
  put(path: string, text: string): void {
    this.#clock += 1_000;
    const held = this.files.get(path)?.bytes ?? new Uint8Array();
    const added = encoder.encode(text);
    const bytes = new Uint8Array(held.length + added.length);
    bytes.set(held);
    bytes.set(added, held.length);
    this.files.set(path, { bytes, modifiedMs: this.#clock });
  }
  /** What the daemon asked of the tree: each directory listed and each file opened (the sweep's own I/O, counted). */
  readonly listed: string[] = [];
  readonly opened: string[] = [];
  async entries(directory: string) {
    this.listed.push(directory);
    const prefix = directory === '' ? '' : `${directory}/`;
    const seen = new Map<string, { kind: 'file' | 'directory'; size: number; modifiedMs: number }>();
    for (const [path, file] of this.files) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      seen.set(
        rest.split('/')[0] as string,
        rest.includes('/')
          ? { kind: 'directory', size: 0, modifiedMs: file.modifiedMs }
          : { kind: 'file', size: file.bytes.length, modifiedMs: file.modifiedMs },
      );
    }
    return [...seen].map(([name, entry]) => ({ name, ...entry }));
  }
  async stat(path: string) {
    const file = this.files.get(path);
    return file === undefined ? undefined : { size: file.bytes.length, modifiedMs: file.modifiedMs };
  }
  async read(path: string, offset: number, length: number) {
    this.opened.push(path);
    return this.files.get(path)?.bytes.slice(offset, offset + length);
  }
}

/** The fake Claude Code: the real contract's fake, plus the owner's history it hands over (as the real plugin does). */
class HistoryHarness extends FakeHarness {
  constructor(readonly tree: Tree) {
    super();
  }
  async historySources(): Promise<readonly HarnessHistorySource[]> {
    return [{ kind: 'computer', label: 'owner', files: this.tree }];
  }
}

const harnessPlugin = (harness: FakeHarness) =>
  implementDaemon(
    definePlugin({
      id: 'claude-code',
      title: 'Claude Code (fake)',
      version: '5.0.0',
      api: 5,
      core: false,
      kinds: [],
      hooks: { takes: [{ hook: Harnesses, key: 'claude-code' }] },
    }),
    { build: () => ({ hooks: { 'harnesses:claude-code': harness } }) },
  );
const runnerPlugin = (runner: FakeRunner) =>
  implementDaemon(
    definePlugin({
      id: 'terminals',
      title: 'Terminals (fake)',
      version: '5.0.0',
      api: 5,
      core: false,
      kinds: [],
      hooks: { takes: [{ hook: Runners, key: 'tmux' }] },
    }),
    { build: () => ({ hooks: { 'runners:tmux': runner } }) },
  );

const AT = '2026-11-14T09:30:00.000Z';
const FIRST = 'can you look at why the deploy script fails on mac?';
const LATE = 'Fix flaky deploy script';
const NEWER = 'Rewrite the release notes';
const OWNERS = 'Ship The Deploy Fix';

const record = (value: Record<string, unknown>) => `${JSON.stringify(value)}\n`;
const exchange = (): string =>
  record({ type: 'user', cwd: '/work/a', timestamp: AT, message: { role: 'user', content: FIRST } }) +
  record({ type: 'assistant', cwd: '/work/a', timestamp: AT, message: { role: 'assistant', content: 'looking' } });

interface World {
  readonly h: TestHost;
  readonly tree: Tree;
  readonly id: string;
  readonly transcript: string;
  /** The title and who chose it, as the drawer's own read of the ferret gives them. */
  readonly shown: () => Promise<{ title?: string; titleSource?: string }>;
}

async function boot(): Promise<World> {
  const tree = new Tree();
  const h = await testHost({
    plugins: [
      real('ferrets'),
      real('mailbox'),
      real('conversation'),
      real('agenda'),
      harnessPlugin(new HistoryHarness(tree)),
      runnerPlugin(new FakeRunner()),
    ],
    gate: new StandInAdmission(() => ownerStanding()),
    fakes: { gate: new FakeGate(), vault: new FakeVault(), asks: new FakeAsks() },
    everyDirectory: true,
  });
  const started = await h.request('POST', '/v1/ferrets', {
    headers: { 'x-fy-request-id': randomUUID() },
    body: { folder: '/work/a', prompt: 'Deploy.' },
  });
  expect(started.status).toBe(201);
  const id = started.json<{ id: string }>().id;
  await h.settle();
  const conversation = (await h.request('GET', `/v1/ferrets/${id}`)).json<{ harnessConversation?: string }>()
    .harnessConversation;
  expect(conversation, 'the started ferret runs a conversation').toBeDefined();
  const transcript = `projects/-work-a/${conversation as string}.jsonl`;
  tree.put(transcript, exchange());
  const shown = async () => {
    const found = (await h.request('GET', `/v1/ferrets/${id}`)).json<{ title?: string; titleSource?: string }>();
    return {
      ...(found.title === undefined ? {} : { title: found.title }),
      ...(found.titleSource === undefined ? {} : { titleSource: found.titleSource }),
    };
  };
  return { h, tree, id, transcript, shown };
}

/** The driven clock wound by `ms` in steps, the loop handed back each time so a tick's own reads and writes land. */
const wind = async (w: World, ms: number): Promise<void> => {
  for (let spent = 0; spent < ms; spent += 500) {
    await w.h.clock.advance(500);
    await w.h.settle();
    await Bun.sleep(5);
  }
};

describe('r11 S11 a title the CLI writes later reaches the ferret by the daemon’s own sweep', () => {
  test('a late ai-title is adopted within the sweep (auto), with nothing asking the index', async () => {
    const w = await boot();
    // The daemon's warm-up read (a little after start) offers the title made from the first exchange.
    await wind(w, 3_000);
    const made = await w.shown();
    expect(made.titleSource).toBe('auto');
    expect(made.title).toBeDefined();
    expect(made.title).not.toBe(LATE);

    // Claude Code writes its own title AFTER that. No listing, no search, no refresh: only time passes.
    w.tree.put(w.transcript, record({ type: 'ai-title', aiTitle: LATE }));
    await wind(w, 6_000);
    expect(await w.shown()).toEqual({ title: LATE, titleSource: 'auto' });
  });

  test('an owner’s Rename survives a later ai-title, however long the sweep runs', async () => {
    const w = await boot();
    await wind(w, 3_000);
    w.tree.put(w.transcript, record({ type: 'ai-title', aiTitle: LATE }));
    await wind(w, 6_000);
    expect((await w.shown()).title).toBe(LATE);

    const renamed = await w.h.request('POST', `/v1/ferrets/${w.id}/rename`, { body: { title: OWNERS } });
    expect(renamed.status).toBe(200);
    expect(await w.shown()).toEqual({ title: OWNERS, titleSource: 'owner' });

    w.tree.put(w.transcript, record({ type: 'ai-title', aiTitle: NEWER }));
    await wind(w, 12_000);
    expect(await w.shown()).toEqual({ title: OWNERS, titleSource: 'owner' });
  });
});

describe('r11 S11 round 3: the sweep reads only for a RUNNING ferret that is still auto-titled, and only what can be that ferret’s', () => {
  const OTHER = 'projects/-work-b/00000000-0000-4000-8000-000000000b0b.jsonl';

  test('after the only ferret stops, the next ticks list and read nothing, whatever lands in the history', async () => {
    const w = await boot();
    await wind(w, 3_000);
    expect((await w.shown()).titleSource).toBe('auto');

    const stopped = await w.h.request('POST', `/v1/ferrets/${w.id}/stop`);
    expect(stopped.status).toBe(200);
    await w.h.settle();
    // A tick that was already running when the ferret stopped may still finish: let it, then count from a clean slate.
    await wind(w, 6_000);
    w.tree.listed.length = 0;
    w.tree.opened.length = 0;

    // A new, unrelated conversation appears in the owner's history, and the ferret's own gets a late title.
    w.tree.put(OTHER, exchange());
    w.tree.put(w.transcript, record({ type: 'ai-title', aiTitle: LATE }));
    await wind(w, 20_000);

    expect({ listed: w.tree.listed.length, opened: w.tree.opened.length }).toEqual({ listed: 0, opened: 0 });
    expect((await w.shown()).title).not.toBe(LATE);
  });

  test('while the ferret runs, a transcript that is not its own is never read by a tick', async () => {
    const w = await boot();
    await wind(w, 3_000);
    w.tree.opened.length = 0;

    w.tree.put(OTHER, exchange());
    w.tree.put(w.transcript, record({ type: 'ai-title', aiTitle: LATE }));
    await wind(w, 12_000);

    expect(await w.shown()).toEqual({ title: LATE, titleSource: 'auto' });
    expect(w.tree.opened.filter(path => path === OTHER)).toEqual([]);
    expect(w.tree.opened.some(path => path === w.transcript)).toBe(true);
  });

  test('a ferret resumed after it stopped is watched again', async () => {
    const w = await boot();
    await wind(w, 3_000);
    await w.h.request('POST', `/v1/ferrets/${w.id}/stop`);
    await w.h.settle();
    await wind(w, 6_000);
    const resumed = await w.h.request('POST', `/v1/ferrets/${w.id}/resume`);
    expect(resumed.status).toBeLessThan(300);
    await w.h.settle();

    w.tree.put(w.transcript, record({ type: 'ai-title', aiTitle: LATE }));
    await wind(w, 12_000);
    expect(await w.shown()).toEqual({ title: LATE, titleSource: 'auto' });
  });
});

describe('r11 S11 rounds 6-7: a refresh that runs before Ferrets has a whole roster never clears an owner title or a ferret', () => {
  type Listed = { ferret?: string; ferretName?: string; title?: string; name?: string };
  const listed = async (w: World): Promise<Listed | undefined> => {
    const answer = (await w.h.request('GET', '/v1/links/conversations')).json<{ conversations: Listed[] }>();
    return answer.conversations.find(row => row.ferret === w.id) ?? answer.conversations[0];
  };

  /** A world whose ferret the owner has renamed, and whose index has read that. */
  const owned = async (): Promise<World> => {
    const w = await boot();
    await wind(w, 3_000);
    expect((await w.h.request('POST', `/v1/ferrets/${w.id}/rename`, { body: { title: OWNERS } })).status).toBe(200);
    await w.h.request('GET', '/v1/links/conversations');
    await wind(w, 6_000);
    expect(await listed(w)).toMatchObject({ ferret: w.id, title: OWNERS });
    return w;
  };

  /** Driven time only passes (a registry read held on purpose cannot settle the host). */
  const drive = async (h: TestHost, ms: number): Promise<void> => {
    for (let spent = 0; spent < ms; spent += 500) {
      await h.clock.advance(500);
      await Bun.sleep(5);
    }
  };
  /** An answer that did not come within a second of real time is no answer (so a hang fails instead of timing out the file). */
  const within = async <T>(answer: Promise<T>): Promise<T | 'hung'> =>
    await Promise.race([answer, Bun.sleep(1_500).then((): 'hung' => 'hung')]);

  const AGENDA_PREVIEW = ['POST', '/v1/agenda/clear-agents', { body: { dryRun: true } }] as const;

  test('the registry still loading: the owner title and the ferret survive; the agenda clear-agents preview answers as it does without Conversation', async () => {
    const w = await owned();
    // A daemon restart whose Ferrets records load slowly: its state listing is held until the test lets it go.
    let release!: () => void;
    const held = new Promise<void>(resolve => (release = resolve));
    const folder = w.h.state('ferrets');
    const realPort = folder.port.bind(folder);
    folder.port = declared => {
      const port = realPort(declared);
      return {
        ...port,
        list: async (...args: Parameters<typeof port.list>) => {
          await held;
          return await port.list(...args);
        },
      };
    };
    const second = await w.h.restart();
    const again: World = { ...w, h: second };

    await drive(second, 2_000);
    // The preview other callers use does not wait for the registry (as on the parent): it answers 200 while the records are held.
    const preview = await within(second.request(...AGENDA_PREVIEW));
    expect(preview === 'hung' ? preview : preview.status).toBe(200);
    // A listing asked in that window answers from the index with what it held: an empty registry is not "no ferrets".
    const duringLoad = second.request('GET', '/v1/links/conversations');
    await drive(second, 8_000);
    const whileLoading = (await duringLoad).json<{ conversations: Listed[] }>().conversations[0];
    release();
    await second.settle();
    expect(whileLoading).toMatchObject({ ferret: w.id, title: OWNERS });
    await wind(again, 3_000);
    await second.request('GET', '/v1/links/conversations');
    await wind(again, 6_000);

    expect(await listed(again)).toMatchObject({ ferret: w.id, title: OWNERS });
    expect(await again.shown()).toEqual({ title: OWNERS, titleSource: 'owner' });
  });

  test('round 8: hydration held pending never holds a refresh — a transcript appended after one IS read by the next, full refreshes do not queue, the owner title stays', async () => {
    const w = await owned();
    let release!: () => void;
    const held = new Promise<void>(resolve => (release = resolve));
    const folder = w.h.state('ferrets');
    const realPort = folder.port.bind(folder);
    folder.port = declared => {
      const port = realPort(declared);
      return {
        ...port,
        list: async (...args: Parameters<typeof port.list>) => {
          await held;
          return await port.list(...args);
        },
      };
    };
    const second = await w.h.restart();
    await drive(second, 2_000);

    // A listing's own deadline is on the driven clock, so time is wound while each is asked.
    const rowsOf = async (count: number) => {
      const asked = Array.from({ length: count }, () => second.request('GET', '/v1/links/conversations'));
      const winding = drive(second, 8_000);
      const rows = await within(
        Promise.all(asked).then(answers =>
          answers.map(answer => answer.json<{ conversations: (Listed & { latest?: string })[] }>().conversations[0]),
        ),
      );
      await winding;
      return rows;
    };
    // A refresh while the roster is still loading answers (it does not wait for the registry) and keeps the owner title.
    const first = await rowsOf(1);
    expect(first).not.toBe('hung');
    expect((first as unknown[])[0]).toMatchObject({ ferret: w.id, title: OWNERS });

    // The conversation grows AFTER that refresh. The next refresh, hydration still pending, must read it.
    // The index is fresh for 5 s: let that pass, so the next listing refreshes (hydration is STILL held).
    await drive(second, 6_000);
    const SECOND = 'and does the linux runner fail the same way afterwards?';
    w.tree.put(
      w.transcript,
      record({ type: 'user', cwd: '/work/a', timestamp: AT, message: { role: 'user', content: SECOND } }) +
        record({
          type: 'assistant',
          cwd: '/work/a',
          timestamp: AT,
          message: { role: 'assistant', content: 'checking' },
        }),
    );
    // Two listings at once while hydration is held: neither hangs (a refresh never waits for the registry, so none queues behind one).
    const concurrent = await rowsOf(2);
    expect(concurrent).not.toBe('hung');
    for (const row of concurrent as { title?: string; ferret?: string }[])
      expect(row).toMatchObject({ ferret: w.id, title: OWNERS });
    // The refresh they started read the appended transcript, hydration still held, and the owner title stayed.
    const after = await rowsOf(1);
    expect(after).not.toBe('hung');
    expect((after as unknown[])[0]).toMatchObject({ ferret: w.id, title: OWNERS, latest: SECOND });
    release();
    await second.settle();
  });

  test('the registry failing to load: the owner title and the ferret survive a full refresh; the preview still answers 200', async () => {
    const w = await owned();
    const folder = w.h.state('ferrets');
    const realPort = folder.port.bind(folder);
    folder.port = declared => ({
      ...realPort(declared),
      list: async () => Promise.reject(new Error('the ferret records could not be listed')),
    });
    const second = await w.h.restart();
    await drive(second, 3_000);
    const preview = await within(second.request(...AGENDA_PREVIEW));
    expect(preview === 'hung' ? preview : preview.status).toBe(200);
    await second.request('GET', '/v1/links/conversations');
    await drive(second, 8_000);
    const after = (await second.request('GET', '/v1/links/conversations')).json<{ conversations: Listed[] }>()
      .conversations[0];
    expect(after).toMatchObject({ ferret: w.id, title: OWNERS });
  });

  test('one listed record that cannot be read: the owner title and the ferret survive a full refresh, once the registry is ready', async () => {
    const w = await owned();
    // The ferret's record is damaged on disk (the state reads a damaged file as damaged, never as empty): Ferrets lists it and
    // cannot read it, so its roster is ready and still lacks a ferret that exists.
    const folder = w.h.state('ferrets');
    const records = [...folder.files.keys()].filter(path => path.endsWith('/ferret.json'));
    expect(records.length).toBeGreaterThan(0);
    for (const path of records) folder.files.set(path, '{ this is not a ferret record');
    const second = await w.h.restart();
    const again: World = { ...w, h: second };
    await second.settle();
    expect((await second.request('GET', '/v1/ferrets')).status).toBe(200);
    expect((await second.request('GET', '/v1/ferrets')).json<unknown[]>()).toHaveLength(0);
    await wind(again, 3_000);
    await second.request('GET', '/v1/links/conversations');
    await wind(again, 6_000);
    expect(await listed(again)).toMatchObject({ ferret: w.id, title: OWNERS });
  });

  test('a ferret that is really gone, with a whole roster, IS cleared (the cleanup still runs)', async () => {
    const w = await owned();
    const folder = w.h.state('ferrets');
    for (const path of [...folder.files.keys()].filter(key => key.startsWith(`${w.id}/`))) folder.files.delete(path);
    const second = await w.h.restart();
    const again: World = { ...w, h: second };
    await second.settle();
    await wind(again, 3_000);
    await second.request('GET', '/v1/links/conversations');
    await wind(again, 6_000);
    const row = await listed(again);
    expect(row?.ferret).toBeUndefined();
    expect(row?.title).not.toBe(OWNERS);
  });
});
