import { describe, it } from 'bun:test';
import type { VerbInvocation } from '@ferretry/kernel/manifest';
import should from 'should';
import { loginAdd } from '../../../cli/lib/commands.ts';
import { PRESET_ENV_NAMES } from '../../../contract/preset-env-names.ts';
import { fakeWorld, type FakeAnswers, type FakeWorld, loginList } from './fakes.ts';

/** A fake key: it must be found in the Vault call and in NOTHING a person, a log or a file could see. */
const SENTINEL = 'SENTINEL-sk-9f3a7c21';
const BASE_URL = 'https://api.z.ai/api/anthropic';
const PROMPT = 'ZAI_API_KEY (hidden; press Enter when done): ';

const inv = (args: string[], options: VerbInvocation['options'] = {}): VerbInvocation => ({ args, options });
const half = (harness: string) => ({ harness, offered: { available: true }, models: [] });
const zai = {
  id: 'zai-glm',
  label: 'Z.ai GLM',
  harness: 'claude-code',
  offered: { available: true },
  halves: [half('claude-code')],
  variables: [
    { name: 'ANTHROPIC_BASE_URL', kind: 'plain', value: BASE_URL },
    { name: 'ANTHROPIC_AUTH_TOKEN', kind: 'secret', secret: 'ZAI_API_KEY' },
  ],
  detect: { hosts: ['api.z.ai'], variables: ['ZAI_API_KEY'], keyPrefixes: [] },
};
const view = {
  id: 'chg1',
  change: { kind: 'login.enable', id: 'work' },
  summary: 'Do it',
  consequences: [],
  expiresAt: '2026-11-01T10:15:00.000Z',
  state: 'pending',
};

/** A world whose daemon answers one preset, and a Vault holding `held` secrets. */
const world = (
  options: { hidden?: (string | undefined)[]; shell?: Record<string, string>; held?: string[] } = {},
  answers: Partial<FakeAnswers> = {},
): FakeWorld =>
  fakeWorld({
    ...(options.hidden === undefined ? {} : { hidden: options.hidden }),
    ...(options.shell === undefined ? {} : { shell: options.shell }),
    gateway: {
      logins: () => loginList(),
      presets: () => ({ presets: [zai] }) as never,
      stage: () => view as never,
      apply: () => ({ outcome: 'applied' }),
      secretNames: () => new Set(options.held ?? []),
      ...answers,
    },
  });

/** Everything a person, a pipe or a log could be shown: every channel, the staged change and the Vault's question. */
const everythingSeen = (made: FakeWorld): string =>
  JSON.stringify([
    made.out.lines,
    made.hiddenQuestions,
    made.gateway.called('stage').map(call => call.args),
    made.gateway.called('secretNames'),
  ]);

const stagedEnv = (made: FakeWorld): unknown =>
  (made.gateway.called('stage')[0]?.args[0] as { env: unknown } | undefined)?.env;

