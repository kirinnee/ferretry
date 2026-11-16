/**
 * A RECORDED Codex conversation proof (`CodexRollouts.provedConversation`, which Ferrets writes onto the ferret and later
 * resumes) is claimed only when both walks saw everything: the launch's baseline and the walk now. Fixture roots and
 * state in memory, the real `CodexRollouts`; nothing here is a real harness home.
 */
import { describe, expect, test } from 'bun:test';
import type { FerretId, KernelPorts } from '@ferretry/kernel/contract';
import { CodexRollouts } from '../../daemon/adapters/rollouts.ts';

const HOME = '/fixture/codex/f1';
const SESSIONS = `${HOME}/sessions`;
const header = (id: string, home = HOME) =>
  `${JSON.stringify({
    type: 'session_meta',
    payload: { id, cwd: '/work/project', runtime_workspace_roots: [`${home}/codex-correlation/unreachable`] },
  })}\n`;

/** An in-memory agent-homes root whose folders, files and the sessions folder itself can be made to refuse. */
function world() {
  const files = new Map<string, string>();
  const state = new Map<string, unknown>();
  const refused = new Set<string>();
  const unreadable = new Set<string>();
  const faults = { state: false };
  const exists = (path: string) =>
    path === '/fixture/codex' || files.has(path) || [...files.keys()].some(file => file.startsWith(`${path}/`));
  const root = (_name: string, scope?: { subfolder?: string }) => {
    const base = `/fixture/codex/${scope?.subfolder ?? ''}`.replace(/\/$/u, '');
    return {
      resolve: (relative: string) => ({
        ok: true,
        value: relative.startsWith('/') ? relative : `${base}${relative === '' ? '' : `/${relative}`}`,
      }),
      entries: async (path: string) => {
        if (refused.has(path)) throw new Error('the folder could not be listed');
        if (!exists(path)) throw new Error('no such folder');
        const names = [
          ...new Set(
            [...files.keys()]
              .filter(file => file.startsWith(`${path}/`))
              .map(file => file.slice(path.length + 1).split('/')[0] as string),
          ),
        ];
        return names.map(name => {
          const child = `${path}/${name}`;
          return {
            name,
            kind: files.has(child) ? 'file' : 'directory',
            size: files.get(child)?.length ?? 0,
            modified: '2026-11-15T00:00:00.000Z',
          };
        });
      },
      lstat: async (path: string) => (exists(path) || refused.has(path) ? { kind: 'directory' } : undefined),
      readBytes: async (path: string, range: { offset: number; length: number }) => {
        if (unreadable.has(path)) throw new Error('the file could not be read');
        return new TextEncoder().encode(files.get(path) ?? '').slice(range.offset, range.offset + range.length);
      },
    };
  };
  const rollouts = new CodexRollouts(
    {
      roots: { root },
      clock: { now: () => '2026-11-15T00:00:00.000Z' },
      state: {
        read: async (_def: unknown, ferret: string) =>
          faults.state ? { ok: false } : { ok: true, value: state.get(ferret) },
        write: async (_def: unknown, value: unknown, ferret: string) => {
          state.set(ferret, value);
        },
      },
    } as unknown as KernelPorts,
    async () => undefined,
  );
  const launch = async (native?: string) =>
    await rollouts.launched({ ferret: 'f1', home: HOME } as never, ...(native === undefined ? [] : [native]));
  const proved = async () => await rollouts.provedConversation('f1' as FerretId);
  return { files, state, refused, unreadable, faults, rollouts, launch, proved };
}

