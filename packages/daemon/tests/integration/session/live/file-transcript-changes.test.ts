import { afterEach, describe, it } from 'bun:test';
import { appendFile, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import { unrefFileEventTimers } from '../../../../src/adapters/file-events/bun-file-event-source.ts';
import { platformFileEventSource } from '../../../../src/adapters/file-events/platform.ts';
import {
  FileTranscriptChanges,
  type TranscriptFileStamp,
} from '../../../../src/adapters/session/live/file-transcript-changes.ts';
import { FileEventHub } from '../../../../src/lib/file-events/hub.ts';

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

/** Resolves once `count` changes were heard, or with what was heard after `ms`. */
async function heardWithin(heard: readonly string[], count: number, ms: number): Promise<number> {
  const deadline = Date.now() + ms;
  while (heard.length < count && Date.now() < deadline) await Bun.sleep(10);
  return heard.length;
}

describe('FileTranscriptChanges', () => {
  it('should hear each append to the session transcript, and not the watch starting', async () => {
    // Arrange — a transcript that already has a conversation in it.
    const root = await workspace();
    const file = join(root, 'session.jsonl');
    await writeFile(file, '{"type":"user"}\n');
    const heard: string[] = [];
    const changes = new FileTranscriptChanges({
      file: async () => file,
      stat: stamp,
      files: hub(),
      clock: { now: () => NOW },
    });
    const watch = changes.watch('s1', at => heard.push(at));
    cleanups.add(() => watch.close());
    // Long enough for the hub's own first report of the path to come and go.
    await Bun.sleep(200);
    const beforeAppend = heard.length;

    // Act
    await appendFile(file, '{"type":"assistant"}\n');
    const afterFirst = await heardWithin(heard, 1, 2_000);
    await Bun.sleep(100);
    await appendFile(file, '{"type":"assistant","n":2}\n');
    const afterSecond = await heardWithin(heard, 2, 2_000);

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
    const heard: string[] = [];
    const watch = new FileTranscriptChanges({
      file: async () => bound,
      stat: stamp,
      files: hub(),
      clock: { now: () => NOW },
    }).watch('s1', at => heard.push(at));
    cleanups.add(() => watch.close());
    await Bun.sleep(50);

    // Act — the first message binds a file; the journal moves; the agent appends.
    await writeFile(first, '{"type":"user"}\n');
    bound = first;
    watch.refresh();
    await Bun.sleep(200);
    const onBinding = heard.length;
    await appendFile(first, '{"type":"assistant"}\n');
    const afterAppend = await heardWithin(heard, onBinding + 1, 2_000);
    // A `/clear` moves the session to another file: that is a change in itself.
    await writeFile(second, '{"type":"user"}\n');
    bound = second;
    watch.refresh();
    const afterMove = await heardWithin(heard, afterAppend + 1, 2_000);
    await Bun.sleep(100);
    await appendFile(first, '{"type":"assistant","stale":true}\n');
    await Bun.sleep(200);
    const afterStaleWrite = heard.length;
    await appendFile(second, '{"type":"assistant"}\n');
    const afterNewWrite = await heardWithin(heard, afterMove + 1, 2_000);

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
    const watch = new FileTranscriptChanges({
      file: async () => file,
      stat: stamp,
      files: hub(),
      clock: { now: () => NOW },
    }).watch('s1', at => heard.push(at));
    await Bun.sleep(100);

    // Act
    watch.close();
    await appendFile(file, '{"type":"assistant"}\n');
    await Bun.sleep(300);

    // Assert
    should(heard).be.empty();
  });

  it('should say nothing about a file whose stamp cannot be read, rather than guess it changed', async () => {
    // Arrange — a stamp read that fails before and after the notice reads as "no stamp" both times.
    const root = await workspace();
    const file = join(root, 'session.jsonl');
    await writeFile(file, '{"type":"user"}\n');
    const heard: string[] = [];
    const watch = new FileTranscriptChanges({
      file: async () => file,
      stat: async () => {
        throw new Error('EACCES');
      },
      files: hub(),
      clock: { now: () => NOW },
    }).watch('s1', at => heard.push(at));
    cleanups.add(() => watch.close());
    await Bun.sleep(100);

    // Act
    await appendFile(file, '{"type":"assistant"}\n');
    await Bun.sleep(300);

    // Assert
    should(heard).be.empty();
  });

  it('should treat a resolver that fails as a session with no transcript yet', async () => {
    // Arrange
    const subscribed: string[] = [];
    const heard: string[] = [];
    const watch = new FileTranscriptChanges({
      file: async () => {
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
    watch.refresh();
    await Bun.sleep(20);

    // Assert
    should(subscribed).be.empty();
    should(heard).be.empty();
  });
});
