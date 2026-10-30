import { afterEach, describe, it } from 'bun:test';
import { appendFile, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import { unrefFileEventTimers } from '../../../../src/adapters/file-events/bun-file-event-source.ts';
import { platformFileEventSource } from '../../../../src/adapters/file-events/platform.ts';
import {
  FileTranscriptChanges,
  type TranscriptFileEvents,
  type TranscriptFileStamp,
} from '../../../../src/adapters/session/live/file-transcript-changes.ts';
import { FileEventHub } from '../../../../src/lib/file-events/hub.ts';
import { waitFor } from '../../support/wait-for.ts';

/**
 * The transcript signal behind `?transcript=1`, over a real file and the real file-event hub.
 *
 * WHAT THIS HAS TO GET RIGHT. The signal is the only thing that tells a Chat an agent wrote a block, so it
 * must hear every write; and it fires once per stream opened, so it must not hear a mere look — the hub
 * reports a path it starts watching once, unconditionally, and that report would cost every reader a read
 * for nothing. And the session's file moves (a first message binds one, a `/clear` starts another), which
 * the watch must follow when told the journal moved.
 */

const NOW = '2026-10-28T17:00:00.000Z';
const cleanups = new Set<() => Promise<void> | void>();

afterEach(async () => {
  for (const cleanup of cleanups) await cleanup();
  cleanups.clear();
});

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'fy-transcript-changes-'));
  cleanups.add(async () => await rm(root, { recursive: true, force: true }));
  return root;
}

function hub(): FileEventHub {
  const events = new FileEventHub(platformFileEventSource(), unrefFileEventTimers);
  cleanups.add(() => events.close());
  return events;
}

const stamp = async (file: string): Promise<TranscriptFileStamp | undefined> =>
  await stat(file).then(
    found => ({ size: found.size, mtimeMs: found.mtimeMs }),
    () => undefined,
  );

/** What the hub and the stat port have been through, so a test can wait for an event instead of for time. */
interface Seen {
  subscriptions: number;
  notices: number;
  stats: number;
}

/** The hub, counting what it reports; the first report of a new subscription is a notice like any other. */
function observing(events: FileEventHub): { readonly files: TranscriptFileEvents; readonly seen: Seen } {
  const seen: Seen = { subscriptions: 0, notices: 0, stats: 0 };
  const files: TranscriptFileEvents = {
    subscribe: (path, listener) => {
      seen.subscriptions += 1;
      return events.subscribe(path, changed => {
        seen.notices += 1;
        listener(changed);
      });
    },
  };
  return { files, seen };
}

/** The real stamp, counting each look once it has an answer; the watch's own first look and the hub's first report make two. */
function counting(seen: Seen): typeof stamp {
  return async file => {
    const found = await stamp(file);
    seen.stats += 1;
    return found;
  };
}

/** Resolves once `count` changes were heard; the safety net only names what never came. */
async function heardAtLeast(heard: readonly string[], count: number): Promise<number> {
  await waitFor(() => heard.length >= count, `${String(count)} change(s) to be heard`);
  return heard.length;
}

/**
 * A second watch on its own file in the same directory of the same hub. Writing to it and hearing it is the
 * positive sentinel for "the hub has been through everything written before": the hub looks at every
 * subscribed path in a directory after any event there, so a probe write is heard only after the writes
 * before it were seen to.
 */
async function probeOn(events: FileEventHub, root: string): Promise<() => Promise<void>> {
  const file = join(root, 'probe.jsonl');
  await writeFile(file, '{"probe":0}\n');
  const heard: string[] = [];
  const { files, seen } = observing(events);
  const watch = new FileTranscriptChanges({
    file: async () => file,
    stat,
    files,
    clock: { now: () => NOW },
  }).watch('probe', at => heard.push(at));
  cleanups.add(() => watch.close());
  await waitFor(() => seen.subscriptions >= 1, 'the probe to be subscribed');
  let writes = 0;
  return async () => {
    writes += 1;
    await appendFile(file, `{"probe":${String(writes)}}\n`);
    await waitFor(() => heard.length >= writes, `probe write ${String(writes)} to be heard`);
  };
}

