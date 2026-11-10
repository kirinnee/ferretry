/**
 * Lessons' small adapters: how a ferret is seen (Ferrets as its contract fake, Conversation as the thing it answers
 * with), how a ferret's switch reaches it, the unpriced estimate, and the owner's save of `lessons.yaml` through the
 * kernel's REAL configuration service on a real disk.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeFerrets, ferretId } from '@ferretry/core-ferrets/contract/testing';
import type { Log } from '@ferretry/kernel/contract';
import { createConfigFiles } from '../../../../core/kernel/host/config/service.ts';
import { createNodeHostFs } from '../../../../core/kernel/host/state/host-fs.ts';
import { LESSONS_CONFIG } from '../../contract/index.ts';
import { writeLessonsSettings } from '../../daemon/adapters/config-writer.ts';
import { FerretLessonSessions, LESSONS_MINER_NAME, lessonSessionFacts } from '../../daemon/adapters/ferret-sessions.ts';
import { UnpricedModels } from '../../daemon/adapters/no-prices.ts';
import { ConversationPassiveChannel } from '../../daemon/adapters/passive-channel.ts';

const homes: string[] = [];
afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

const T1 = '2026-11-09T10:00:00.000Z';
const T2 = '2026-11-09T10:05:00.000Z';

const transcriptOf = (messages: { role: 'user' | 'assistant'; text: string; timestamp?: string }[]) => ({
  transcript: async () => ({ ok: true as const, value: { messages } }),
});

describe('lessonSessionFacts', () => {
  it('reads a lead as interactive and a helper as automatic, carrying the helper’s name as its teammate', () => {
    const ferrets = new FakeFerrets();
    const lead = ferrets.add({ id: ferretId('lead') });
    const helper = ferrets.add({ id: ferretId('helper'), parent: ferretId('lead'), name: 'Reviewer' });

    expect(lessonSessionFacts(lead)).toMatchObject({ mode: 'interactive', harness: 'claude', running: true });
    expect(lessonSessionFacts(lead).teammate).toBeUndefined();
    expect(lessonSessionFacts(helper)).toMatchObject({ mode: 'auto', teammate: 'Reviewer' });
  });

  it('names a codex ferret, a stopped ferret, a recorded conversation and the scan’s own miner', () => {
    const ferrets = new FakeFerrets();
    const codex = ferrets.add({
      id: ferretId('codex-one'),
      harness: 'codex',
      state: 'stopped',
      harnessConversation: 'conversation-1',
    } as never);
    const miner = ferrets.add({ id: ferretId('miner'), name: LESSONS_MINER_NAME });

    expect(lessonSessionFacts(codex)).toMatchObject({ harness: 'codex', running: false, hasTranscript: true });
    expect(lessonSessionFacts(miner)).toMatchObject({ label: 'ferretry-lessons', hasTranscript: false });
    expect(lessonSessionFacts(codex).label).toBeUndefined();
  });
});

describe('FerretLessonSessions', () => {
  const sessions = (ferrets: FakeFerrets, conversation: object) =>
    new FerretLessonSessions(ferrets, conversation as never);

  it('answers a ferret’s facts, or nothing for a ferret that does not exist', async () => {
    const ferrets = new FakeFerrets();
    ferrets.add({ id: ferretId('f1'), folder: '/work/one' });

    expect(await sessions(ferrets, {}).facts('f1')).toMatchObject({ ferretId: 'f1', cwd: '/work/one' });
    expect(await sessions(ferrets, {}).facts('nobody')).toBeUndefined();
  });

  it('lists every ferret as lessons see it', async () => {
    const ferrets = new FakeFerrets();
    ferrets.add({ id: ferretId('f1') });
    ferrets.add({ id: ferretId('f2') });

    expect((await sessions(ferrets, {}).list()).map(facts => facts.ferretId)).toEqual(['f1', 'f2']);
  });

  it('answers the last thing the owner typed and which owner turn it was', async () => {
    const conversation = transcriptOf([
      { role: 'user', text: 'first', timestamp: T1 },
      { role: 'assistant', text: 'ok', timestamp: T1 },
      { role: 'user', text: 'Use bun, not Python.', timestamp: T2 },
      { role: 'assistant', text: 'done', timestamp: T2 },
    ]);

    expect(await sessions(new FakeFerrets(), conversation).latestOwnerMessage('f1')).toEqual({
      text: 'Use bun, not Python.',
      at: T2,
      turn: 2,
    });
  });

  it('answers nothing when the transcript cannot be read, has no owner turn, or ends on a blank or undated one', async () => {
    const unreadable = { transcript: async () => ({ ok: false as const, error: { message: 'no transcript' } }) };

    expect(await sessions(new FakeFerrets(), unreadable).latestOwnerMessage('f1')).toBeUndefined();
    expect(
      await sessions(new FakeFerrets(), transcriptOf([{ role: 'assistant', text: 'hi' }])).latestOwnerMessage('f1'),
    ).toBeUndefined();
    expect(
      await sessions(
        new FakeFerrets(),
        transcriptOf([{ role: 'user', text: '   ', timestamp: T1 }]),
      ).latestOwnerMessage('f1'),
    ).toBeUndefined();
    expect(
      await sessions(new FakeFerrets(), transcriptOf([{ role: 'user', text: 'no time' }])).latestOwnerMessage('f1'),
    ).toBeUndefined();
  });
});

describe('ConversationPassiveChannel', () => {
  it('sets no environment at all: the switch is read at each launch', async () => {
    expect(await new ConversationPassiveChannel({ send: async () => ({ ok: true }) } as never).setEnvironment()).toBe(
      undefined,
    );
  });

  it('tells a running ferret with a queued owner message and answers the send’s id', async () => {
    const sent: unknown[] = [];
    const conversation = {
      send: async (...args: unknown[]) => {
        sent.push(args);
        return { ok: true as const, value: { sendId: 'send-7', disposition: 'queued' } };
      },
    };

    expect(await new ConversationPassiveChannel(conversation as never).reinstruct('f1', 'File lessons.')).toBe(
      'send-7',
    );
    expect(sent).toEqual([['f1', { kind: 'owner' }, { message: 'File lessons.' }]]);
  });

  it('names the disposition when the send has no id, and refuses with the sentence when it is not accepted', async () => {
    const anonymous = { send: async () => ({ ok: true as const, value: { disposition: 'delivered' } }) };
    const refused = { send: async () => ({ ok: false as const, error: { message: 'that ferret is stopped' } }) };

    expect(await new ConversationPassiveChannel(anonymous as never).reinstruct('f1', 'x')).toBe('lessons-delivered');
    await expect(new ConversationPassiveChannel(refused as never).reinstruct('f1', 'x')).rejects.toThrow(
      'that ferret is stopped',
    );
  });
});

describe('UnpricedModels', () => {
  it('reports no price for any model: never a guess', async () => {
    expect(await new UnpricedModels().usd()).toBeUndefined();
  });
});

const silentLog: Log = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silentLog,
};

/** The kernel's configuration service over a fresh temp home that may already hold a `lessons.yaml`. */
async function configWorld(lessonsYaml?: string) {
  const home = await mkdtemp(join(tmpdir(), 'fy-lessons-config-'));
  homes.push(home);
  await mkdir(join(home, 'config'), { recursive: true });
  const path = join(home, 'config', 'lessons.yaml');
  if (lessonsYaml !== undefined) await writeFile(path, lessonsYaml);
  const files = createConfigFiles({
    home,
    fs: createNodeHostFs(),
    clock: { nowMs: () => 1_000_000, after: () => () => undefined, every: () => () => undefined } as never,
    log: silentLog,
    binary: 'fy',
    defs: [{ plugin: 'lessons', def: LESSONS_CONFIG as never }],
  });
  await files.reload();
  return { path, port: files.port('lessons') };
}

