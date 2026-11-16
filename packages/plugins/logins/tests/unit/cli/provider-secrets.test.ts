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

  describe('when the Vault refuses', () => {
    const SECOND_KEY = 'SENTINEL-second';
    const two = {
      ...zai,
      variables: [...zai.variables, { name: 'ZAI_REGION', kind: 'secret', secret: 'ZAI_REGION_KEY' }],
    };
    const refusing = (accepting: number, failure: (value: string) => Error) => {
      let puts = 0;
      const made = world(
        { hidden: [SENTINEL, SECOND_KEY] },
        {
          presets: () => ({ presets: [two] }) as never,
          putSecret: () => {
            puts += 1;
            if (puts > accepting) throw failure(puts === 1 ? SENTINEL : SECOND_KEY);
          },
        },
      );
      return { made };
    };
    const daemon = (message: string) => Object.assign(new Error(message), { status: 403, code: 'ownerOnly' });

    it('should name the secret and the daemon’s words, stage nothing and keep every value out of every channel', async () => {
      const { made } = refusing(0, () => daemon('only the owner may set a secret.'));

      await should(loginAdd(made.deps, inv(['zai-glm'], { yes: true }))).be.rejectedWith(
        'ZAI_API_KEY was not stored: only the owner may set a secret. The login was not added.',
      );

      should(made.gateway.called('stage')).be.empty();
      should(everythingSeen(made)).not.containEql('SENTINEL');
    });

    it('should name what stays in the Vault when a later secret is refused, and take an echoed value out of the words', async () => {
      const { made } = refusing(1, value => daemon(`refused ${value}`));

      await should(loginAdd(made.deps, inv(['zai-glm'], { yes: true }))).be.rejectedWith(
        'ZAI_REGION_KEY was not stored: refused …. The login was not added. ZAI_API_KEY was stored before it and stays in the Vault.',
      );

      should(made.gateway.called('stage')).be.empty();
    });

    it('should say nothing of a failure that is not the daemon’s answer, which may hold anything', async () => {
      const { made } = refusing(0, value => new Error(`unreadable ${value}`));

      await should(loginAdd(made.deps, inv(['zai-glm'], { yes: true }))).be.rejectedWith(
        'ZAI_API_KEY was not stored. The login was not added.',
      );
    });
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
    // The shell's address is on the preset's own host (api.z.ai), so it is taken: the shell's setting wins over the default.
    should(stagedEnv(made)).eql({
      ANTHROPIC_BASE_URL: 'https://api.z.ai/api/other',
      ANTHROPIC_AUTH_TOKEN: '${secret:ZAI_API_KEY}',
    });
    should(everythingSeen(made)).not.containEql(SENTINEL);
  });

  describe('a setting the shell declares for a variable the preset already fills', () => {
    const keyless = (id: string, variables: Record<string, unknown>[]) => ({
      ...zai,
      id,
      label: id,
      variables,
      detect: undefined,
    });
    const plain = (name: string, value: string) => ({
      name,
      kind: 'plain',
      value,
      required: false,
      allowEmpty: false,
    });
    const KEY = 'SENTINEL-sk-ant-shell-credential';
    const staging = async (
      presets: Record<string, unknown>[],
      named: string,
      shellValues: Record<string, string>,
      held: string[] = [],
    ) => {
      const made = world({ shell: shellValues, held }, { presets: () => ({ presets }) as never });
      await loginAdd(made.deps, inv([named], { 'from-env': true, yes: true }));
      return made;
    };

    it('should stage the shell’s AWS_REGION, not the preset’s default, for a bedrock-shaped preset', async () => {
      const bedrock = keyless('bedrock', [plain('CLAUDE_CODE_USE_BEDROCK', '1'), plain('AWS_REGION', 'us-east-1')]);

      const made = await staging([bedrock], 'bedrock', { CLAUDE_CODE_USE_BEDROCK: '1', AWS_REGION: 'eu-west-1' });

      should(stagedEnv(made)).eql({ CLAUDE_CODE_USE_BEDROCK: '1', AWS_REGION: 'eu-west-1' });
    });

    it('should keep the preset’s default when the shell does not declare the variable', async () => {
      const bedrock = keyless('bedrock', [plain('CLAUDE_CODE_USE_BEDROCK', '1'), plain('AWS_REGION', 'us-east-1')]);

      const made = await staging([bedrock], 'bedrock', { CLAUDE_CODE_USE_BEDROCK: '1' });

      should(stagedEnv(made)).eql({ CLAUDE_CODE_USE_BEDROCK: '1', AWS_REGION: 'us-east-1' });
    });

    it('should stage the shell’s CLOUD_ML_REGION for a vertex-shaped preset', async () => {
      const vertex = keyless('vertex', [plain('CLAUDE_CODE_USE_VERTEX', '1'), plain('CLOUD_ML_REGION', 'us-east5')]);

      const made = await staging([vertex], 'vertex', { CLOUD_ML_REGION: 'europe-west1' });

      should(stagedEnv(made)).eql({ CLAUDE_CODE_USE_VERTEX: '1', CLOUD_ML_REGION: 'europe-west1' });
    });

    it('should stage the shell’s Foundry deployment names, each in its own variable', async () => {
      const foundry = keyless(
        'foundry',
        ['OPUS', 'SONNET', 'HAIKU'].map(tier =>
          plain(`ANTHROPIC_DEFAULT_${tier}_MODEL`, `claude-${tier.toLowerCase()}`),
        ),
      );

      const made = await staging([foundry], 'foundry', {
        ANTHROPIC_DEFAULT_OPUS_MODEL: 'my-opus',
        ANTHROPIC_DEFAULT_HAIKU_MODEL: 'my-haiku',
      });

      should(stagedEnv(made)).eql({
        ANTHROPIC_DEFAULT_OPUS_MODEL: 'my-opus',
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-sonnet',
        ANTHROPIC_DEFAULT_HAIKU_MODEL: 'my-haiku',
      });
    });

    it('should keep the preset’s address when the shell’s base URL is on another host, and say so by name', async () => {
      const made = await staging([zai], 'zai-glm', { ANTHROPIC_BASE_URL: 'https://other-host.example.test/v1' }, [
        'ZAI_API_KEY',
      ]);

      should(stagedEnv(made)).eql({ ANTHROPIC_BASE_URL: BASE_URL, ANTHROPIC_AUTH_TOKEN: '${secret:ZAI_API_KEY}' });
      should(made.out.text('warn')).equal(
        "ANTHROPIC_BASE_URL in this shell points elsewhere; kept the preset's. Pass --env to change it.",
      );
      should(JSON.stringify([made.out.lines, made.gateway.calls])).not.containEql('other-host');
    });

    it('should keep the preset’s address when the shell’s base URL is not an address at all, and say so by name', async () => {
      const made = await staging([zai], 'zai-glm', { ANTHROPIC_BASE_URL: 'other-host.example.test/v1' }, [
        'ZAI_API_KEY',
      ]);

      should(stagedEnv(made)).eql({ ANTHROPIC_BASE_URL: BASE_URL, ANTHROPIC_AUTH_TOKEN: '${secret:ZAI_API_KEY}' });
      should(made.out.text('warn')).equal(
        "ANTHROPIC_BASE_URL in this shell points elsewhere; kept the preset's. Pass --env to change it.",
      );
      should(JSON.stringify([made.out.lines, made.gateway.calls])).not.containEql('other-host');
    });

    it('should say nothing, and never print the address, for a shell base URL the stored rule refuses', async () => {
      const made = await staging(
        [zai],
        'zai-glm',
        { ANTHROPIC_BASE_URL: 'https://user:hunter2@other-host.example.test/v1' },
        ['ZAI_API_KEY'],
      );

      should(stagedEnv(made)).match({ ANTHROPIC_BASE_URL: BASE_URL });
      should(JSON.stringify([made.out.lines, made.gateway.calls])).not.containEql('hunter2');
      should(JSON.stringify([made.out.lines, made.gateway.calls])).not.containEql('other-host');
    });

    it('should take a base URL on the preset’s own host', async () => {
      const litellm = keyless('litellm', [
        { ...plain('ANTHROPIC_BASE_URL', 'http://localhost:4000'), required: true },
        plain('ANTHROPIC_MODEL', 'qwen'),
      ]);

      const made = await staging([litellm], 'litellm', {
        ANTHROPIC_BASE_URL: 'http://localhost:8080',
        ANTHROPIC_MODEL: 'my-model',
      });

      should(stagedEnv(made)).eql({ ANTHROPIC_BASE_URL: 'http://localhost:8080', ANTHROPIC_MODEL: 'my-model' });
      should(made.out.text('warn')).equal('');
    });

    it('should never replace a variable the preset deliberately leaves empty or one named like a credential', async () => {
      const openrouter = keyless('openrouter', [
        plain('ANTHROPIC_BASE_URL', 'https://openrouter.ai/api'),
        { name: 'ANTHROPIC_API_KEY', kind: 'plain', value: '', required: false, allowEmpty: true },
        plain('ANTHROPIC_AUTH_TOKEN', 'x'),
      ]);

      const made = await staging([openrouter], 'openrouter', {
        ANTHROPIC_API_KEY: KEY,
        ANTHROPIC_AUTH_TOKEN: KEY,
      });

      should(stagedEnv(made)).eql({
        ANTHROPIC_BASE_URL: 'https://openrouter.ai/api',
        ANTHROPIC_API_KEY: '',
        ANTHROPIC_AUTH_TOKEN: 'x',
      });
      should(JSON.stringify(made.gateway.calls)).not.containEql(KEY);
    });
  });

  const gateway = {
    ...zai,
    id: 'custom-gateway',
    label: 'Custom gateway',
    variables: [
      { name: 'ANTHROPIC_BASE_URL', kind: 'plain', value: '', required: true, allowEmpty: false },
      { name: 'ANTHROPIC_AUTH_TOKEN', kind: 'secret', secret: 'GATEWAY_API_KEY' },
      { name: 'ANTHROPIC_API_KEY', kind: 'plain', value: '', required: false, allowEmpty: true },
      { name: 'ANTHROPIC_MODEL', kind: 'plain', value: '', required: false, allowEmpty: false },
    ],
    detect: { hosts: [], variables: [], keyPrefixes: [] },
  };
  const ANTHROPIC = 'SENTINEL-sk-ant-real-anthropic-key';

  it('should never copy a shell credential into a plain variable the preset deliberately leaves empty', async () => {
    const made = world(
      {
        shell: {
          ANTHROPIC_BASE_URL: 'https://gateway.example.test',
          ANTHROPIC_API_KEY: ANTHROPIC,
          ANTHROPIC_MODEL: 'm',
        },
        hidden: [SENTINEL],
      },
      { presets: () => ({ presets: [gateway] }) as never },
    );

    await loginAdd(made.deps, inv(['custom-gateway'], { 'from-env': true, yes: true }));

    // The required, empty address comes from the shell; the deliberately empty key stays empty; an optional one is not read.
    should(stagedEnv(made)).eql({
      ANTHROPIC_BASE_URL: 'https://gateway.example.test',
      ANTHROPIC_AUTH_TOKEN: '${secret:GATEWAY_API_KEY}',
      ANTHROPIC_API_KEY: '',
      ANTHROPIC_MODEL: '',
    });
    should(made.gateway.called('putSecret').map(call => call.args)).eql([['GATEWAY_API_KEY', SENTINEL]]);
    // The Anthropic key reached neither the stage body nor the Vault nor any line a person could see.
    should(JSON.stringify([everythingSeen(made), made.gateway.called('putSecret')])).not.containEql(ANTHROPIC);
  });

  it('should not send the shell’s Anthropic key anywhere when --preset names the gateway under --from-env', async () => {
    const made = world(
      {
        shell: { ANTHROPIC_BASE_URL: 'https://gateway.example.test', ANTHROPIC_API_KEY: ANTHROPIC },
        hidden: [SENTINEL],
      },
      {
        presets: () =>
          ({ presets: [{ ...gateway, detect: { hosts: [], variables: [], keyPrefixes: [] } }, zai] }) as never,
      },
    );

    await loginAdd(made.deps, inv([], { 'from-env': true, yes: true, preset: 'custom-gateway' }));

    should(JSON.stringify(made.gateway.calls)).not.containEql(ANTHROPIC);
  });

  it('should refuse a shell address that carries a user or a key, filling nothing from it', async () => {
    const made = world(
      { shell: { ANTHROPIC_BASE_URL: 'https://user:hunter2@gateway.example.test' }, hidden: [SENTINEL] },
      { presets: () => ({ presets: [gateway] }) as never },
    );

    await loginAdd(made.deps, inv(['custom-gateway'], { 'from-env': true, yes: true }));

    should(stagedEnv(made)).match({ ANTHROPIC_BASE_URL: '' });
    should(JSON.stringify(made.gateway.calls)).not.containEql('hunter2');
  });

  it('should never fill a credential-named variable from the shell, even a required empty plain one', async () => {
    const odd = {
      ...gateway,
      variables: [{ name: 'ANTHROPIC_API_KEY', kind: 'plain', value: '', required: true, allowEmpty: false }],
    };
    const made = world({ shell: { ANTHROPIC_API_KEY: ANTHROPIC } }, { presets: () => ({ presets: [odd] }) as never });

    await loginAdd(made.deps, inv(['custom-gateway'], { 'from-env': true, yes: true }));

    should(stagedEnv(made)).eql({ ANTHROPIC_API_KEY: '' });
    should(JSON.stringify(made.gateway.calls)).not.containEql(ANTHROPIC);
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

  it('should say nothing matched when the shell has variables but none points at a provider', async () => {
    const made = world({ shell: { API_TIMEOUT_MS: '1000' } });
    await should(loginAdd(made.deps, inv([], { 'from-env': true }))).be.rejectedWith(
      "No provider could be told from this shell's variables. Name it: fz login add <provider> (see `fz login presets`)",
    );
    should(made.gateway.called('putSecret')).be.empty();
  });

  it('should say nothing was read, apart from nothing matched, when no variable is declared, set or readable', async () => {
    for (const none of [{ ZAI_API_KEY: '' }, {} as Record<string, string>]) {
      const made = world({ shell: none });
      await should(loginAdd(made.deps, inv([], { 'from-env': true }))).be.rejectedWith(
        'Nothing was read: none of the variables the providers name is set, declared or readable in this shell. Name it: fz login add <provider> (see `fz login presets`)',
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