describe('FileTranscriptChanges', () => {
  it('should hear each append to the session transcript, and not the watch starting', async () => {
    // Arrange — a transcript that already has a conversation in it.
    const root = await workspace();
    const file = join(root, 'session.jsonl');
    await writeFile(file, '{"type":"user"}\n');
    const heard: string[] = [];
    const { files, seen } = observing(hub());
    const changes = new FileTranscriptChanges({
      file: async () => file,
      stat: counting(seen),
      files,
      clock: { now: () => NOW },
    });
    const watch = changes.watch('s1', at => heard.push(at));
    cleanups.add(() => watch.close());
    // The hub's own first report of the path has come and been looked at (the watch's look, then the report's).
    await waitFor(() => seen.stats >= 2, "the hub's first report of the path to be looked at");
    const beforeAppend = heard.length;

    // Act — the second append waits for the first to be heard, so the hub has finished its pass.
    await appendFile(file, '{"type":"assistant"}\n');
    const afterFirst = await heardAtLeast(heard, 1);
    await appendFile(file, '{"type":"assistant","n":2}\n');
    const afterSecond = await heardAtLeast(heard, 2);

    // Assert
    should(beforeAppend).equal(0);
    should(afterFirst).equal(1);
    should(afterSecond).equal(2);
    should(heard).deepEqual([NOW, NOW]);
  });

  it('should start listening once a new session proves its first transcript, and follow it when it moves', async () => {
    // Arrange — no transcript yet, as for a session before its first message.
    const root = await workspace();
    const first = join(root, 'first.jsonl');
    const second = join(root, 'second.jsonl');
    let bound: string | undefined;
    let resolutions = 0;
    const events = hub();
    const heard: string[] = [];
    const watch = new FileTranscriptChanges({
      file: async () => {
        resolutions += 1;
        return bound;
      },
      stat: stamp,
      files: events,
      clock: { now: () => NOW },
    }).watch('s1', at => heard.push(at));
    cleanups.add(() => watch.close());
    const probe = await probeOn(events, root);
    await waitFor(() => resolutions >= 1, 'the watch to look for the session transcript');

    // Act — the first message binds a file; the journal moves; the agent appends.
    await writeFile(first, '{"type":"user"}\n');
    bound = first;
    watch.refresh();
    // Binding a first file is itself heard, the moment it is followed.
    const onBinding = await heardAtLeast(heard, 1);
    await appendFile(first, '{"type":"assistant"}\n');
    const afterAppend = await heardAtLeast(heard, onBinding + 1);
    // A `/clear` moves the session to another file: that is a change in itself.
    await writeFile(second, '{"type":"user"}\n');
    bound = second;
    watch.refresh();
    const afterMove = await heardAtLeast(heard, afterAppend + 1);
    // A write to the file left behind; the probe write after it is heard once the hub has been through it.
    await appendFile(first, '{"type":"assistant","stale":true}\n');
    await probe();
    const afterStaleWrite = heard.length;
    await appendFile(second, '{"type":"assistant"}\n');
    const afterNewWrite = await heardAtLeast(heard, afterMove + 1);

    // Assert — binding a first file is a change (the reader finds the first message); each later
    // write to the followed file is heard once, the move is heard, and the file left behind is not.
    should(onBinding).equal(1);
    should(afterAppend).equal(2);
    should(afterMove).equal(3);
    should(afterStaleWrite).equal(3);
    should(afterNewWrite).equal(4);
  });

  it('should hear nothing after it is closed', async () => {
    // Arrange
    const root = await workspace();
    const file = join(root, 'session.jsonl');
    await writeFile(file, '{"type":"user"}\n');
    const heard: string[] = [];
    const events = hub();
    const { files, seen } = observing(events);
    const watch = new FileTranscriptChanges({
      file: async () => file,
      stat: counting(seen),
      files,
      clock: { now: () => NOW },
    }).watch('s1', at => heard.push(at));
    const probe = await probeOn(events, root);
    await waitFor(() => seen.stats >= 2, "the hub's first report of the path to be looked at");

    // Act — the probe write is heard only after the hub has been through the append to the closed watch's file.
    watch.close();
    await appendFile(file, '{"type":"assistant"}\n');
    await probe();

    // Assert
    should(heard).be.empty();
  });

  it('should release a subscription it finished taking after the watch was closed', async () => {
    // Arrange — the stamp read that precedes subscribing is still pending when the watch is closed.
    const subscribed: string[] = [];
    let release: (() => void) | undefined;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    let entered: (() => void) | undefined;
    const statEntered = new Promise<void>(resolve => {
      entered = resolve;
    });
    let released = false;
    const heard: string[] = [];
    const watch = new FileTranscriptChanges({
      file: async () => '/transcripts/session.jsonl',
      stat: async () => {
        entered?.();
        await gate;
        return { size: 1, mtimeMs: 1 };
      },
      files: {
        subscribe: path => {
          subscribed.push(path);
          return {
            close: () => {
              released = true;
            },
          };
        },
      },
      clock: { now: () => NOW },
    }).watch('s1', at => heard.push(at));

    // Act
    await statEntered;
    watch.close();
    release?.();
    await waitFor(() => released, 'the late subscription to be released');

    // Assert — a subscription taken for a closed watch would keep the hub listening for nobody.
    should(subscribed).deepEqual(['/transcripts/session.jsonl']);
    should(heard).be.empty();
  });

  it('should say nothing about a file whose stamp cannot be read, rather than guess it changed', async () => {
    // Arrange — a stamp read that fails before and after the notice reads as "no stamp" both times.
    const root = await workspace();
    const file = join(root, 'session.jsonl');
    await writeFile(file, '{"type":"user"}\n');
    const heard: string[] = [];
    const events = hub();
    const { files, seen } = observing(events);
    let looks = 0;
    const watch = new FileTranscriptChanges({
      file: async () => file,
      stat: async () => {
        looks += 1;
        throw new Error('EACCES');
      },
      files,
      clock: { now: () => NOW },
    }).watch('s1', at => heard.push(at));
    cleanups.add(() => watch.close());
    const probe = await probeOn(events, root);
    await waitFor(() => looks >= 1 && seen.subscriptions >= 1, 'the watch to have looked and subscribed');

    // Act — the probe write is heard only after the hub has been through the append.
    await appendFile(file, '{"type":"assistant"}\n');
    await probe();

    // Assert
    should(heard).be.empty();
  });

  it('should treat a resolver that fails as a session with no transcript yet', async () => {
    // Arrange
    const subscribed: string[] = [];
    const heard: string[] = [];
    let resolutions = 0;
    const watch = new FileTranscriptChanges({
      file: async () => {
        resolutions += 1;
        throw new Error('the transcript cannot be proved');
      },
      stat: stamp,
      files: {
        subscribe: path => {
          subscribed.push(path);
          return { close: () => undefined };
        },
      },
      clock: { now: () => NOW },
    }).watch('s1', at => heard.push(at));
    cleanups.add(() => watch.close());

    // Act
    await waitFor(() => resolutions >= 1, 'the first resolution to have failed');
    watch.refresh();
    await waitFor(() => resolutions >= 2, 'the refreshed resolution to have failed');

    // Assert
    should(subscribed).be.empty();
    should(heard).be.empty();
  });
});