describe('writeLessonsSettings over the kernel’s configuration service', () => {
  it('writes only the key that is not the default when no file exists yet', async () => {
    const { port, path } = await configWorld();

    const outcome = await writeLessonsSettings(port, { passiveDefault: false });

    expect(outcome.kind).toBe('written');
    const text = await readFile(path, 'utf8');
    expect(text).toContain('passiveDefault: false\n');
    expect(text).not.toContain('intervalMinutes');
    expect(text).not.toContain('enabled');
    expect(port.file(LESSONS_CONFIG)).toMatchObject({ passiveDefault: false });
  });

  it('keeps the owner’s comments and every key the file states, changing only the one the patch names', async () => {
    const { port, path } = await configWorld(
      [
        '# how often lessons are mined',
        'intervalMinutes: 90',
        'model: claude-haiku-5-5',
        'passiveDefault: true',
        '',
      ].join('\n'),
    );

    const outcome = await writeLessonsSettings(port, { passiveDefault: false });

    expect(outcome.kind).toBe('written');
    const text = await readFile(path, 'utf8');
    expect(text).toContain('# how often lessons are mined');
    expect(text).toContain('intervalMinutes: 90');
    expect(text).toContain('model: claude-haiku-5-5');
    expect(text).toContain('passiveDefault: false');
  });

  it('held-edit patch: the owner’s one key is in effect and a hand edit that raised a cap stays held, not reset and not in effect', async () => {
    const { port, path } = await configWorld('maxFerretsPerRun: 9999\n');
    expect(port.fileState(LESSONS_CONFIG).state).toBe('held');

    const outcome = await writeLessonsSettings(port, { passiveDefault: false });

    expect(outcome.kind).toBe('written');
    expect(port.file(LESSONS_CONFIG)).toMatchObject({ passiveDefault: false });
    expect((port.file(LESSONS_CONFIG) as Record<string, unknown>).maxFerretsPerRun).toBeUndefined();
    // the held version keeps its own raised cap, with the owner's key made to it as well
    const text = await readFile(path, 'utf8');
    expect(text).toContain('maxFerretsPerRun: 9999');
    expect(text).toContain('passiveDefault: false');
    expect(port.fileState(LESSONS_CONFIG).state).toBe('held');
  });

  it('drops a key that is neither stated nor different from its default', async () => {
    const { port, path } = await configWorld('passiveDefault: false\n');

    await writeLessonsSettings(port, { passiveDefault: true });

    expect(await readFile(path, 'utf8')).toContain('passiveDefault: true');
    expect(port.file(LESSONS_CONFIG)).toMatchObject({ passiveDefault: true });
  });
});