describe('a recorded Codex conversation proof needs complete discovery', () => {
  test('review repro: a baseline that missed an earlier rollout, then a walk that misses this launch’s, proves NOTHING', async () => {
    // Before the fix this answered the PREVIOUS launch's conversation, which Ferrets then recorded and resumed.
    const w = world();
    const old = `${SESSIONS}/old/rollout-old.jsonl`;
    w.files.set(old, header('previous-launch'));
    w.refused.add(`${SESSIONS}/old`);
    await w.launch();
    expect(w.state.get('f1')).toMatchObject({ baseline: [], baselineComplete: false });
    w.files.set(`${SESSIONS}/current/rollout-new.jsonl`, header('current-launch'));
    w.refused.delete(`${SESSIONS}/old`);
    w.refused.add(`${SESSIONS}/current`);
    expect(await w.proved()).toBeUndefined();
    // Even with every folder readable again: a baseline that did not see everything never proves a new launch.
    w.refused.clear();
    expect(await w.proved()).toBeUndefined();
  });

  test('a complete baseline and a complete walk prove this launch’s one correlated rollout, outside the baseline', async () => {
    const w = world();
    w.files.set(`${SESSIONS}/old/rollout-old.jsonl`, header('previous-launch'));
    await w.launch();
    expect(w.state.get('f1')).toMatchObject({ baseline: ['previous-launch'], baselineComplete: true });
    const file = `${SESSIONS}/current/rollout-new.jsonl`;
    w.files.set(file, header('current-launch'));
    expect(await w.proved()).toEqual({ id: 'current-launch', file, home: HOME });
  });

  test('a walk now that cannot list a folder, or read a header or a correlation window, proves nothing', async () => {
    const w = world();
    await w.launch();
    const file = `${SESSIONS}/current/rollout-new.jsonl`;
    w.files.set(file, header('current-launch'));
    w.files.set(`${SESSIONS}/other/rollout-x.jsonl`, header('other'));
    w.refused.add(`${SESSIONS}/other`);
    expect(await w.proved()).toBeUndefined();
    w.refused.clear();
    w.unreadable.add(`${SESSIONS}/other/rollout-x.jsonl`);
    expect(await w.proved()).toBeUndefined();
  });

  test('a sessions folder that is ABSENT at launch is a complete (empty) baseline; one that cannot be listed is not', async () => {
    const absent = world();
    await absent.launch();
    expect(absent.state.get('f1')).toMatchObject({ baseline: [], baselineComplete: true });
    const file = `${SESSIONS}/current/rollout-new.jsonl`;
    absent.files.set(file, header('current-launch'));
    expect((await absent.proved())?.id).toBe('current-launch');

    const unlistable = world();
    unlistable.files.set(`${SESSIONS}/old/rollout-old.jsonl`, header('previous-launch'));
    unlistable.refused.add(SESSIONS);
    await unlistable.launch();
    expect(unlistable.state.get('f1')).toMatchObject({ baselineComplete: false });
    unlistable.refused.clear();
    unlistable.files.set(file, header('current-launch'));
    expect(await unlistable.proved()).toBeUndefined();
  });

  test('a binding written before completeness was recorded proves no new launch; a resumed native id still needs a complete walk', async () => {
    const w = world();
    const file = `${SESSIONS}/current/rollout-new.jsonl`;
    w.files.set(file, header('current-launch'));
    w.state.set('f1', { format: 1, home: HOME, baseline: [] });
    expect(await w.proved()).toBeUndefined();

    // A launch that resumed its own conversation is proved by that exact id (its baseline is not what proves it).
    w.state.set('f1', { format: 1, home: HOME, baseline: [], native: 'current-launch' });
    expect(await w.proved()).toEqual({ id: 'current-launch', file, home: HOME });
    w.files.set(`${SESSIONS}/other/rollout-x.jsonl`, header('other'));
    w.refused.add(`${SESSIONS}/other`);
    expect(await w.proved()).toBeUndefined();
  });

  test('another home’s binding is never proved for this ferret', async () => {
    const w = world();
    w.files.set(`${SESSIONS}/current/rollout-new.jsonl`, header('current-launch'));
    w.state.set('f1', { format: 1, home: '/fixture/codex/f2', baseline: [], baselineComplete: true });
    expect(await w.proved()).toBeUndefined();
  });
});

describe('a doubt the proof cannot settle answers nothing', () => {
  test('a sessions folder that cannot be listed, under a home that cannot be listed either, is no proof of absence', async () => {
    const w = world();
    w.files.set(`${SESSIONS}/old/rollout-old.jsonl`, header('previous-launch'));
    w.refused.add(SESSIONS);
    w.refused.add(HOME);
    await w.launch();
    expect(w.state.get('f1')).toMatchObject({ baselineComplete: false });
  });

  test('damaged rollout ownership state proves nothing instead of failing the stop or resume that asked', async () => {
    const w = world();
    await w.launch();
    w.files.set(`${SESSIONS}/current/rollout-new.jsonl`, header('current-launch'));
    w.faults.state = true;
    expect(await w.proved()).toBeUndefined();
  });
});
