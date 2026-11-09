import { beforeEach, describe, expect, test } from 'bun:test';
import type { Log } from '@ferretry/kernel/contract';
import { config as hostConfig, state as hostState } from '@ferretry/kernel/host';
import { MODEL_SET_ITEMS, PROFILE_ITEMS, RUNTIME_ITEMS, RUNTIMES_CONFIG } from '../../../contract/index.ts';
import manifest from '../../../manifest.ts';

/**
 * Runtimes' configuration files, written by the kernel's REAL config writer (`createConfigFiles`, the one the daemon
 * hands every plugin) over a fresh in-memory FY_HOME, so the path under `$FY_HOME/config/` is the kernel's own rule,
 * not a copy of it here.
 */
const quiet: Log = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => quiet };

type Def = (typeof manifest.data.config)[number];

const HOME = '/home/fy';
let fs = hostState.createMemoryHostFs();
beforeEach(() => {
  fs = hostState.createMemoryHostFs();
});

/** The writer over the temp home, declaring everything Runtimes' manifest declares. */
const writer = async () => {
  const files = hostConfig.createConfigFiles({
    home: HOME,
    fs,
    clock: { nowMs: () => Date.parse('2026-11-09T12:00:00.000Z'), after: () => () => {}, every: () => () => {} },
    log: quiet,
    binary: 'fy',
    defs: manifest.data.config.map(def => ({ plugin: manifest.id, def })),
    judge: () => true,
  });
  await files.reload();
  return files;
};

/** Writes one item and answers the file the kernel put on disk for it (relative to `config/`), with its text. */
const written = async (def: Def, name: string | undefined, patch: Record<string, unknown>) => {
  const files = await writer();
  const outcome = await files.write(manifest.id, def, name, { patch });
  const config = `${HOME}/config`;
  const walk = async (dir: string, prefix = ''): Promise<string[]> => {
    const entries = await fs.list(dir).catch(() => []);
    const nested = await Promise.all(
      entries.map(async entry =>
        entry.directory ? walk(`${dir}/${entry.name}`, `${prefix}${entry.name}/`) : [`${prefix}${entry.name}`],
      ),
    );
    return nested.flat();
  };
  const found = await walk(config);
  return { outcome, found, text: async (path: string) => (await fs.readText(`${config}/${path}`)) ?? '' };
};

const declares = (def: unknown): boolean => manifest.data.config.some(declared => declared === def);

describe('storage parity: runtimes configuration files', () => {
  test('F-0175 a runtime is config/runtimes/<name>.yaml: one login and one profile, strict, `credential` now `login`', async () => {
    expect(declares(RUNTIME_ITEMS)).toBe(true);
    const shape = {
      login: 'claude-you',
      profile: 'default',
      agent: true,
      disabled: { reason: 'quota', until: '2030-01-01' },
    };
    const write = await written(RUNTIME_ITEMS, 'claude-work', shape);
    expect(write.outcome.kind).toBe('applied');
    expect(write.found).toEqual(['runtimes/claude-work.yaml']);
    expect(await write.text('runtimes/claude-work.yaml')).toContain('login: claude-you');
    // `credential` is the old word: the schema refuses it, and the writer refuses the edit (no file is made).
    const refused = await written(RUNTIME_ITEMS, 'claude-old', { ...shape, credential: 'claude-you' });
    expect(refused.outcome.kind).toBe('refused');
    expect(refused.found).not.toContain('runtimes/claude-old.yaml');
    // The name grammar keeps a name inside the folder.
    const escaped = await written(RUNTIME_ITEMS, '../escape', shape);
    expect(escaped.outcome.kind).toBe('refused');
    expect(escaped.found).toEqual(['runtimes/claude-work.yaml']);
  });

  test('F-0173 a profile is config/profiles/<name>.yaml: its layers, oldest first, each <kind>/<name> or profile/<name>', async () => {
    expect(declares(PROFILE_ITEMS)).toBe(true);
    const write = await written(PROFILE_ITEMS, 'work', {
      contents: ['instructions/main', 'profile/base', 'modelSets/heavy'],
    });
    expect(write.outcome.kind).toBe('applied');
    expect(write.found).toEqual(['profiles/work.yaml']);
    const text = await write.text('profiles/work.yaml');
    expect(text.indexOf('instructions/main')).toBeLessThan(text.indexOf('profile/base'));
    expect(text.indexOf('profile/base')).toBeLessThan(text.indexOf('modelSets/heavy'));
    expect((await written(PROFILE_ITEMS, 'bad', { contents: ['nonsense/main'] })).outcome.kind).toBe('refused');
    expect((await written(PROFILE_ITEMS, 'bad', { contents: [], extra: 1 })).outcome.kind).toBe('refused');
  });

  test('F-0159 a model set is a component under config/model-sets/<name>.yaml (v4: components/modelSets/): models and one default among them', async () => {
    expect(declares(MODEL_SET_ITEMS)).toBe(true);
    const write = await written(MODEL_SET_ITEMS, 'heavy', { models: ['opus', 'sonnet'], default: 'opus' });
    expect(write.outcome.kind).toBe('applied');
    expect(write.found).toEqual(['model-sets/heavy.yaml']);
    expect(await write.text('model-sets/heavy.yaml')).toContain('default: opus');
    const stray = await written(MODEL_SET_ITEMS, 'stray', { models: ['opus'], default: 'sonnet' });
    expect(stray.outcome.kind).toBe('refused');
    expect(stray.found).not.toContain('model-sets/stray.yaml');
    const twice = await written(MODEL_SET_ITEMS, 'twice', { models: ['opus', 'opus'], default: 'opus' });
    expect(twice.outcome.kind).toBe('refused');
    expect(twice.found).not.toContain('model-sets/twice.yaml');
  });

  test('the machine file is config/runtimes.yaml: the default runtime and the auto-resume switch', async () => {
    expect(declares(RUNTIMES_CONFIG)).toBe(true);
    const write = await written(RUNTIMES_CONFIG, undefined, { defaultRuntime: 'claude-default', autoResume: false });
    expect(write.outcome.kind).toBe('applied');
    expect(write.found).toEqual(['runtimes.yaml']);
    expect((await written(RUNTIMES_CONFIG, undefined, { agentPermissions: 'auto' })).outcome.kind).toBe('refused');
  });
});
