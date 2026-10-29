/**
 * The filesystem half of keeping existing conversations as ferrets, against a temp HOME holding FAKE
 * Claude and Codex conversation files. No real CLI home is ever read.
 *
 * What only this tier proves: that discovery never follows a link, that a runtime's history names the
 * owner's file by a HARD link (one inode — so the CLI appends to the owner's file and Chat reads the
 * same bytes) without changing a byte of it, and that the session store answers who already keeps a
 * conversation.
 */
import { afterEach, describe, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import {
  BunSqliteIndexFactory,
  DaemonStorageFactory,
  KeyedSerialExecutor,
  NodeConversationFiles,
  NodeConversationLinker,
  RuntimeEnvironment,
  SqliteHomeLockFactory,
  StateFileSystemFactory,
  StateHomeLayout,
  StorageConversationOwners,
  StorageTranscriptClaims,
  SystemClock,
} from '../../../src/adapters/index.ts';
import { LOOP_PARSE_PACING } from '../../../src/adapters/transcript/index.ts';
import {
  ConversationImportService,
  conversationKey,
  FileConversationDescriber,
  parseSessionId,
} from '../../../src/lib/index.ts';
import {
  ClaudeTranscriptParser,
  CodexTranscriptParser,
  PacedTranscriptParser,
} from '../../../src/lib/transcript/index.ts';

const NOW = '2026-10-18T10:00:00.000Z';
const CLAUDE_ID = '11111111-1111-4111-8111-111111111111';
const CODEX_ID = '33333333-3333-4333-8333-333333333333';
const directories = new Set<string>();

afterEach(async () => {
  for (const directory of directories) await rm(directory, { recursive: true, force: true });
  directories.clear();
});

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  directories.add(directory);
  return directory;
}

const claudeLine = (text: string): string =>
  JSON.stringify({
    type: 'user',
    sessionId: CLAUDE_ID,
    cwd: '/work/shop',
    timestamp: '2026-10-17T08:01:00.000Z',
    message: { role: 'user', content: text },
  });

/** A fake HOME: one Claude conversation, one Codex rollout, and a link discovery must not follow. */
async function fakeHome(): Promise<{ readonly home: string; readonly claudeFile: string; readonly codexFile: string }> {
  const home = await temporaryDirectory('ferretry-conversations-home-');
  const project = join(home, '.claude', 'projects', '-work-shop');
  const day = join(home, '.codex', 'sessions', '2026', '10', '10');
  const outside = join(home, 'outside');
  await Promise.all([mkdir(project, { recursive: true }), mkdir(day, { recursive: true }), mkdir(outside)]);
  const claudeFile = join(project, `${CLAUDE_ID}.jsonl`);
  const codexFile = join(day, `rollout-2026-10-10T09-00-00-${CODEX_ID}.jsonl`);
  await writeFile(claudeFile, `${claudeLine('Fix the cart total')}\n`);
  await writeFile(
    codexFile,
    `${[
      JSON.stringify({
        type: 'session_meta',
        timestamp: '2026-10-10T09:00:00.000Z',
        payload: { id: CODEX_ID, cwd: '/work/notes' },
      }),
      JSON.stringify({
        type: 'response_item',
        timestamp: '2026-10-10T09:01:00.000Z',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Draft the notes' }] },
      }),
    ].join('\n')}\n`,
  );
  await writeFile(join(outside, `${CLAUDE_ID}.jsonl`), `${claudeLine('must not be found')}\n`);
  await symlink(outside, join(home, '.claude', 'projects', '-linked'));
  return { home, claudeFile, codexFile };
}

async function openTemporaryStorage() {
  const home = await temporaryDirectory('ferretry-conversations-state-');
  const factory = new DaemonStorageFactory(
    new RuntimeEnvironment({ FY_HOME: home }, () => '/home-must-not-be-used'),
    new StateFileSystemFactory(),
    new StateHomeLayout(),
    new SqliteHomeLockFactory(),
    new BunSqliteIndexFactory(),
    new SystemClock(() => new Date(NOW)),
    () => new KeyedSerialExecutor(),
  );
  return (await factory.open()).storage;
}