describe('login add asks for the provider’s secret, hidden', () => {
  it('should prompt without echo, store the value in the Vault and write only ${secret:NAME} into the login', async () => {
    const made = world({ hidden: [SENTINEL] });

    await loginAdd(made.deps, inv(['zai-glm'], { yes: true }));

    should(made.hiddenQuestions).eql([PROMPT]);
    should(made.gateway.called('putSecret').map(call => call.args)).eql([['ZAI_API_KEY', SENTINEL]]);
    should(stagedEnv(made)).eql({ ANTHROPIC_BASE_URL: BASE_URL, ANTHROPIC_AUTH_TOKEN: '${secret:ZAI_API_KEY}' });
    should(made.out.text('report')).containEql('ZAI_API_KEY: stored in the Vault ✓');
    should(made.out.text('report')).containEql('Test it: fz login test claude-zai-glm');
    should(everythingSeen(made)).not.containEql(SENTINEL);
  });

  it('should keep a secret the Vault already holds: no prompt, no store, said by name', async () => {
    const made = world({ hidden: [SENTINEL], held: ['ZAI_API_KEY'] });

    await loginAdd(made.deps, inv(['zai-glm'], { yes: true }));

    should(made.hiddenQuestions).eql([]);
    should(made.gateway.called('putSecret')).be.empty();
    should(made.out.text('report')).containEql('ZAI_API_KEY: already set ✓');
    should(made.gateway.called('stage')).have.length(1);
  });

  it('should refuse by name, storing nothing and staging nothing, when there is no terminal to type at', async () => {
    for (const none of [world(), world({ hidden: [undefined] })]) {
      await should(loginAdd(none.deps, inv(['zai-glm'], { yes: true }))).be.rejectedWith(
        'ZAI_API_KEY is needed and there is no terminal to type it at. Store it, then run this again: printf %s "$KEY" | fz secret set ZAI_API_KEY',
      );
      should(none.gateway.called('putSecret')).be.empty();
      should(none.gateway.called('stage')).be.empty();
    }
  });

  it('should store nothing when nothing was typed', async () => {
    const made = world({ hidden: [''] });
    await should(loginAdd(made.deps, inv(['zai-glm'], { yes: true }))).be.rejectedWith(
      'ZAI_API_KEY is needed: nothing was typed, so nothing was stored.',
    );
    should(made.gateway.called('putSecret')).be.empty();
    should(made.gateway.called('stage')).be.empty();
  });

  it('should not read the Vault, prompt or store on a dry run', async () => {
    const made = world({ hidden: [SENTINEL] });

    await loginAdd(made.deps, inv(['zai-glm'], { 'dry-run': true }));

    should(made.hiddenQuestions).eql([]);
    should(made.gateway.called('secretNames')).be.empty();
    should(made.gateway.called('putSecret')).be.empty();
    should(made.gateway.called('stage')).have.length(1);
  });

  it('should say nothing about the store in --json output, which stays one document', async () => {
    const made = world({ hidden: [SENTINEL] });

    await loginAdd(made.deps, inv(['zai-glm'], { yes: true, json: true }));

    should(made.gateway.called('putSecret')).have.length(1);
    should(made.out.text('report')).not.containEql('ZAI_API_KEY');
    should(everythingSeen(made)).not.containEql(SENTINEL);
  });

  it('should leave a secret the person pointed at their own reference to them, and ask for nothing', async () => {
    const made = world({ hidden: [SENTINEL] });

    await loginAdd(made.deps, inv(['zai-glm'], { yes: true, env: 'ANTHROPIC_AUTH_TOKEN=${secret:MINE}' }));

    should(made.hiddenQuestions).eql([]);
    should(made.gateway.called('secretNames')).be.empty();
    should(stagedEnv(made)).match({ ANTHROPIC_AUTH_TOKEN: '${secret:MINE}' });
  });

  it('should ask for no secret when the login is a sign-in or has no preset', async () => {
    const made = world({ hidden: [SENTINEL] });

    await loginAdd(made.deps, inv(['claude'], { yes: true, 'no-sign-in': true }));
    await loginAdd(made.deps, inv(['claude'], { yes: true, env: 'EXTRA=1' }));

    should(made.hiddenQuestions).eql([]);
    should(made.gateway.called('secretNames')).be.empty();
  });

  it('should ask once for a secret two variables carry', async () => {
    const both = {
      ...zai,
      variables: [
        ...zai.variables,
        { name: 'ZAI_API_KEY', kind: 'secret', secret: 'ZAI_API_KEY' },
        { name: 'ZAI_REGION', kind: 'secret' },
      ],
    };
    const made = world({ hidden: [SENTINEL, 'SENTINEL-region'] }, { presets: () => ({ presets: [both] }) as never });

    await loginAdd(made.deps, inv(['zai-glm'], { yes: true }));

    should(made.gateway.called('putSecret').map(call => call.args[0])).eql(['ZAI_API_KEY', 'ZAI_REGION']);
    should(everythingSeen(made)).not.containEql(SENTINEL);
  });
});

