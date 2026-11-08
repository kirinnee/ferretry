import { afterEach, describe, expect, test } from 'bun:test';
import type { RunSpec } from '@ferretry/core-ferrets/contract';
import { registeredCodex } from '../support/registered.ts';

const ENV = {} as RunSpec['env'];
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});
function fixture() {
  const box = registeredCodex();
  cleanups.push(box.cleanup);
  return box;
}
const line = (type: string, payload: unknown) =>
  `${JSON.stringify({ timestamp: '2026-10-20T09:00:00.000Z', type, payload })}\n`;
const header = (id: string, home: string) =>
  line('session_meta', {
    id,
    cwd: '/work/project',
    runtime_workspace_roots: [`${home}/codex-correlation/unreachable`],
  });
const message = (text: string) =>
  line('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });

describe('the registered Codex harness', () => {
  const LOADING = "Codex's model list is still loading; try again in about two minutes";
  const fastInput = (more: Record<string, unknown> = {}) => ({
    ferret: 'f1',
    name: 'wren',
    role: 'lead',
    harness: 'codex',
    folder: '/w',
    by: 'owner',
    model: 'gpt-x',
    fast: true,
    ...more,
  });
  const decideOf = (half: { hooks: unknown }) =>
    (half.hooks as Record<string, (input: unknown) => Promise<unknown>>)['start.decide'] as (
      input: unknown,
    ) => Promise<unknown>;
  const persistedCatalog = (box: ReturnType<typeof fixture>, readAtMs = 0) =>
    box.state.set('fastCatalog', {
      format: 1,
      readAt: new Date(readAtMs).toISOString(),
      choices: [
        { value: 'gpt-x', label: 'GPT-X', reasoningEfforts: [], fast: false },
        { value: 'gpt-y', label: 'GPT-Y', reasoningEfforts: [], fast: true },
      ],
    });

  test('(no guarantees row) the held fast-start catalog is read by ONE job on the worker lane, once after start; there is no timer', () => {
    const box = fixture();
    box.buildHalf();
    expect(box.jobs.map(job => job.id)).toEqual(['codex-fast-catalog']);
    expect(box.jobs[0]).toMatchObject({ schedule: { onceAfterStart: true }, lane: 'worker' });
  });

  test('(no guarantees row) #35 with NOTHING persisted and no read landed, a fast Codex start is refused at once; a start that did not ask for fast is not', async () => {
    const box = fixture();
    const decide = decideOf(box.buildHalf());
    expect(await decide(fastInput())).toEqual({ allow: false, reason: LOADING, code: 'unservable_model' });
    expect(await decide(fastInput({ fast: false }))).toEqual({ allow: true });
    expect(await decide(fastInput({ fast: undefined }))).toEqual({ allow: true });
    // Asking for the catalog is what the refusal triggers: the job is kicked, not waited for.
    expect(box.kicks).toEqual(['codex-fast-catalog']);
  });

  test('(no guarantees row) r3 LOW-C once the boot read finds no Codex binary, a fast start is refused with "could not be found", not "still loading"; a non-fast start is not', async () => {
    const box = fixture();
    box.missingCodex();
    const decide = decideOf(box.buildHalf());
    // Before any read has looked, the true answer is still "loading".
    expect(await decide(fastInput())).toMatchObject({ allow: false, reason: LOADING });
    const job = box.jobs.find(candidate => candidate.id === 'codex-fast-catalog');
    await job?.run(new AbortController().signal);
    expect(box.catalogChildren).toHaveLength(0);
    expect(await decide(fastInput())).toEqual({
      allow: false,
      reason: 'Codex could not be found, so its fast mode cannot be checked',
      code: 'unservable_model',
    });
    expect(await decide(fastInput({ fast: false }))).toEqual({ allow: true });
  });

  test('(no guarantees row) #35 a persisted catalog decides a fast start at once, before any job has run', async () => {
    const box = fixture();
    persistedCatalog(box);
    const decide = decideOf(box.buildHalf());
    expect(await decide(fastInput({ model: 'gpt-x' }))).toEqual({
      allow: false,
      reason: 'GPT-X has no fast mode',
      code: 'unservable_model',
    });
    expect(await decide(fastInput({ model: 'gpt-y' }))).toEqual({ allow: true });
    expect(box.catalogChildren).toHaveLength(0);
    // Fresh, so no read is asked for.
    expect(box.kicks).toEqual([]);
  });

  test('(no guarantees row) #35 a stale persisted catalog is refreshed in the background, and the start is answered from what is held', async () => {
    const box = fixture();
    persistedCatalog(box, 0);
    box.setNowMs(300_001);
    const decide = decideOf(box.buildHalf());
    expect(await decide(fastInput({ model: 'gpt-x' }))).toMatchObject({
      allow: false,
      reason: 'GPT-X has no fast mode',
    });
    expect(box.kicks).toEqual(['codex-fast-catalog']);
    expect(box.catalogChildren).toHaveLength(0);
  });

  test('(no guarantees row) the boot job reads the catalog in the plugin folder with a throwaway HOME, keeps it in state, and a stop signal is passed to the child', async () => {
    const box = fixture();
    box.freeSleep();
    const decide = decideOf(box.buildHalf());
    expect(await decide(fastInput())).toMatchObject({ allow: false, reason: LOADING });
    const job = box.jobs.find(candidate => candidate.id === 'codex-fast-catalog');
    await job?.run(new AbortController().signal);
    expect(box.catalogChildren).toHaveLength(1);
    const child = box.catalogChildren[0];
    expect(child?.cwd?.startsWith(`${box.base}/catalog/`)).toBe(true);
    expect(child?.env?.HOME?.startsWith(`${box.base}/catalog/`)).toBe(true);
    expect(child?.env?.HOME).not.toBe('/fixture-owner');
    expect(box.state.get('fastCatalog')).toMatchObject({ format: 1, choices: [{ value: 'gpt-6-sol' }] });
    // The read landed, so the next fast start is decided from it.
    expect(await decide(fastInput({ model: 'gpt-6-sol' }))).toEqual({ allow: true });
    expect(await decide(fastInput({ model: 'gpt-x' }))).toEqual({ allow: true });

    const stopped = fixture();
    stopped.freeSleep();
    stopped.buildHalf();
    const controller = new AbortController();
    controller.abort();
    const stoppedJob = stopped.jobs.find(candidate => candidate.id === 'codex-fast-catalog');
    await stoppedJob?.run(controller.signal);
    expect(stopped.state.get('fastCatalog')).toBeUndefined();
    expect(stopped.warnings).toHaveLength(1);
  });

  test('S42 homeFor names state/codex/agent-homes/<ferret> through its own root; the home is made private before any launch and no other home is used', async () => {
    const box = fixture();
    const harness = box.build();
    expect(await harness.homeFor('f1' as never)).toBe(`${box.base}/f1` as never);
    expect(await harness.homeFor('f2' as never)).toBe(`${box.base}/f2` as never);
    await expect(harness.homeFor('../f2' as never)).rejects.toThrow('plain name');

    // The home Ferrets used to hand every harness (its own shared agent-homes) is refused by prepare and by start.
    const shared = { ...box.spec('f1'), home: `${box.base.replace('/state/codex/', '/state/ferrets/')}` as never };
    await expect(harness.prepareHome(shared)).rejects.toThrow("not this ferret's Codex home");
    await expect(harness.start(shared, box.runner, ENV)).rejects.toThrow("not this ferret's Codex home");
    expect(box.privateDirectories).toEqual([]);
    expect(box.commands).toEqual([]);

    // A fresh ferret beside an existing one: prepared privately in homeFor's answer, then launched there.
    await harness.prepareHome({ ...box.spec('f1'), parts: [{ kind: 'instruction', id: 'i', text: 'be brief' }] });
    const fresh = box.spec('fresh');
    expect(fresh.home).toBe(await harness.homeFor('fresh' as never));
    await harness.prepareHome(fresh);
    expect((await harness.start(fresh, box.runner, ENV)).ok).toBe(true);
    expect(box.privateDirectories).toEqual([`${box.base}/f1`, `${box.base}/fresh`, `${box.base}/fresh`]);
    expect(box.commands[0]?.command.slice(0, 2)).toEqual(['env', `CODEX_HOME=${box.base}/fresh`]);
  });

  test('applies the live machine permission mode, trust, notices and no-alt-screen to every start and resume', async () => {
    const box = fixture();
    const harness = box.build();
    const spec = box.spec();
    await harness.start({ ...spec, model: 'model-a', effort: 'high', prompt: 'hello' }, box.runner, ENV);
    box.mode('skip');
    await harness.resume(spec, box.runner, ENV, 'native-conversation');
    box.mode('auto');
    await harness.resume(spec, box.runner, ENV, 'native-conversation');
    for (const [index, command] of box.commands.map(item => item.command).entries()) {
      expect(command).toContain(index === 1 ? 'approval_policy="never"' : 'approval_policy="on-request"');
      expect(command).toContain(index === 1 ? 'sandbox_mode="danger-full-access"' : 'sandbox_mode="workspace-write"');
      expect(command).toContain('projects={"/work/project"={trust_level="trusted"}}');
      expect(command).toContain('--no-alt-screen');
      expect(command.find(arg => arg.startsWith('notice='))).toContain('hide_full_access_warning=true');
      expect(command.find(arg => arg.startsWith('notice='))).toContain('hide_gpt-5.1-codex-max_migration_prompt');
      expect(command).toContain(`${spec.home}/codex-correlation/unreachable`);
    }
    expect(box.commands[0]?.command.at(-1)).toBe('hello');
    expect(box.commands[1]?.command).toContain('native-conversation');
  });

  test('reads and finds owned transcript entries, usage and native conversation ids through declared roots', async () => {
    const box = fixture();
    const harness = box.build();
    const spec = box.spec();
    await harness.start(spec, box.runner, ENV);
    const file = `${spec.home}/sessions/2026/10/20/rollout-native.jsonl`;
    box.files.set(
      file,
      header('native-id', spec.home) +
        line('turn_context', { model: 'model-a' }) +
        line('event_msg', { type: 'task_started' }) +
        message('fixture-sensitive answer') +
        line('event_msg', {
          type: 'token_count',
          info: {
            last_token_usage: { input_tokens: 20, output_tokens: 5, cached_input_tokens: 7 },
            total_token_usage: { total_tokens: 25 },
          },
        }),
    );
    const entries = await harness.transcript.read(spec.ferret);
    const answer = entries.find(entry => entry.role === 'assistant');
    expect(answer?.text).toBe('[redacted] answer');
    expect(JSON.stringify(entries)).not.toContain('fixture-sensitive');
    expect(await harness.transcript.find(spec.ferret, answer?.id ?? '')).toEqual(answer);
    expect(await harness.transcript.read(spec.ferret, entries[0]?.id, 1)).toEqual(entries.slice(1, 2));
    expect(await harness.transcript.read(spec.ferret, 'missing-id')).toEqual([]);
    expect(await harness.usage.turns(spec.ferret)).toMatchObject([
      {
        turn: 1,
        at: '2026-10-20T09:00:00.000Z' as never,
        model: 'model-a',
        inputTokens: 20,
        outputTokens: 5,
        cacheReadTokens: 7,
      },
    ]);
    expect(await harness.usage.turns(spec.ferret, '2026-11-01T00:00:00.000Z' as never)).toEqual([]);
    const history = '/fixture-owner/.codex/sessions/2026/10/20/rollout-import.jsonl';
    box.files.set(history, header('import-native', '/another-home'));
    expect(await harness.conversations.list('/work/project' as never)).toEqual([
      { id: 'import-native', folder: '/work/project', updatedAt: box.at },
    ]);
    expect(await harness.conversations.list('/other' as never)).toEqual([]);
    expect(box.rootsUsed.every(root => ['agent-homes', 'harness-history'].includes(root.name))).toBe(true);
    expect(box.reads.every(path => path.endsWith('.jsonl') || path.endsWith('rollout-binding.json'))).toBe(true);
    expect((await box.build().transcript.read(spec.ferret)).length).toBe(entries.length);
  });

  test('refuses the baseline, same-folder strangers and ambiguous ownership; resumes only the native id after restart', async () => {
    const box = fixture();
    const harness = box.build();
    const spec = box.spec();
    const old = `${spec.home}/sessions/rollout-old.jsonl`;
    box.files.set(old, header('baseline', spec.home) + message('old'));
    await harness.start(spec, box.runner, ENV);
    box.files.set(
      `${spec.home}/sessions/stranger.jsonl`,
      header('stranger', '/somebody-else') + message('wrong ferret'),
    );
    expect(await harness.transcript.read(spec.ferret)).toEqual([]);
    const owned = `${spec.home}/sessions/one.jsonl`;
    box.files.set(owned, header('native-one', spec.home) + message('right ferret'));
    expect((await harness.transcript.read(spec.ferret)).map(entry => entry.text)).toEqual(['right ferret']);
    const ambiguous = `${spec.home}/sessions/two.jsonl`;
    box.files.set(ambiguous, header('native-two', spec.home) + message('ambiguous'));
    expect(await harness.transcript.read(spec.ferret)).toEqual([]);
    await harness.resume(spec, box.runner, ENV, 'native-one');
    expect((await box.build().transcript.read(spec.ferret)).map(entry => entry.text)).toEqual(['right ferret']);
    const other = box.spec('f2');
    expect(await harness.transcript.read(other.ferret)).toEqual([]);
    box.files.delete(owned);
    expect(await harness.transcript.read(spec.ferret)).toEqual([]);
  });

  test('discovery reads only head and tail windows; only the owned rollout is read whole', async () => {
    const box = fixture();
    const harness = box.build();
    const spec = box.spec();
    await harness.start(spec, box.runner, ENV);
    const filler = message('x'.repeat(1_000)).repeat(400);
    // A compacted rollout: its header names no correlation path, its tail re-states it.
    const owned = `${spec.home}/sessions/compacted.jsonl`;
    box.files.set(
      owned,
      line('session_meta', { id: 'native-compacted', cwd: '/work/project' }) +
        filler +
        message(`brief in ${spec.home}/codex-correlation/unreachable`) +
        message('right ferret'),
    );
    const stranger = `${spec.home}/sessions/stranger.jsonl`;
    box.files.set(stranger, header('stranger', '/somebody-else') + filler);
    expect((await harness.transcript.read(spec.ferret)).at(-1)?.text).toBe('right ferret');
    expect(box.reads.filter(path => path.endsWith('.jsonl'))).toEqual([owned]);
    expect(box.windows.every(read => read.length <= 256 * 1024)).toBe(true);
    expect(box.windows.some(read => read.path === stranger && read.offset > 0)).toBe(true);
    expect(await harness.conversations.list(undefined)).toEqual([]);
  });

  test('follows complete appended records once and stops when aborted', async () => {
    const box = fixture();
    const harness = box.build();
    const spec = box.spec();
    await harness.start(spec, box.runner, ENV);
    const file = `${spec.home}/sessions/follow.jsonl`;
    box.files.set(file, header('native-follow', spec.home) + message('first') + message('second').slice(0, -2));
    const abort = new AbortController();
    const stream = harness.transcript.follow(spec.ferret, abort.signal)[Symbol.asyncIterator]();
    expect((await stream.next()).value?.text).toBe('first');
    box.onSleep(() => box.files.set(file, header('native-follow', spec.home) + message('first') + message('second')));
    expect((await stream.next()).value?.text).toBe('second');
    abort.abort();
    expect((await stream.next()).done).toBe(true);
  });

  test('fails closed when transcript redaction fails', async () => {
    const box = fixture();
    const harness = box.build();
    const spec = box.spec();
    await harness.start(spec, box.runner, ENV);
    box.files.set(`${spec.home}/sessions/owned.jsonl`, header('native', spec.home) + message('fixture-sensitive'));
    box.failRedaction();
    expect(harness.transcript.read(spec.ferret)).rejects.toThrow('redaction unavailable');
  });
});
