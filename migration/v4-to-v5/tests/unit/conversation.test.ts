import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  DraftSnapshotSchema,
  LinksFileSchema,
  QuestionSchema,
  SendRecordSchema,
  StoredRenderMetaSchema,
} from '@ferretry/plugin-conversation/contract';
import { createHash } from 'node:crypto';
import { chmod, mkdir, readdir, readFile, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  conversationStep,
  DraftsDocumentSchema,
  V5_LINKS_FILE,
  V5_MESSAGE_TOKEN_KEY_FILE,
  V5AnswerLineSchema,
  v5AnswersFile,
  v5AttachmentManifest,
  v5AttachmentOriginal,
  v5DraftsFile,
  V5InboxLineSchema,
  v5InboxFile,
  V5OutboxLineSchema,
  v5OutboxFile,
  v5QuestionFile,
  V5QueueLineSchema,
  v5QueueFile,
  v5RenderMeta,
  v5RenderPayload,
  V5SendLineSchema,
  v5SendView,
  v5SendsFile,
  v5TurnsFolder,
} from '../../src/steps/conversation.ts';
import { STEPS } from '../../src/steps/index.ts';
import { foldV4Queue, latestV4Sends, V4SendLine } from '../../src/v4/conversation.ts';
import { AT, fixture, RUNTIME } from './ferret-fixture.ts';

// A FAKE key: 32 fixed printable bytes, so a test can prove they are copied unchanged and never reach a report.
const FAKE_KEY = Buffer.from('FAKE-MESSAGE-TOKEN-KEY-0123456789'.slice(0, 32), 'utf8');
const FAKE_VALUE = 'FAKE-CONTENT-NEVER-IN-A-REPORT';

let f: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => {
  f = await fixture();
});
afterEach(async () => {
  await f.clean();
});

const raw = async (path: string, content: string | Buffer, mode = 0o600) => {
  const target = join(f.from, path);
  await mkdir(join(target, '..'), { recursive: true, mode: 0o700 });
  await writeFile(target, content, { mode });
  await chmod(target, mode);
};
const jsonl = (lines: readonly unknown[]) => `${lines.map(line => JSON.stringify(line)).join('\n')}\n`;
const exists = async (path: string) => (await stat(join(f.to, path)).catch(() => undefined)) !== undefined;
/** Every line of a written v5 log, each checked to start with the kernel's `"format":1` stamp. */
const lines = async (path: string) => {
  const text = await readFile(join(f.to, path), 'utf8');
  expect(text.endsWith('\n')).toBe(true);
  return text
    .trimEnd()
    .split('\n')
    .map(line => {
      expect(line.startsWith('{"format":1,')).toBe(true);
      return JSON.parse(line) as Record<string, unknown>;
    });
};

const draft = (sessionId: string, extra: Record<string, unknown> = {}) => ({
  v: 1,
  sessionId,
  generation: 'g1',
  epoch: 0,
  rev: 3,
  text: 'FAKE draft text',
  items: [{ kind: 'attachment', id: 'att_1', name: 'a.png', mime: 'image/png', bytes: 10 }],
  updatedAt: AT,
  ...extra,
});

const queued = (id: string, text = 'FAKE queued') => ({
  v: 1,
  id,
  sender: 'human',
  text,
  attachmentIds: [],
  enqueuedAt: AT,
  state: 'queued',
  stateAt: AT,
  revision: 1,
});
const send = (sendId: string, fate: string, extra: Record<string, unknown> = {}) => ({
  sendId,
  acceptedAt: AT,
  acceptedTurn: 1,
  path: 'direct',
  message: 'FAKE send',
  matchText: 'FAKE match',
  fate,
  at: AT,
  ...extra,
});
const live = async (id = 'f1', extra: Record<string, unknown> = {}) => {
  await f.session(id, extra);
  await f.put(`state/sessions/${id}/state.json`, { id, status: 'awaiting_question' });
};

/** A claude ferret whose transcript is in a runtime home the converter can place in the new home. */
const homeOf = () => join(f.from, 'fleet/homes', RUNTIME);
const transcriptFile = () => join(homeOf(), 'projects/p/c.jsonl');
const claudeFerret = (id = 'f1') =>
  live(id, {
    harness: 'claude',
    transcript: { v: 1, home: homeOf(), identity: 'minted', harnessSessionId: 'c', file: transcriptFile() },
  });
const asked = (questions: readonly unknown[], path = transcriptFile()) => ({
  hook_event_name: 'PreToolUse',
  tool_name: 'AskUserQuestion',
  tool_use_id: 'toolu_1',
  transcript_path: path,
  tool_input: { questions },
});

/** A content-addressed attachment, as v4 and v5 both name one. */
const attachment = (bytes: Buffer, extra: Record<string, unknown> = {}) => {
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  return {
    id: `att_${sha256}`,
    manifest: {
      id: `att_${sha256}`,
      filename: 'a.png',
      mime: 'image/png',
      size: bytes.length,
      sha256,
      createdAt: AT,
      ...extra,
    },
  };
};
const putAttachment = async (daemon: string, ferret: string, bytes: Buffer, extra: Record<string, unknown> = {}) => {
  const { id, manifest } = attachment(bytes, extra);
  await f.put(`state/attachments/${daemon}/${ferret}/${id}/manifest.json`, manifest);
  await raw(`state/attachments/${daemon}/${ferret}/${id}/original`, bytes);
  return id;
};
const renderMeta = (id: string, extra: Record<string, unknown> = {}) => ({
  v: 1,
  id,
  kind: 'svg',
  alt: 'FAKE alt',
  bytes: 6,
  sha256: 'c'.repeat(64),
  createdAt: AT,
  author: { sessionId: 'f1' },
  ...extra,
});