describe('discovering conversations on disk', () => {
  it('should list a fake home’s Claude and Codex conversations without following a link', async () => {
    // Arrange
    const { home } = await fakeHome();
    const files = new NodeConversationFiles();
    const service = new ConversationImportService(
      files,
      [
        { harness: 'claude', home: join(home, '.claude'), source: 'computer' },
        { harness: 'codex', home: join(home, '.codex'), source: 'computer' },
        { harness: 'codex', home: join(home, 'absent'), source: 'ferretry' },
      ],
      new FileConversationDescriber(files, {
        claude: new PacedTranscriptParser(new ClaudeTranscriptParser(), LOOP_PARSE_PACING),
        codex: new PacedTranscriptParser(new CodexTranscriptParser(), LOOP_PARSE_PACING),
      }),
      { owners: async () => new Map() },
      { adopt: async () => ({ kind: 'refused', code: 'failed', reason: 'not under test' }) },
    );

    // Act
    const listing = await service.list();

    // Assert
    should(listing.conversations.map(row => [row.harness, row.id, row.project, row.preview])).deepEqual([
      ['claude', CLAUDE_ID, '/work/shop', 'Fix the cart total'],
      ['codex', CODEX_ID, '/work/notes', 'Draft the notes'],
    ]);
    should(JSON.stringify(listing)).not.containEql('must not be found');
    should(listing.skipped).equal(0);
  });

  it('should report a missing file and a folder as having no information', async () => {
    // Arrange
    const { home } = await fakeHome();
    const files = new NodeConversationFiles();

    // Act & Assert
    should(await files.info(join(home, 'missing.jsonl'))).be.undefined();
    should(await files.info(join(home, '.claude'))).be.undefined();
    should(await files.tail(join(home, 'missing.jsonl'), 5)).be.undefined();
    should(await files.entries(join(home, 'missing'))).deepEqual([]);
  });

  it('should read at most the first bytes of a document, and nothing for a missing file or a folder', async () => {
    // Arrange
    const { home, claudeFile } = await fakeHome();
    const files = new NodeConversationFiles();

    // Act & Assert
    should(await files.head(claudeFile, 5)).equal((await Bun.file(claudeFile).text()).slice(0, 5));
    should(await files.head(join(home, 'missing.md'), 5)).be.undefined();
    should(await files.head(join(home, '.claude'), 5)).be.undefined();
  });

  it('should read at most the last bytes of a document, and nothing for a missing file or a folder', async () => {
    // Arrange
    const { home, claudeFile } = await fakeHome();
    const files = new NodeConversationFiles();
    const whole = await Bun.file(claudeFile).text();

    // Act & Assert
    should(await files.tail(claudeFile, 5)).equal(whole.slice(-5));
    should(await files.tail(claudeFile, whole.length + 100)).equal(whole);
    should(await files.tail(join(home, 'missing.md'), 5)).be.undefined();
    should(await files.tail(join(home, '.claude'), 5)).be.undefined();
  });
});

describe('linking a conversation into a runtime’s history', () => {
  it('should name the owner’s own file by a hard link, leave it unchanged, and then find it present', async () => {
    // Arrange: a runtime home whose `projects` is a link into a shared pool, as Ferretry provisions it.
    const { claudeFile } = await fakeHome();
    const fy = await temporaryDirectory('ferretry-conversations-fy-');
    const pool = join(fy, 'fleet', 'shared', 'claude', 'projects');
    const runtime = join(fy, 'fleet', 'homes', 'r1');
    await mkdir(pool, { recursive: true });
    await mkdir(runtime, { recursive: true });
    await symlink(pool, join(runtime, 'projects'));
    const before = await readFile(claudeFile, 'utf8');
    const relative = join('projects', '-work-shop', `${CLAUDE_ID}.jsonl`);
    const linker = new NodeConversationLinker();

    // Act
    const first = await linker.link(claudeFile, runtime, relative);
    const again = await linker.link(claudeFile, runtime, relative);

    // Assert
    should([first, again]).deepEqual([{ kind: 'linked' }, { kind: 'present' }]);
    const [source, linked] = await Promise.all([
      stat(claudeFile),
      stat(join(pool, '-work-shop', `${CLAUDE_ID}.jsonl`)),
    ]);
    should([linked.ino, linked.dev]).deepEqual([source.ino, source.dev]);
    should(await readFile(claudeFile, 'utf8')).equal(before);
  });

  it('should refuse a different file under the same name, and a runtime with no history folder', async () => {
    // Arrange
    const { claudeFile, codexFile } = await fakeHome();
    const runtime = await temporaryDirectory('ferretry-conversations-runtime-');
    await mkdir(join(runtime, 'projects', '-work-shop'), { recursive: true });
    await writeFile(join(runtime, 'projects', '-work-shop', `${CLAUDE_ID}.jsonl`), 'someone else');
    const linker = new NodeConversationLinker();

    // Act
    const conflict = await linker.link(claudeFile, runtime, join('projects', '-work-shop', `${CLAUDE_ID}.jsonl`));
    const noFolder = await linker.link(codexFile, runtime, join('sessions', '2026', 'x.jsonl'));
    const unreachable = await linker.link(join(runtime, 'missing.jsonl'), runtime, join('projects', 'p', 'y.jsonl'));

    // Assert
    should(conflict).containDeep({ kind: 'conflict' });
    should(noFolder).containDeep({
      kind: 'unavailable',
      reason: 'The runtime has no history folder yet; start it once, then try again.',
    });
    should(unreachable).deepEqual({
      kind: 'unavailable',
      reason: 'The runtime could not reach the conversation file (ENOENT).',
    });
  });
});

describe('who already keeps a conversation', () => {
  it('should read each session’s transcript record, and an adopted one is claimed against discovery', async () => {
    // Arrange
    const storage = await openTemporaryStorage();
    const adopted = parseSessionId('20261018-adopted');
    const fresh = parseSessionId('20261018-fresh');
    const pending = parseSessionId('20261018-pending');
    await storage.writeConfig(adopted, {
      id: adopted,
      harness: 'codex',
      transcript: { v: 1, home: '/h', harnessSessionId: CODEX_ID, identity: 'adopted', file: '/f', resolvedAt: NOW },
    });
    await storage.writeConfig(fresh, {
      id: fresh,
      harness: 'claude',
      transcript: { v: 1, home: '/h', harnessSessionId: CLAUDE_ID, identity: 'minted', file: '/g', resolvedAt: NOW },
    });
    await storage.writeConfig(pending, { id: pending, harness: 'gemini' });

    // Act
    const owners = await new StorageConversationOwners(storage).owners();
    const claimed = await new StorageTranscriptClaims(storage).claimed('20261018-other');

    // Assert
    should([...owners.entries()].sort()).deepEqual(
      [
        [conversationKey('claude', CLAUDE_ID), fresh],
        [conversationKey('codex', CODEX_ID), adopted],
      ].sort(),
    );
    should(claimed).deepEqual([CODEX_ID]);
    await storage.close();
  });
});
