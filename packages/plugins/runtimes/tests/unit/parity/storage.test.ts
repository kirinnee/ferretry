import { describe, expect, test } from 'bun:test';
import { MODEL_SET_ITEMS, PROFILE_ITEMS, RUNTIME_ITEMS, RUNTIMES_CONFIG } from '../../../contract/index.ts';
import manifest from '../../../manifest.ts';

/**
 * Where the kernel keeps a declared configuration file, under `$FY_HOME/config/`: a single file is its own name, a
 * collection is one `<name>.yaml` per item (the rule `testHost` and the real writer share).
 */
const configPath = (def: (typeof manifest.data.config)[number], name?: string): string =>
  def.shape === 'file' ? def.file : `${def.collection}/${name as string}.yaml`;

/** The name grammar a collection declares. */
const namePattern = (def: unknown): RegExp => (def as { name: RegExp }).name;

const declares = (def: unknown): boolean => manifest.data.config.some(declared => declared === def);

describe('storage parity: runtimes configuration files', () => {
  test('F-0175 a runtime is config/runtimes/<name>.yaml: one login and one profile, strict, `credential` now `login`', () => {
    expect(declares(RUNTIME_ITEMS)).toBe(true);
    expect(configPath(RUNTIME_ITEMS, 'claude-work')).toBe('runtimes/claude-work.yaml');
    const shape = {
      login: 'claude-you',
      profile: 'default',
      agent: true,
      disabled: { reason: 'quota', until: '2030-01-01' },
    };
    expect(RUNTIME_ITEMS.schema.safeParse(shape).success).toBe(true);
    expect(RUNTIME_ITEMS.schema.safeParse({ ...shape, credential: 'claude-you' }).success).toBe(false);
    expect(namePattern(RUNTIME_ITEMS).test('claude-work')).toBe(true);
    expect(namePattern(RUNTIME_ITEMS).test('../escape')).toBe(false);
  });

  test('F-0173 a profile is config/profiles/<name>.yaml: its layers, oldest first, each <kind>/<name> or profile/<name>', () => {
    expect(declares(PROFILE_ITEMS)).toBe(true);
    expect(configPath(PROFILE_ITEMS, 'work')).toBe('profiles/work.yaml');
    expect(
      PROFILE_ITEMS.schema.safeParse({ contents: ['instructions/main', 'profile/base', 'modelSets/heavy'] }).success,
    ).toBe(true);
    expect(PROFILE_ITEMS.schema.safeParse({ contents: ['nonsense/main'] }).success).toBe(false);
    expect(PROFILE_ITEMS.schema.safeParse({ contents: [], extra: 1 }).success).toBe(false);
  });

  test('F-0159 a model set is a component under config/model-sets/<name>.yaml (v4: components/modelSets/): models and one default among them', () => {
    expect(declares(MODEL_SET_ITEMS)).toBe(true);
    expect(configPath(MODEL_SET_ITEMS, 'heavy')).toBe('model-sets/heavy.yaml');
    expect(MODEL_SET_ITEMS.schema.safeParse({ models: ['opus', 'sonnet'], default: 'opus' }).success).toBe(true);
    expect(MODEL_SET_ITEMS.schema.safeParse({ models: ['opus'], default: 'sonnet' }).success).toBe(false);
    expect(MODEL_SET_ITEMS.schema.safeParse({ models: ['opus', 'opus'], default: 'opus' }).success).toBe(false);
  });

  test('F-0168 the machine file is config/runtimes.yaml (v4: machine.yaml): the default runtime and the auto-resume switch', () => {
    expect(declares(RUNTIMES_CONFIG)).toBe(true);
    expect(configPath(RUNTIMES_CONFIG)).toBe('runtimes.yaml');
    expect(RUNTIMES_CONFIG.schema.safeParse({ defaultRuntime: 'claude-default', autoResume: false }).success).toBe(
      true,
    );
    expect(RUNTIMES_CONFIG.schema.safeParse({ agentPermissions: 'auto' }).success).toBe(false);
  });
});