describe('conversation step', () => {
  test('is registered in place of the pending entry, after ferrets', () => {
    expect(STEPS.map(step => step.id).slice(0, 2)).toEqual(['ferrets', 'conversation']);
    expect(conversationStep.sealed).toEqual(['state/session-message-token.key']);
  });

  test('pins are not listed here: the ferrets step carries them', () => {
    expect(JSON.stringify(conversationStep.notCarried)).not.toContain('pins');
  });

  test('moves the message-token key byte for byte and never puts it in the report', async () => {
    await raw('state/session-message-token.key', FAKE_KEY);
    const time = new Date('2026-10-01T00:00:00.000Z');
    await utimes(join(f.from, 'state/session-message-token.key'), time, time);
    const report = await conversationStep.run(f.ctx());

    expect(report.status).toBe('converted');
    const moved = join(f.to, V5_MESSAGE_TOKEN_KEY_FILE);
    expect(V5_MESSAGE_TOKEN_KEY_FILE).toBe('state/conversation/message-token.key');
    expect(Buffer.compare(await readFile(moved), FAKE_KEY)).toBe(0);
    expect((await stat(moved)).mode & 0o777).toBe(0o600);
    expect((await stat(moved)).mtime.toISOString()).toBe(time.toISOString());
    expect(report.sealed).toEqual([{ file: V5_MESSAGE_TOKEN_KEY_FILE, bytes: 32 }]);
    const text = JSON.stringify(report);
    expect(text).not.toContain(FAKE_KEY.toString('utf8'));
    expect(text).not.toContain(FAKE_KEY.toString('base64'));
    expect(text).not.toContain(FAKE_KEY.toString('hex'));
  });

  test('refuses a key that is not 0600, naming the file and nothing in it', async () => {
    await raw('state/session-message-token.key', FAKE_KEY, 0o644);
    const report = await conversationStep.run(f.ctx());
    expect(report.status).toBe('failed');
    expect(report.note).toBe('sealed key is not mode 0600: state/session-message-token.key');
    expect(await exists(V5_MESSAGE_TOKEN_KEY_FILE)).toBe(false);
  });

  test('copies turns byte for byte with modes and times, and omits links', async () => {
    await f.session('f1');
    await raw('state/sessions/f1/turns/turn-001.md', '# FAKE task\n');
    await raw('state/sessions/f1/turns/turn-001.by.json', '{"kind":"owner"}', 0o640);
    const time = new Date('2026-10-02T00:00:00.000Z');
    await utimes(join(f.from, 'state/sessions/f1/turns/turn-001.md'), time, time);
    await symlink('/nowhere/outside', join(f.from, 'state/sessions/f1/turns/linked.md'));
    const report = await conversationStep.run(f.ctx());

    const turns = join(f.to, v5TurnsFolder('f1'));
    expect(v5TurnsFolder('f1')).toBe('state/ferrets/sessions/f1/turns');
    expect(await readFile(join(turns, 'turn-001.md'), 'utf8')).toBe('# FAKE task\n');
    expect(await readFile(join(turns, 'turn-001.by.json'), 'utf8')).toBe('{"kind":"owner"}');
    expect((await stat(join(turns, 'turn-001.by.json'))).mode & 0o777).toBe(0o640);
    expect((await stat(join(turns, 'turn-001.md'))).mtime.toISOString()).toBe(time.toISOString());
    expect(await stat(join(turns, 'linked.md')).catch(() => undefined)).toBeUndefined();
    expect(report.kept).toContainEqual({ what: 'turn files copied byte for byte', count: 2 });
    expect(report.note).toContain('1 link(s) in turns omitted');
  });

  test("5.0's own reader finds a migrated ferret's turn-001 (Ferrets' sessions root, FileSessionTaskStore)", async () => {
    await f.session('f1');
    await raw('state/sessions/f1/turns/turn-001.md', '# FAKE assigned task\n');
    expect((await conversationStep.run(f.ctx())).status).toBe('converted');
    // A subprocess that imports nothing from this tool: the kernel's roots port over the converted home, the one
    // the daemon hands Ferrets, and Ferrets' task store, which resolves the assigned task as turns/turn-001.md.
    const script = join(f.root, 'read-turn-v5.ts');
    await writeFile(
      script,
      `
const [repo, home, ferret] = process.argv.slice(2);
const { nodeFs } = await import(repo + '/packages/core/kernel/host/adapters/node-fs.ts');
const { rootsPortFor } = await import(repo + '/packages/core/kernel/host/roots.ts');
const { FileSessionTaskStore } = await import(
  repo + '/packages/core/ferrets/daemon/adapters/session/lifecycle/file-session-task-store.ts'
);
const layout = { home, plugin: 'ferrets', worktrees: home + '/../worktrees' };
const root = rootsPortFor(nodeFs(() => 'x'), layout, ['sessions'], () => undefined).root('sessions', { subfolder: ferret });
const file = new FileSessionTaskStore(root, ferret).file(ferret);
const text = await root.readDurable(file, undefined, async held => new TextDecoder().decode(held.bytes));
console.log(JSON.stringify({ text }));
`,
    );
    const repo = join(import.meta.dir, '../../../..');
    const child = Bun.spawn(['bun', script, repo, f.to, 'f1'], { cwd: repo, stdout: 'pipe', stderr: 'pipe' });
    const [out, error] = [await new Response(child.stdout).text(), await new Response(child.stderr).text()];
    if ((await child.exited) !== 0) throw new Error(error);
    expect(JSON.parse(out)).toEqual({ text: '# FAKE assigned task\n' });
  });

  test('writes the chat draft and agenda reply drafts (same ask ids) through the v5 snapshot schema', async () => {
    await f.session('f1');
    await f.put('state/shared-drafts/f1.json', draft('f1'));
    await f.put('state/shared-drafts/f1.items/A3.json', draft('f1', { slot: 'A3' }));
    await f.put('state/shared-drafts/gone.json', draft('gone'));
    const report = await conversationStep.run(f.ctx());

    const document = DraftsDocumentSchema.parse(JSON.parse(await readFile(join(f.to, v5DraftsFile('f1')), 'utf8')));
    expect(v5DraftsFile('f1')).toBe('state/conversation/f1/drafts');
    expect(Object.keys(document.items)).toEqual(['A3']);
    expect(document.items.A3).toMatchObject({ v: 1, ferret: 'f1', slot: 'A3', text: 'FAKE draft text' });
    expect(document.items.A3).not.toHaveProperty('sessionId');
    expect(DraftSnapshotSchema.parse(document.chat)).toEqual(document.chat!);
    expect(document.chat).toMatchObject({ v: 1, ferret: 'f1', generation: 'g1', rev: 3, text: 'FAKE draft text' });
    expect(document.chat).not.toHaveProperty('sessionId');
    expect(document.chat).not.toHaveProperty('slot');
    expect((await stat(join(f.to, v5DraftsFile('f1')))).mode & 0o777).toBe(0o600);
    expect(report.kept).toContainEqual({ what: 'chat drafts', count: 1 });
    expect(report.kept).toContainEqual({ what: 'agenda reply drafts', count: 1 });
    expect(report.note).toContain('1 orphan draft(s) omitted');
    expect(await exists(v5DraftsFile('gone'))).toBe(false);
  });

  test('a draft that names another session is named and not carried, naming the file only', async () => {
    await f.session('f1');
    await f.put('state/shared-drafts/f1.json', draft('other', { text: FAKE_VALUE }));
    const report = await conversationStep.run(f.ctx());
    expect(report.status).toBe('converted');
    expect(report.note).toContain('shared draft names another session or slot: state/shared-drafts/f1.json');
    expect(await exists(v5DraftsFile('f1'))).toBe(false);
    expect(JSON.stringify(report)).not.toContain(FAKE_VALUE);
  });

  test('links every adopted conversation, under the harness plugin id', async () => {
    const transcript = (identity: string, id: string) => ({
      v: 1,
      home: '/fake/home',
      identity,
      harnessSessionId: id,
      file: `/fake/home/${id}.jsonl`,
    });
    await f.session('kept', {
      harness: 'claude',
      transcript: { ...transcript('adopted', '22222222-2222-4222-8222-222222222222'), resolvedAt: AT },
    });
    await f.session('made', { transcript: transcript('minted', '33333333-3333-4333-8333-333333333333') });
    const report = await conversationStep.run(f.ctx());

    const links = LinksFileSchema.parse(JSON.parse(await readFile(join(f.to, V5_LINKS_FILE), 'utf8')));
    expect(links.links).toEqual([
      { id: '22222222-2222-4222-8222-222222222222', harness: 'claude-code', ferret: 'kept', linkedAt: AT },
    ] as never);
    expect(report.kept).toContainEqual({ what: 'conversation links', count: 1 });
  });

  test('the queue keeps its own events, line for line, each stamped and parsed by the v5 line shape', async () => {
    await f.session('f1');
    const events = [
      { v: 1, kind: 'enqueued', at: AT, message: queued('q1') },
      { v: 1, kind: 'enqueued', at: AT, message: queued('q2') },
      { v: 1, kind: 'edited', at: AT, id: 'q2', text: 'FAKE edited', revision: 2 },
      { v: 1, kind: 'waiting', at: AT, id: 'q2', reason: 'busy' },
      { v: 1, kind: 'moved', at: AT, id: 'q1', state: 'typing', batch: 'q1' },
      { v: 1, kind: 'moved', at: AT, id: 'nobody', state: 'typing' },
    ];
    await raw('state/sessions/f1/channel/queue.jsonl', jsonl(events));
    const report = await conversationStep.run(f.ctx());

    expect(report.status).toBe('converted');
    expect(v5QueueFile('f1')).toBe('state/conversation/f1/queue.jsonl');
    const written = await lines(v5QueueFile('f1'));
    expect(written.map(line => V5QueueLineSchema.parse(line))).toEqual(events.map(e => ({ format: 1, ...e })) as never);
    expect((await stat(join(f.to, v5QueueFile('f1')))).mode & 0o777).toBe(0o600);
    expect(report.kept).toContainEqual({ what: 'queue events', count: 6 });
    expect(report.kept).toContainEqual({ what: 'queued messages (folded)', count: 2 });
  });

  describe('a delivered v4 input keeps claiming the same drain under v5’s key', () => {
    // v4 named a Claude drain without a uuid `<transcript path>#<start>#<end>` (observed-input.ts); v5 names the same
    // unchanged drain `queued-prompt:<start>` (the Claude harness's entry id). One delivered input confirms at most one
    // send, so a claim kept under the v4 spelling would let a second identical, still-pending send be confirmed by it.
    const V4_PATH = '/v4/home/runtimes/claude/projects/-work/conv-1.jsonl';
    const evidence = (key: string, extra: Record<string, unknown> = {}) => ({
      key,
      harness: 'claude',
      kind: 'queued_command',
      proof: 'native-queue-drain',
      observedAt: AT,
      shapeVersion: 1,
      matchedTurn: 1,
      tier: 'exact-text',
      ...extra,
    });
    /** A Claude ferret whose old transcript is `V4_PATH`, the only file a v4 byte-span claim may be translated against. */
    const converted = async (rows: readonly unknown[], transcript: string | null = V4_PATH, harness = 'claude') => {
      await f.session(
        'f1',
        transcript === null
          ? { harness }
          : {
              harness,
              transcript: {
                v: 1,
                home: '/v4/home/runtimes/claude',
                identity: 'minted',
                harnessSessionId: 'c',
                file: transcript,
              },
            },
      );
      await raw('state/sessions/f1/channel/sends.jsonl', jsonl(rows));
      await conversationStep.run(f.ctx());
      return (await lines(v5SendsFile('f1'))).map(line => V5SendLineSchema.parse(line));
    };

    test('a delivered row and a pending row: the claim is the key v5 will emit, the pending send stays pending', async () => {
      const written = await converted([
        send('first', 'delivered', { evidence: evidence(`${V4_PATH}#283#476`), fateAt: AT }),
        send('second', 'accepted', { acceptedAt: '2026-11-11T00:00:02.000Z', at: '2026-11-11T00:00:02.000Z' }),
      ]);
      expect(written.map(line => [line.sendId, line.fate])).toEqual([
        ['first', 'delivered'],
        ['second', 'accepted'],
      ]);
      expect(written[0]?.evidence?.key).toBe('queued-prompt:283');
      expect(written[0]?.evidence).toMatchObject({ proof: 'native-queue-drain', matchedTurn: 1, tier: 'exact-text' });
      expect(written[1]).not.toHaveProperty('evidence');
    });

    test('a path with # in it converts by its trailing byte span', async () => {
      const written = await converted(
        [
          send('a', 'delivered', { evidence: evidence('/home/a#b/c.jsonl#12#99') }),
          send('b', 'delivered', { evidence: evidence('/home/a#b/c.jsonl#99#200') }),
        ],
        '/home/a#b/c.jsonl',
      );
      expect(written.map(line => line.evidence?.key)).toEqual(['queued-prompt:12', 'queued-prompt:99']);
    });

    test('a uuid key converts unchanged', async () => {
      const key = '5f0c2f8e-1a5d-4c53-9a39-0e1d4b1d9c11';
      const written = await converted([send('a', 'delivered', { evidence: evidence(key) })]);
      expect(written[0]?.evidence?.key).toBe(key);
    });

    test('a key that is not a Claude drain’s byte span is kept as it was, never cleared', async () => {
      const codex = `${V4_PATH}#12#99`;
      const written = await converted([
        send('a', 'delivered', {
          evidence: evidence(codex, { harness: 'codex', kind: 'response_item', proof: 'normal-user-record' }),
        }),
        send('b', 'delivered', { evidence: evidence('not-a-span#x#y') }),
        send('c', 'delivered', { evidence: evidence(`${V4_PATH}#99#12`) }),
      ]);
      expect(written.map(line => line.evidence?.key)).toEqual([codex, 'not-a-span#x#y', `${V4_PATH}#99#12`]);
    });

    describe('a claim the conversion cannot prove leaves the ledger’s unresolved sends unconfirmed (never corrected, never retyped)', () => {
      const codexSpan = (extra: Record<string, unknown> = {}) =>
        evidence('/v4/home/runtimes/codex/sessions/rollout-a.jsonl#120#340', {
          harness: 'codex',
          kind: 'response_item',
          proof: 'normal-user-record',
          ...extra,
        });
      const codexPayloadId = () =>
        evidence('native-message-uuid', { harness: 'codex', kind: 'response_item', proof: 'normal-user-record' });
      const second = { acceptedAt: '2026-11-11T00:00:02.000Z', at: '2026-11-11T00:00:02.000Z' };
      const state = (written: readonly { sendId: string; fate: string; unaccountedReason?: string }[]) =>
        written.map(line => [line.sendId, line.fate, line.unaccountedReason]);

      for (const [name, claim] of [
        ['a Codex byte-span claim', codexSpan],
        ['a Codex payload.id claim', codexPayloadId],
      ] as const)
        test(`${name}: the delivered row stays delivered and claimed as it was; the pending send is unconfirmed`, async () => {
          const written = await converted(
            [send('first', 'delivered', { evidence: claim(), fateAt: AT }), send('second', 'accepted', second)],
            null,
            'codex',
          );
          expect(state(written)).toEqual([
            ['first', 'delivered', undefined],
            ['second', 'unaccounted', 'update_unconfirmed'],
          ]);
          expect(written[0]?.evidence?.key).toBe(claim().key);
          // The unconfirmed line is servable and says nothing a code would: the wire projection parses.
          for (const line of written) SendRecordSchema.parse(v5SendView(line));
        });

      test('every unresolved fate is marked, and delivered and withdrawn rows are not', async () => {
        const written = await converted(
          [
            send('d', 'delivered', { evidence: codexSpan(), fateAt: AT }),
            send('a', 'accepted'),
            send('q', 'queued'),
            send('u', 'unaccounted', { unaccountedReason: 'timeout' }),
            send('t', 'timed_out', { unaccountedReason: 'timeout', retryable: true }),
            send('c', 'cancelled'),
            send('h', 'accepted', { held: true }),
            send('w', 'withdrawn', { reason: 'refused' }),
          ],
          null,
          'codex',
        );
        expect(state(written)).toEqual([
          ['d', 'delivered', undefined],
          ['a', 'unaccounted', 'update_unconfirmed'],
          ['q', 'unaccounted', 'update_unconfirmed'],
          ['u', 'unaccounted', 'update_unconfirmed'],
          ['t', 'unaccounted', 'update_unconfirmed'],
          ['c', 'cancelled', 'update_unconfirmed'],
          // A held (revive-retained) send keeps its fate: nothing was typed, and a revive types it itself.
          ['h', 'accepted', 'update_unconfirmed'],
          ['w', 'withdrawn', undefined],
        ]);
      });

      test('a ledger with no claim at all is converted as before', async () => {
        const written = await converted([
          send('a', 'accepted'),
          send('u', 'unaccounted', { unaccountedReason: 'session_ended' }),
        ]);
        expect(state(written)).toEqual([
          ['a', 'accepted', undefined],
          ['u', 'unaccounted', 'ferret_ended'],
        ]);
      });

      test('a Claude drain span of ANOTHER file is not translated onto this transcript, and marks the ledger', async () => {
        const foreign = '/v4/home/runtimes/claude/projects/-work/another-conversation.jsonl#0#198';
        const written = await converted([
          send('first', 'delivered', { evidence: evidence(foreign), fateAt: AT }),
          send('second', 'accepted', second),
        ]);
        expect(written[0]?.evidence?.key).toBe(foreign);
        expect(state(written)).toEqual([
          ['first', 'delivered', undefined],
          ['second', 'unaccounted', 'update_unconfirmed'],
        ]);
      });

      test('a Claude drain span with no known transcript cannot be proved either', async () => {
        const written = await converted(
          [
            send('first', 'delivered', { evidence: evidence(`${V4_PATH}#283#476`) }),
            send('second', 'accepted', second),
          ],
          null,
        );
        expect(written[0]?.evidence?.key).toBe(`${V4_PATH}#283#476`);
        expect(state(written)[1]).toEqual(['second', 'unaccounted', 'update_unconfirmed']);
      });

      test('a span of this ferret’s own transcript is translated and the pending send stays pending', async () => {
        const written = await converted([
          send('first', 'delivered', { evidence: evidence(`${V4_PATH}#283#476`) }),
          send('second', 'accepted', second),
        ]);
        expect(written[0]?.evidence?.key).toBe('queued-prompt:283');
        expect(state(written)[1]).toEqual(['second', 'accepted', undefined]);
      });

      test('a uuid and an invalid span claim nothing in 5.0, so neither marks the ledger', async () => {
        const written = await converted([
          send('a', 'delivered', { evidence: evidence('5f0c2f8e-1a5d-4c53-9a39-0e1d4b1d9c11') }),
          send('b', 'delivered', { evidence: evidence('not-a-span#x#y') }),
          send('c', 'delivered', { evidence: evidence(`/elsewhere.jsonl#99#12`) }),
          send('d', 'accepted', second),
        ]);
        expect(state(written)[3]).toEqual(['d', 'accepted', undefined]);
      });

      test('the report says how many sends were left unconfirmed, in plain words', async () => {
        await f.session('f1', { harness: 'codex' });
        await raw(
          'state/sessions/f1/channel/sends.jsonl',
          jsonl([send('first', 'delivered', { evidence: codexSpan() }), send('second', 'accepted', second)]),
        );
        const report = await conversationStep.run(f.ctx());
        expect(report.note).toContain('1 unresolved send(s) left "unconfirmed — check the chat"');
      });
    });
  });

  test('the send ledger keeps every line in v5’s words: ferret_ended, no payload pointer, no v4 timers', async () => {
    await f.session('f1');
    const payload = join(f.from, 'state/sessions/f1/channel/queued-s2.md');
    await raw('state/sessions/f1/channel/queued-s2.md', `${FAKE_VALUE}\n`);
    await raw(
      'state/sessions/f1/channel/sends.jsonl',
      `${jsonl([
        send('s1', 'accepted'),
        send('s1', 'unaccounted', { unaccountedReason: 'session_ended', hardDeadline: AT, opportunityAt: AT }),
        send('s2', 'queued', { path: 'native-file', payloadFile: payload, batch: [{ queueId: 'q1', from: 'f2' }] }),
        send('s3', 'withdrawn', { reason: 'refused' }),
      ])}{"sendId":"s4",`,
    );
    const report = await conversationStep.run(f.ctx());

    expect(report.status).toBe('converted');
    const written = (await lines(v5SendsFile('f1'))).map(line => V5SendLineSchema.parse(line));
    expect(written.map(line => [line.sendId, line.fate])).toEqual([
      ['s1', 'accepted'],
      ['s1', 'unaccounted'],
      ['s2', 'queued'],
      ['s3', 'withdrawn'],
    ]);
    expect(written[1]).toMatchObject({ unaccountedReason: 'ferret_ended', matchText: 'FAKE match', at: AT });
    expect(written[1]).not.toHaveProperty('hardDeadline');
    expect(written[1]).not.toHaveProperty('opportunityAt');
    expect(written[2]).not.toHaveProperty('payloadFile');
    expect(written[2]?.batch).toEqual([{ queueId: 'q1', from: 'f2' }]);
    expect(written[3]).toMatchObject({ fate: 'withdrawn', reason: 'refused' });
    // Every line is servable: v5's wire projection parses with the contract's SendRecordSchema.
    for (const line of written) SendRecordSchema.parse(v5SendView(line));
    expect(SendRecordSchema.parse(v5SendView(written[3]!))).toMatchObject({ fate: 'accepted', withdrawn: true });
    // The queued payload file has no v5 place and is not copied.
    expect((await readdir(join(f.to, 'state/conversation/f1'))).sort()).toEqual(['sends.jsonl']);
    expect(report.kept).toContainEqual({ what: 'send ledger lines', count: 4 });
    expect(report.kept).toContainEqual({ what: 'sends (latest per send)', count: 3 });
    expect(report.note).toContain('1 send payloadFile pointer(s) dropped');
    expect(JSON.stringify(report)).not.toContain(FAKE_VALUE);
  });

  test('answer receipts, inbox and outbox are copied line for line; the outbox’s question lines are not', async () => {
    await f.session('f1');
    const receipts = [
      { requestId: 'r1', toolUseId: 't1', fingerprint: 'fp', acceptedAt: AT, outcome: 'accepted', at: AT },
      { requestId: 'r1', toolUseId: 't1', fingerprint: 'fp', acceptedAt: AT, outcome: 'confirmed', at: AT },
      {
        requestId: 'r2',
        toolUseId: 't2',
        fingerprint: 'fp',
        acceptedAt: AT,
        outcome: 'accepted',
        resolution: 'failed',
        reason: 'FAKE',
      },
    ];
    await raw('state/sessions/f1/channel/answers.jsonl', jsonl(receipts));
    const inbox = [
      { at: AT, type: 'message', message: 'FAKE in', turn: 2, from: 'f2', fromName: 'arleen' },
      { at: AT, type: 'message', message: 'FAKE queued in', queued: true, queueId: 's9' },
    ];
    await raw('state/sessions/f1/channel/inbox.jsonl', jsonl(inbox));
    const message = { at: AT, type: 'message', from: 'f1', to: 'owner', disposition: 'delivered', message: 'FAKE out' };
    await raw(
      'state/sessions/f1/channel/outbox.jsonl',
      jsonl([message, { at: AT, type: 'question', message: 'FAKE help?' }]),
    );
    const report = await conversationStep.run(f.ctx());

    expect(report.status).toBe('converted');
    const answers = (await lines(v5AnswersFile('f1'))).map(line => V5AnswerLineSchema.parse(line));
    expect(answers).toEqual(receipts.map(r => ({ format: 1, ...r })) as never);
    expect((await lines(v5InboxFile('f1'))).map(line => V5InboxLineSchema.parse(line))).toEqual(
      inbox.map(line => ({ format: 1, ...line })) as never,
    );
    expect((await lines(v5OutboxFile('f1'))).map(line => V5OutboxLineSchema.parse(line))).toEqual([
      { format: 1, ...message },
    ] as never);
    expect(report.kept).toContainEqual({ what: 'answer receipt lines', count: 3 });
    expect(report.kept).toContainEqual({ what: 'answer receipts (latest per request)', count: 2 });
    expect(report.kept).toContainEqual({ what: 'inbox lines', count: 2 });
    expect(report.kept).toContainEqual({ what: 'outbox lines', count: 1 });
    expect(report.note).toContain('1 outbox question line(s) left to Ferrets');
  });

  test('a line v5 refuses is named by file and line, not carried, never quoted', async () => {
    await f.session('f1');
    await raw(
      'state/sessions/f1/channel/outbox.jsonl',
      jsonl([
        { at: AT, type: 'message', from: 'f1', to: 'owner', disposition: 'delivered', message: 'FAKE ok' },
        { at: AT, type: 'message', from: 'f1', to: 'owner', disposition: FAKE_VALUE, message: FAKE_VALUE },
      ]),
    );
    const report = await conversationStep.run(f.ctx());
    expect(report.status).toBe('converted');
    expect(report.note).toContain('v4 log line 2 has no v5 form: state/sessions/f1/channel/outbox.jsonl');
    expect(report.kept).toContainEqual({ what: 'outbox lines', count: 1 });
    expect(JSON.stringify(report)).not.toContain(FAKE_VALUE);
  });

  test('a line longer than the kernel’s line bound is named by file and line, not carried', async () => {
    await f.session('f1');
    const long = 'x'.repeat((1 << 20) + 1);
    await raw('state/sessions/f1/channel/inbox.jsonl', jsonl([{ at: AT, type: 'message', message: long }]));
    const report = await conversationStep.run(f.ctx());
    expect(report.status).toBe('converted');
    expect(report.note).toContain(
      'v4 log line 1 is longer than a v5 line may be: state/sessions/f1/channel/inbox.jsonl',
    );
  });

  test('a bad line in the middle of a v4 log is named by file and line, never the value, and the step still converts', async () => {
    await f.session('f1');
    await raw('state/sessions/f1/channel/sends.jsonl', jsonl([{ sendId: FAKE_VALUE }, send('s1', 'accepted')]));
    const report = await conversationStep.run(f.ctx());
    expect(report.status).toBe('converted');
    expect(report.note).toContain('v4 log line 1 does not match its v4 schema: state/sessions/f1/channel/sends.jsonl');
    expect(JSON.stringify(report)).not.toContain(FAKE_VALUE);
  });

  test('m6: one bad middle line in queue, sends, inbox and outbox is skipped and named; every other line is kept', async () => {
    await f.session('f1');
    const good = (message: string) => ({ at: AT, type: 'message', message });
    await raw(
      'state/sessions/f1/channel/inbox.jsonl',
      jsonl([good('FAKE one'), { not: FAKE_VALUE }, good('FAKE three')]),
    );
    await raw(
      'state/sessions/f1/channel/sends.jsonl',
      jsonl([send('s1', 'accepted'), { sendId: FAKE_VALUE }, send('s2', 'accepted')]),
    );
    const report = await conversationStep.run(f.ctx());
    expect(report.status).toBe('converted');
    expect(report.kept).toContainEqual({ what: 'inbox lines', count: 2 });
    expect(report.kept).toContainEqual({ what: 'send ledger lines', count: 2 });
    expect(report.note).toContain('v4 log line 2 does not match its v4 schema: state/sessions/f1/channel/inbox.jsonl');
    expect(report.note).toContain('v4 log line 2 does not match its v4 schema: state/sessions/f1/channel/sends.jsonl');
    expect(JSON.stringify(report)).not.toContain(FAKE_VALUE);
  });

  test('M1: a damaged middle line of answers.jsonl stops the conversion, naming the file and the remedy', async () => {
    await f.session('f1');
    const receipt = (requestId: string) => ({
      requestId,
      toolUseId: 't1',
      fingerprint: 'fp',
      acceptedAt: AT,
      outcome: 'accepted',
      at: AT,
    });
    await raw('state/sessions/f1/channel/answers.jsonl', jsonl([receipt('r1'), { not: 'a receipt' }, receipt('r2')]));
    const report = await conversationStep.run(f.ctx());
    expect(report.status).toBe('failed');
    expect(report.note).toContain('state/sessions/f1/channel/answers.jsonl');
    expect(report.note).toContain('line 2');
    expect(report.note).toContain('evidence that an answer was already typed');
    expect(report.note).toContain('Repair or remove that line in v4');
  });

  test('M1: an answer receipt with no v5 form also stops the conversion', async () => {
    await f.session('f1');
    // Valid for v4, but longer than a v5 line may be, so it has no v5 form.
    await raw(
      'state/sessions/f1/channel/answers.jsonl',
      jsonl([
        {
          requestId: 'r1',
          toolUseId: 't1',
          fingerprint: 'fp',
          acceptedAt: AT,
          outcome: 'failed',
          reason: 'x'.repeat((1 << 20) + 10),
          at: AT,
        },
      ]),
    );
    const report = await conversationStep.run(f.ctx());
    expect(report.status).toBe('failed');
    expect(report.note).toContain('v4 log line 1 is longer than a v5 line may be');
    expect(report.note).toContain('state/sessions/f1/channel/answers.jsonl');
  });

  test('M1: a torn last answers.jsonl line (a crash during the v4 append) is still skipped', async () => {
    await f.session('f1');
    const line = JSON.stringify({
      requestId: 'r1',
      toolUseId: 't1',
      fingerprint: 'fp',
      acceptedAt: AT,
      outcome: 'accepted',
      at: AT,
    });
    await raw('state/sessions/f1/channel/answers.jsonl', `${line}\n{"requestId":"r2","tool`);
    const report = await conversationStep.run(f.ctx());
    expect(report.status).toBe('converted');
    expect(report.kept).toContainEqual({ what: 'answer receipt lines', count: 1 });
  });

  test('a live ferret’s open question is stored parsed, against its transcript in the new home', async () => {
    await claudeFerret('f1');
    await f.put(
      'state/sessions/f1/question-asked.json',
      asked([
        {
          question: 'FAKE which?',
          header: 'Pick',
          options: [{ label: 'Yes', description: 'FAKE yes' }, { label: 'No' }],
          multiSelect: true,
        },
      ]),
    );
    const time = new Date('2026-10-03T04:05:06.000Z');
    await utimes(join(f.from, 'state/sessions/f1/question-asked.json'), time, time);
    const report = await conversationStep.run(f.ctx());

    expect(report.status).toBe('converted');
    expect(v5QuestionFile('f1')).toBe('state/conversation/f1/question.json');
    const question = QuestionSchema.parse(JSON.parse(await readFile(join(f.to, v5QuestionFile('f1')), 'utf8')));
    expect(question).toMatchObject({
      format: 1,
      toolUseId: 'toolu_1',
      header: 'Pick',
      text: 'FAKE which?',
      options: [{ label: 'Yes', description: 'FAKE yes' }, { label: 'No' }],
      multiple: true,
      askedAt: time.toISOString(),
    });
    expect(question.transcript?.startsWith(f.to)).toBe(true);
    expect(question.transcript?.endsWith(join('_shared', 'projects/p/c.jsonl'))).toBe(true);
    expect(report.kept).toContainEqual({ what: 'open questions', count: 1 });
  });

  test('a question v5’s writer would not store is left to the transcript, and an ended ferret’s is not read', async () => {
    await claudeFerret('several');
    await f.put(
      'state/sessions/several/question-asked.json',
      asked([{ question: 'FAKE a?' }, { question: 'FAKE b?' }]),
    );
    await claudeFerret('elsewhere');
    await f.put('state/sessions/elsewhere/question-asked.json', asked([{ question: 'FAKE?' }], '/fake/subagent.jsonl'));
    await f.session('ended');
    await f.put('state/sessions/ended/state.json', { id: 'ended', status: 'completed' });
    await f.put('state/sessions/ended/question-asked.json', { not: 'checked for an ended ferret' });
    const report = await conversationStep.run(f.ctx());

    expect(report.status).toBe('converted');
    for (const ferret of ['several', 'elsewhere', 'ended']) expect(await exists(v5QuestionFile(ferret))).toBe(false);
    expect(report.kept).toContainEqual({ what: 'open questions', count: 0 });
    expect(report.note).toContain('2 open question(s) v5 would not store');
  });

  test('attachments: the original byte for byte, the manifest as v5’s store writes it, no <daemonId>', async () => {
    await f.session('f1');
    const bytes = Buffer.from(`\u0000\u0001${FAKE_VALUE}ÿ`, 'latin1');
    const id = await putAttachment('daemon1', 'f1', bytes, { encrypted: { kind: 'pdf' } });
    // The same content under an older daemon identity is the same attachment (the first in name order is kept).
    await putAttachment('daemon0', 'f1', bytes, { encrypted: { kind: 'pdf' } });
    const time = new Date('2026-10-04T00:00:00.000Z');
    for (const daemon of ['daemon0', 'daemon1'])
      await utimes(join(f.from, `state/attachments/${daemon}/f1/${id}/original`), time, time);
    // A ferret v4 no longer knows, and an upload cut short before its manifest.
    await putAttachment('daemon1', 'gone', Buffer.from('FAKE orphan'));
    await raw('state/attachments/daemon1/f1/att_torn/original', Buffer.from('FAKE torn'));
    const report = await conversationStep.run(f.ctx());

    expect(report.status).toBe('converted');
    expect(v5AttachmentOriginal('f1', id)).toBe(`state/conversation/attachments/f1~${id}.original`);
    const original = join(f.to, v5AttachmentOriginal('f1', id));
    expect(Buffer.compare(await readFile(original), bytes)).toBe(0);
    expect((await stat(original)).mode & 0o777).toBe(0o600);
    expect((await stat(original)).mtime.toISOString()).toBe(time.toISOString());
    const manifest = await readFile(join(f.to, v5AttachmentManifest('f1', id)), 'utf8');
    expect(manifest).toBe(`${JSON.stringify({ ...attachment(bytes).manifest, encrypted: { kind: 'pdf' } })}\n`);
    expect((await readdir(join(f.to, 'state/conversation/attachments'))).sort()).toEqual(
      [`f1~${id}.manifest`, `f1~${id}.original`].sort(),
    );
    expect(report.kept).toContainEqual({ what: 'attachments (original moved unopened)', count: 1 });
    expect(report.note).toContain('1 attachment(s) of no ferret omitted');
    expect(report.note).toContain('1 attachment original(s) with no manifest omitted');
    expect(report.note).toContain('1 duplicate attachment(s) under another daemon id omitted');
    expect(JSON.stringify(report)).not.toContain(FAKE_VALUE);
  });

  test('an attachment v5 would read as corrupt is named and not carried, naming the attachment only', async () => {
    await f.session('f1');
    await f.put('state/attachments/daemon1/f1/att_1/manifest.json', {
      id: 'att_1',
      filename: FAKE_VALUE,
      mime: 'image/png',
      size: 4,
      sha256: 'b'.repeat(64),
      createdAt: AT,
    });
    await raw('state/attachments/daemon1/f1/att_1/original', Buffer.from([0, 1, 2, 3]));
    const report = await conversationStep.run(f.ctx());
    expect(report.status).toBe('converted');
    expect(report.note).toContain('attachment manifest has no v5 form: state/attachments/<daemonId>/f1/att_1');
    expect(JSON.stringify(report)).not.toContain(FAKE_VALUE);
  });

  test('an attachment without its original is counted and named, nothing is carried for it, and the good one is', async () => {
    await f.session('f1');
    const bad = attachment(Buffer.from('FAKE'));
    await f.put(`state/attachments/daemon1/f1/${bad.id}/manifest.json`, bad.manifest);
    const goodBytes = Buffer.from('FAKE good file');
    await putAttachment('daemon1', 'f1', goodBytes);
    const report = await conversationStep.run(f.ctx());
    expect(report.status).toBe('converted');
    expect(report.note).toContain(
      `1 attachments with no original file (not carried; v5 keeps no manifest without its original): state/attachments/<daemonId>/f1/${bad.id}`,
    );
    expect(report.kept).toContainEqual({ what: 'attachments (original moved unopened)', count: 1 });
    expect(await exists(v5AttachmentManifest('f1', bad.id))).toBe(false);
  });

  test('renders: the meta through StoredRenderMetaSchema with author.ferret, the payload byte for byte, unsharded', async () => {
    await f.session('f1');
    await f.put('state/renders/ab/abcdef.json', renderMeta('abcdef', { supersedes: 'abzzzz' }));
    await raw('state/renders/ab/abcdef.payload', `<svg>${FAKE_VALUE}</svg>`);
    await raw('state/renders/zz/zzzzzz.payload', 'FAKE torn save');
    const report = await conversationStep.run(f.ctx());

    expect(report.status).toBe('converted');
    expect(v5RenderMeta('abcdef')).toBe('state/conversation/renders/abcdef.json');
    const text = await readFile(join(f.to, v5RenderMeta('abcdef')), 'utf8');
    expect(text.startsWith('{\n  "format": 1,')).toBe(true);
    const { format, ...meta } = JSON.parse(text) as Record<string, unknown>;
    expect(format).toBe(1);
    expect(StoredRenderMetaSchema.parse(meta)).toEqual({
      ...renderMeta('abcdef', { supersedes: 'abzzzz' }),
      author: { ferret: 'f1' },
    } as never);
    expect(await readFile(join(f.to, v5RenderPayload('abcdef')), 'utf8')).toBe(`<svg>${FAKE_VALUE}</svg>`);
    expect((await readdir(join(f.to, 'state/conversation/renders'))).sort()).toEqual(['abcdef.json', 'abcdef.payload']);
    expect(report.kept).toContainEqual({ what: 'renders (payload moved unopened)', count: 1 });
    expect(report.note).toContain('1 render payload(s) with no meta omitted');
    expect(JSON.stringify(report)).not.toContain(FAKE_VALUE);
  });

  test('a render with no author stays authorless', async () => {
    await f.put('state/renders/ab/abcdef.json', renderMeta('abcdef', { author: {} }));
    await raw('state/renders/ab/abcdef.payload', '<svg/>');
    const report = await conversationStep.run(f.ctx());
    expect(report.status).toBe('converted');
    expect(JSON.parse(await readFile(join(f.to, v5RenderMeta('abcdef')), 'utf8')).author).toEqual({});
  });

  test('nothing of a message, payload or attachment reaches the report', async () => {
    await live('f1');
    await raw(
      'state/sessions/f1/channel/queue.jsonl',
      jsonl([{ v: 1, kind: 'enqueued', at: AT, message: queued('q1', FAKE_VALUE) }]),
    );
    await raw('state/sessions/f1/channel/sends.jsonl', jsonl([send('s1', 'delivered', { message: FAKE_VALUE })]));
    await raw('state/sessions/f1/channel/inbox.jsonl', jsonl([{ at: AT, type: 'message', message: FAKE_VALUE }]));
    await raw(
      'state/sessions/f1/channel/outbox.jsonl',
      jsonl([{ at: AT, type: 'message', from: 'f1', to: 'owner', disposition: 'sent', message: FAKE_VALUE }]),
    );
    await raw('state/sessions/f1/turns/turn-001.md', FAKE_VALUE);
    await putAttachment('daemon1', 'f1', Buffer.from(FAKE_VALUE));
    await f.put('state/renders/ab/abcdef.json', renderMeta('abcdef', { alt: FAKE_VALUE }));
    await raw('state/renders/ab/abcdef.payload', FAKE_VALUE);
    const report = await conversationStep.run(f.ctx());
    expect(report.status).toBe('converted');
    expect(JSON.stringify(report)).not.toContain(FAKE_VALUE);
  });

  test('a dry run reports what it would carry and writes nothing', async () => {
    await raw('state/session-message-token.key', FAKE_KEY);
    await live('f1');
    await raw('state/sessions/f1/turns/turn-001.md', '# FAKE\n');
    await f.put('state/shared-drafts/f1.json', draft('f1'));
    await raw('state/sessions/f1/channel/sends.jsonl', jsonl([send('s1', 'delivered')]));
    await putAttachment('daemon1', 'f1', Buffer.from('FAKE'));
    await f.put('state/renders/ab/abcdef.json', renderMeta('abcdef'));
    await raw('state/renders/ab/abcdef.payload', '<svg/>');
    const report = await conversationStep.run(f.ctx(true));
    expect(report.sealed).toEqual([{ file: V5_MESSAGE_TOKEN_KEY_FILE, bytes: 32 }]);
    expect(report.kept).toContainEqual({ what: 'send ledger lines', count: 1 });
    expect(report.kept).toContainEqual({ what: 'attachments (original moved unopened)', count: 1 });
    expect(report.kept).toContainEqual({ what: 'renders (payload moved unopened)', count: 1 });
    expect(report.note).toContain('dry run: nothing written');
    expect(await stat(join(f.to, 'state')).catch(() => undefined)).toBeUndefined();
  });

  test('an empty home is converted with nothing kept', async () => {
    const report = await conversationStep.run(f.ctx());
    expect(report.status).toBe('converted');
    expect(report.note).toBeUndefined();
    expect(report.sealed).toEqual([]);
    expect(report.kept.every(item => item.count === 0)).toBe(true);
  });
});

describe('v4 conversation readers', () => {
  test('the queue fold applies only legal moves, like v4', () => {
    const messages = foldV4Queue([
      { v: 1, kind: 'enqueued', at: AT, message: queued('q1') as never },
      { v: 1, kind: 'enqueued', at: AT, message: queued('q1') as never },
      { v: 1, kind: 'edited', at: AT, id: 'q1', text: 'edited', revision: 2 },
      { v: 1, kind: 'moved', at: AT, id: 'q1', state: 'read' },
      { v: 1, kind: 'moved', at: AT, id: 'q1', state: 'typing', batch: 'q1' },
    ]);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ text: 'edited', revision: 2, state: 'typing', deliveredAs: 'q1', version: 5 });
  });

  test('the send ledger keeps the last line per send, in first-seen order', () => {
    const lines = [send('a', 'accepted'), send('b', 'accepted'), send('a', 'delivered')].map(line =>
      V4SendLine.parse(line),
    );
    expect(latestV4Sends(lines).map(line => [line.sendId, line.fate])).toEqual([
      ['a', 'delivered'],
      ['b', 'accepted'],
    ]);
  });
});