describe('login add --from-env', () => {
  const shell = { ANTHROPIC_BASE_URL: 'https://api.z.ai/api/other', ZAI_API_KEY: SENTINEL };

  it('should tell the provider from the shell, store its key from there without a prompt, and name only variables', async () => {
    const made = world({ shell });

    await loginAdd(made.deps, inv([], { 'from-env': true, yes: true }));

    should(made.out.text('warn')).equal('Detected Z.ai GLM from ANTHROPIC_BASE_URL, ZAI_API_KEY.');
    should(made.gateway.called('putSecret').map(call => call.args)).eql([['ZAI_API_KEY', SENTINEL]]);
    should(stagedEnv(made)).eql({
      ANTHROPIC_BASE_URL: 'https://api.z.ai/api/other',
      ANTHROPIC_AUTH_TOKEN: '${secret:ZAI_API_KEY}',
    });
    should(everythingSeen(made)).not.containEql(SENTINEL);
  });

  it('should read only the variables the presets declare, never the rest of the shell', async () => {
    const made = world({ shell: { ...shell, GITHUB_TOKEN: 'SENTINEL-other', ANTHROPIC_API_KEY: '' } });
    const asked: (readonly string[])[] = [];
    const read = made.deps.readEnvironment;
    const deps = {
      ...made.deps,
      readEnvironment: (names: readonly string[]) => {
        asked.push(names);
        return read?.(names) ?? {};
      },
    };

    await loginAdd(deps, inv([], { 'from-env': true, yes: true }));

    should(asked).eql([PRESET_ENV_NAMES]);
    should(PRESET_ENV_NAMES).containEql('ZAI_API_KEY').and.not.containEql('GITHUB_TOKEN');
    should(everythingSeen(made)).not.containEql('SENTINEL-other');
  });

  it('should use a key variable the preset itself names, and prefer a value the person typed with --env', async () => {
    const made = world({ shell: { ANTHROPIC_AUTH_TOKEN: SENTINEL, ANTHROPIC_BASE_URL: BASE_URL } });

    await loginAdd(
      made.deps,
      inv(['claude'], { 'from-env': true, yes: true, env: 'ANTHROPIC_BASE_URL=https://typed.example.test' }),
    );

    should(made.gateway.called('putSecret').map(call => call.args)).eql([['ZAI_API_KEY', SENTINEL]]);
    should(stagedEnv(made)).match({ ANTHROPIC_BASE_URL: 'https://typed.example.test' });
  });

  it('should skip detection for a named provider, and never replace a secret the Vault holds', async () => {
    const made = world({ shell, held: ['ZAI_API_KEY'] });

    await loginAdd(made.deps, inv(['zai-glm'], { 'from-env': true, yes: true }));

    should(made.out.text('warn')).equal('');
    should(made.gateway.called('putSecret')).be.empty();
    should(made.out.text('report')).containEql('ZAI_API_KEY: already set ✓');
  });

  it('should fall back to the hidden prompt for a secret the shell does not carry', async () => {
    const made = world({ shell: { ANTHROPIC_BASE_URL: BASE_URL }, hidden: [SENTINEL] });

    await loginAdd(made.deps, inv([], { 'from-env': true, yes: true }));

    should(made.gateway.called('putSecret').map(call => call.args)).eql([['ZAI_API_KEY', SENTINEL]]);
  });

  it('should read nothing and say so when this command line cannot read the shell', async () => {
    const made = world();
    await should(loginAdd(made.deps, inv([], { 'from-env': true }))).be.rejectedWith(
      /cannot read your shell's variables, so --from-env reads nothing/u,
    );
    should(made.gateway.called('stage')).be.empty();
  });

  it('should refuse by name when no provider can be told from the shell, empty values counting for nothing', async () => {
    const nothing: Record<string, string>[] = [{ API_TIMEOUT_MS: '1000' }, { ZAI_API_KEY: '' }, {}];
    for (const none of nothing) {
      const made = world({ shell: none });
      await should(loginAdd(made.deps, inv([], { 'from-env': true }))).be.rejectedWith(
        "No provider could be told from this shell's variables. Name it: fz login add <provider> (see `fz login presets`)",
      );
      should(made.gateway.called('putSecret')).be.empty();
    }
  });

  it('should still refuse to add with nothing named and no --from-env', async () => {
    await should(loginAdd(world().deps, inv([]))).be.rejectedWith(/^Name a tool or provider/u);
  });

  it('should skip a preset that declares no clues when detecting', async () => {
    const quiet = { ...zai, id: 'quiet', detect: undefined };
    const made = world({ shell }, { presets: () => ({ presets: [quiet, zai] }) as never });

    await loginAdd(made.deps, inv([], { 'from-env': true, yes: true }));

    should(made.gateway.called('stage')[0]?.args[0]).match({ preset: 'zai-glm' });
  });
});
