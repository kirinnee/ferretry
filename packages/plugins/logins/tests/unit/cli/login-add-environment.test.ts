import { describe, it } from 'bun:test';
import type { VerbInvocation } from '@ferretry/kernel/manifest';
import should from 'should';
import { parseUntil } from '../../../cli/lib/change.ts';
import { loginAdd, loginSignout } from '../../../cli/lib/commands.ts';
import { fakeWorld, login, loginList } from './fakes.ts';

const inv = (args: string[], options: VerbInvocation['options'] = {}): VerbInvocation => ({ args, options });
const view = () =>
  ({
    id: 'chg1',
    change: { kind: 'login.enable', id: 'work' },
    summary: 'Do it',
    consequences: [],
    expiresAt: '2026-11-01T10:15:00.000Z',
    state: 'pending',
  }) as never;

const half = (harness: string, available = true) => ({ harness, offered: { available }, models: [] });
const preset = (overrides: Record<string, unknown> = {}) => ({
  id: 'zai-glm',
  label: 'Z.ai GLM',
  harness: 'claude-code',
  offered: { available: true },
  halves: [half('claude-code')],
  variables: [
    { name: 'ANTHROPIC_BASE_URL', kind: 'plain', value: 'https://api.z.ai/anthropic' },
    { name: 'ANTHROPIC_AUTH_TOKEN', kind: 'secret', secret: 'ZAI_API_KEY' },
  ],
  ...overrides,
});

const worldWith = (presets: unknown[]) =>
  fakeWorld({
    gateway: {
      logins: () => loginList(),
      presets: () => ({ presets }) as never,
      stage: view,
      apply: () => ({ outcome: 'applied' }),
    },
  });

describe('login add --env', () => {
  it('should send each --env as an environment variable over the preset’s own, repeated or single', async () => {
    const world = worldWith([preset()]);

    await loginAdd(
      world.deps,
      inv(['claude'], {
        preset: 'zai-glm',
        env: ['ANTHROPIC_BASE_URL=https://gateway.example.test', 'EXTRA=a=b'],
      }),
    );
    await loginAdd(
      world.deps,
      inv(['claude'], { preset: 'zai-glm', env: 'EXTRA=one', 'cloud-credential': 'aws-prod' }),
    );

    const staged = world.gateway.called('stage').map(call => call.args[0]);
    should(staged[0]).match({
      store: 'environment',
      preset: 'zai-glm',
      env: {
        ANTHROPIC_BASE_URL: 'https://gateway.example.test',
        ANTHROPIC_AUTH_TOKEN: '${secret:ZAI_API_KEY}',
        EXTRA: 'a=b',
      },
    });
    should(staged[1]).match({
      env: { ANTHROPIC_BASE_URL: 'https://api.z.ai/anthropic', EXTRA: 'one' },
      cloudCredential: 'aws-prod',
    });
  });

  it('should make an environment login from --env alone, without a preset, and take a suggested cloud credential', async () => {
    const world = worldWith([preset({ cloudCredential: { suggested: 'aws-default' } })]);

    await loginAdd(world.deps, inv(['claude'], { env: 'ANTHROPIC_BASE_URL=https://x.example.test' }));
    await loginAdd(world.deps, inv(['claude'], { preset: 'zai-glm' }));

    const staged = world.gateway.called('stage').map(call => call.args[0]);
    should(staged[0]).eql({
      kind: 'login.add',
      id: 'claude-login',
      harness: 'claude-code',
      store: 'environment',
      env: { ANTHROPIC_BASE_URL: 'https://x.example.test' },
    });
    should(staged[1]).match({ preset: 'zai-glm', cloudCredential: 'aws-default' });
  });

  it('should refuse an --env that is not NAME=VALUE, naming it', async () => {
    const world = worldWith([]);
    await should(loginAdd(world.deps, inv(['claude'], { env: 'NOVALUE' }))).be.rejectedWith(
      'Write --env as NAME=VALUE, not NOVALUE',
    );
    await should(loginAdd(world.deps, inv(['claude'], { env: '=value' }))).be.rejectedWith(
      'Write --env as NAME=VALUE, not =value',
    );
    should(world.gateway.called('stage')).be.empty();
  });
});

describe('login add --preset refusals', () => {
  it('should name a preset that does not exist and point at the list', async () => {
    const world = worldWith([preset()]);
    await should(loginAdd(world.deps, inv(['claude'], { preset: 'nonesuch' }))).be.rejectedWith(
      'There is no preset nonesuch: see `fz login presets`',
    );
  });

  it('should repeat why a preset is not offered', async () => {
    const world = worldWith([preset({ offered: { available: false, reason: 'needs a cloud profile' } })]);
    await should(loginAdd(world.deps, inv(['claude'], { preset: 'zai-glm' }))).be.rejectedWith('needs a cloud profile');
  });

  it('should refuse a preset that does not drive the tool asked for', async () => {
    const world = worldWith([preset({ halves: [half('claude-code'), half('codex', false)] })]);
    await should(loginAdd(world.deps, inv(['codex'], { preset: 'zai-glm' }))).be.rejectedWith(
      'Z.ai GLM does not drive Codex',
    );
    should(world.gateway.called('stage')).be.empty();
  });

  it('should ask for a tool or provider when none is named', async () => {
    const world = worldWith([]);
    await should(loginAdd(world.deps, inv([]))).be.rejectedWith(
      'Name a tool or provider: fz login add claude|codex|<provider>',
    );
    await should(loginAdd(world.deps, inv(['  ']))).be.rejectedWith(/^Name a tool or provider/u);
  });
});

describe('a finished sign-out', () => {
  it('should say which login was signed out', async () => {
    const world = fakeWorld({
      gateway: { stage: view, apply: () => ({ outcome: 'signed-out', login: login({ id: 'claude-you' }) }) },
    });
    await loginSignout(world.deps, inv(['claude-you'], { yes: true }));
    should(world.out.text('success')).equal('Signed out claude-you.');
    should(world.out.exitCode).equal(0);
  });
});

describe('parseUntil — a full time', () => {
  it('should read a time with a zone and refuse one that is not a real time', () => {
    const now = Date.parse('2026-11-01T10:00:00Z');
    should(parseUntil('2026-11-02T09:00:00Z', now)).equal('2026-11-02T09:00:00.000Z');
    should(() => parseUntil('2026-13-45T09:00:00Z', now)).throw(/not a real time/);
  });
});
