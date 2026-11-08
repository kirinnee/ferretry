import { afterEach, describe, expect, test } from 'bun:test';
import { lstat, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type { RootHandle } from '@ferretry/kernel/contract';
import { diskSessionsRoots, type DiskSessionsRoots } from '@ferretry/kernel/testing';
import { FERRET_SESSIONS_FOLDER, ferretTurnFile } from '../../../../contract/sessions-root.ts';
import { FileResumeTurnStore } from '../../../../daemon/adapters/session/resume/file-resume-turn-store.ts';
import { FileSessionTransferBriefWriter } from '../../../../daemon/adapters/transfer/brief-writer.ts';
import { parseSessionId } from '../../../../daemon/lib/session-id.ts';

/**
 * The transferred ferret's first-turn brief, on a REAL disk: it is the target's own `turns/turn-001.md` on the
 * internal `sessions` root, the very file the turn reader reads (never a second copy on the state port). Fixture
 * values only.
 */

const TARGET = parseSessionId('mw7bp88g-7a26e700');
const parents: string[] = [];
afterEach(async () => {
  for (const parent of parents.splice(0)) await rm(parent, { recursive: true, force: true });
});

interface Subject {
  readonly home: string;
  readonly sessions: DiskSessionsRoots;
  /** Every read and publish the writer made through the root, in order. */
  readonly calls: string[];
  readonly writer: FileSessionTransferBriefWriter;
}

/** A writer over a real `sessions` root, its reads and publishes observed (and `afterPublish` run once each lands). */
async function subject(afterPublish: () => Promise<void> | void = () => undefined): Promise<Subject> {
  const parent = await mkdtemp(`${tmpdir()}/fy-brief-`);
  parents.push(parent);
  const sessions = await diskSessionsRoots(parent);
  const calls: string[] = [];
  const observed = (real: RootHandle): RootHandle => ({
    ...real,
    readBytes: async (path, limit) => {
      calls.push('read');
      return await real.readBytes(path, limit);
    },
    publish: async (path, bytes, options) => {
      calls.push('write');
      const published = await real.publish(path, bytes, options);
      await afterPublish();
      return published;
    },
  });
  return {
    home: `${parent}/home`,
    sessions,
    calls,
    writer: new FileSessionTransferBriefWriter(id => observed(sessions.root(id))),
  };
}

const briefFile = (s: Subject) => `${s.sessions.folderOf(TARGET)}/turns/turn-001.md`;

describe('FileSessionTransferBriefWriter: the brief is the target’s turn one on the sessions root', () => {
  test('the declared transfer file IS the file the turn reader reads: the same root, the same name', async () => {
    const s = await subject();
    const document = '# Frozen transfer brief\n';

    const file = await s.writer.write(TARGET, document);

    // The same name: what the agent is told to read, what the turn store names, and the contract's layout.
    const turns = new FileResumeTurnStore(s.sessions.root(TARGET), TARGET);
    expect(file).toBe(s.writer.file(TARGET));
    expect(file).toBe(turns.file(TARGET, 1));
    expect(file).toBe(`${s.home}/${FERRET_SESSIONS_FOLDER}/${TARGET}/${ferretTurnFile(1)}`);
    // The same bytes, read back by the turn reader as the ferret's turn one.
    expect(await turns.list(TARGET, { strict: true })).toEqual([{ turn: 1, text: document }]);
    expect((await lstat(file)).mode & 0o777).toBe(0o600);
    expect((await lstat(s.sessions.folderOf(TARGET))).mode & 0o777).toBe(0o700);
  });

  test('publishes, then confirms the name holds what it published', async () => {
    const s = await subject();

    await s.writer.write(TARGET, '# Ordered publication\n');

    // Nothing to vouch for yet (no folder: no read at all), the publish, then the name read back.
    expect(s.calls).toEqual(['write', 'read']);
  });

  test('a matching replay is proved, republished and confirmed, and answers the same file', async () => {
    const s = await subject();
    const document = '# Same persisted plan\n';
    const file = await s.writer.write(TARGET, document);
    s.calls.length = 0;

    expect(await s.writer.write(TARGET, document)).toBe(file);

    expect(s.calls).toEqual(['read', 'write', 'read']);
    expect(await readFile(briefFile(s), 'utf8')).toBe(document);
  });

  test('a torn partial brief is replaced by the document the plan renders', async () => {
    const s = await subject();
    await mkdir(`${s.sessions.folderOf(TARGET)}/turns`, { recursive: true, mode: 0o700 });
    await writeFile(briefFile(s), '# Frozen transfer', { mode: 0o600 });

    await s.writer.write(TARGET, '# Frozen transfer brief\n\nComplete.\n');

    expect(await readFile(briefFile(s), 'utf8')).toBe('# Frozen transfer brief\n\nComplete.\n');
  });

  test('the pre-launch proof is read only: it makes no folder and writes nothing', async () => {
    const s = await subject();

    expect(await s.writer.matches(TARGET, '# Frozen transfer brief\n')).toBe(false);
    await expect(stat(s.sessions.folderOf(TARGET))).rejects.toThrow();

    await s.writer.write(TARGET, '# Frozen transfer brief\n');
    s.calls.length = 0;
    expect(await s.writer.matches(TARGET, '# Frozen transfer brief\n')).toBe(true);
    expect(await s.writer.matches(TARGET, '# A different document\n')).toBe(false);
    expect(s.calls.filter(call => call === 'write')).toEqual([]);
  });

  test('one writer replacing the name mid-publication is re-proved; one that always does fails closed', async () => {
    let substitutions = 1;
    let target = '';
    const once = await subject(async () => {
      if (substitutions-- > 0) await writeFile(target, '# someone else\n');
    });
    target = briefFile(once);
    await once.writer.write(TARGET, '# Frozen transfer brief\n');
    expect(await readFile(target, 'utf8')).toBe('# Frozen transfer brief\n');

    let hostileTarget = '';
    const hostile = await subject(async () => {
      await writeFile(hostileTarget, '# someone else\n');
    });
    hostileTarget = briefFile(hostile);
    await expect(hostile.writer.write(TARGET, '# Frozen transfer brief\n')).rejects.toThrow(
      'replaced by another writer',
    );
  });

  test('an unusable target key is refused before any path is resolved or anything is read', async () => {
    const s = await subject();

    await expect(s.writer.write('../source-session', 'never written')).rejects.toThrow(
      'target session id is not usable',
    );
    expect(() => s.writer.file('UPPER-case')).toThrow('target session id is not usable');
    expect(s.calls).toEqual([]);
  });
});
