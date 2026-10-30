import { describe, it } from 'bun:test';
import type { FleetPresetVariable, FleetProviderPresetView } from '@ferretry/protocol';
import should from 'should';
import { registerCredentialCommands, suggestCredentialId } from '../../../src/lib/credential/commands.ts';
import { renderCredentialList } from '../../../src/lib/credential/render.ts';
import { authorityOf, credential, fakeWorld, flow, machine, runCommand } from '../fleet/account-fakes.ts';

const needsSignIn = credential({
  id: 'codex-work',
  harness: 'codex',
  store: 'ferretry',
  email: undefined,
  label: 'work',
  sharedWithTerminal: false,
  needsLabel: true,
  status: {
    word: 'needs_sign_in',
    label: 'Needs sign-in',
    reason: 'not_signed_in',
    explanation: 'Nobody has signed in yet.',
    lastCheckInconclusive: false,
  },
  usage: { fiveHour: {}, weekly: { usedPercent: 50 } },
  usedBy: [],
});

/** A preset variable for one-click fixtures: `required`/`allowEmpty` default to the common case. */
const clickVar = (overrides: Record<string, unknown>): FleetPresetVariable =>
  ({ required: true, allowEmpty: false, ...overrides }) as FleetPresetVariable;

const GLM_CLICK: FleetProviderPresetView = {
  id: 'zai-glm',
  label: 'GLM / Z.ai',
  harness: 'claude',
  summary: 'Claude Code on GLM.',
  docs: 'https://docs.z.ai/devpack/tool/claude',
  origin: 'built-in',
  variables: [
    clickVar({ name: 'ANTHROPIC_BASE_URL', kind: 'plain', value: 'https://api.z.ai/api/anthropic' }),
    clickVar({ name: 'ANTHROPIC_AUTH_TOKEN', kind: 'secret', secret: 'ZAI_API_KEY' }),
  ],
  models: ['glm-5.3'],
  test: { available: true, spends: 'nothing', note: 'Reads your quota.' },
  quota: { source: 'zai-coding-plan', note: 'Coding Plan quota.' },
  unverified: [],
  verified: '2026-10-16',
  offered: { available: true },
};

const AMAZON_BEDROCK_CLICK: FleetProviderPresetView = {
  ...GLM_CLICK,
  id: 'amazon-bedrock',
  label: 'Amazon Bedrock (AWS profile)',
  variables: [clickVar({ name: 'CLAUDE_CODE_USE_BEDROCK', kind: 'plain', value: '1' })],
};

const BEDROCK_MANTLE_CLICK: FleetProviderPresetView = {
  ...GLM_CLICK,
  id: 'bedrock-mantle',
  label: 'Bedrock Mantle (AWS profile)',
  variables: [clickVar({ name: 'CLAUDE_CODE_USE_BEDROCK_MANTLE', kind: 'plain', value: '1' })],
};

const NOT_OFFERED_CLICK: FleetProviderPresetView = {
  ...GLM_CLICK,
  id: 'nope-provider',
  label: 'Nope Provider',
  offered: { available: false, reason: 'Needs a model catalogue file.' },
};

const TWO_SECRETS_CLICK: FleetProviderPresetView = {
  ...GLM_CLICK,
  id: 'two-secrets',
  label: 'Two Secrets',
  variables: [
    clickVar({ name: 'FIRST_TOKEN', kind: 'secret', secret: 'FIRST_KEY' }),
    clickVar({ name: 'SECOND_TOKEN', kind: 'secret', secret: 'SECOND_KEY' }),
  ],
};

const AZURE_CLICK: FleetProviderPresetView = {
  id: 'azure-openai',
  label: 'Azure OpenAI',
  harness: 'codex',
  summary: 'Codex on your Azure OpenAI resource.',
  docs: 'https://learn.microsoft.com/azure',
  origin: 'built-in',
  variables: [
    clickVar({ name: 'AZURE_OPENAI_RESOURCE', kind: 'plain', value: '', description: 'the resource name' }),
    clickVar({ name: 'AZURE_OPENAI_API_KEY', kind: 'secret', secret: 'AZURE_OPENAI_API_KEY' }),
  ],
  models: [],
  test: { available: true, spends: 'nothing', note: 'Lists the models on your resource.' },
  quota: { source: 'transcript-pricing', note: 'Azure reports quota in the portal only.' },
  unverified: [],
  verified: '2026-10-16',
  offered: { available: true },
};

const DEEPSEEK_CLICK: FleetProviderPresetView = {
  id: 'deepseek',
  label: 'DeepSeek',
  harness: 'claude',
  summary: 'Claude Code and Codex on DeepSeek models with one DeepSeek platform key.',
  docs: 'https://api-docs.deepseek.com/quick_start',
  origin: 'built-in',
  variables: [
    clickVar({
      name: 'ANTHROPIC_BASE_URL',
      kind: 'plain',
      value: 'https://api.deepseek.com/anthropic',
      harnesses: ['claude'],
    }),
    clickVar({ name: 'ANTHROPIC_AUTH_TOKEN', kind: 'secret', secret: 'DEEPSEEK_API_KEY', harnesses: ['claude'] }),
    clickVar({ name: 'DEEPSEEK_API_KEY', kind: 'secret', secret: 'DEEPSEEK_API_KEY', harnesses: ['codex'] }),
  ],
  models: ['deepseek-flash'],
  test: { available: true, spends: 'nothing', note: 'Lists the models the key can use.' },
  quota: { source: 'deepseek-balance', note: 'Your DeepSeek balance.' },
  unverified: [],
  verified: '2026-10-16',
  offered: { available: true },
  halves: [
    { harness: 'claude', offered: { available: true }, models: ['deepseek-flash'] },
    { harness: 'codex', offered: { available: true }, models: ['deepseek-flash'] },
  ],
  detect: { hosts: ['api.deepseek.com'], variables: ['DEEPSEEK_*'], keyPrefixes: [] },
};

const DEEPSEEK_CODEX_GAP_CLICK: FleetProviderPresetView = {
  ...DEEPSEEK_CLICK,
  id: 'deepseek-half-gap',
  label: 'DeepSeek (gap)',
  halves: [
    { harness: 'claude', offered: { available: true }, models: ['deepseek-flash'] },
    { harness: 'codex', offered: { available: false, reason: 'Needs a model catalogue file.' }, models: [] },
  ],
};

describe('suggestCredentialId', () => {
  it('should make an id from the tool and label, and add a number until it is free', () => {
    should(suggestCredentialId('claude', 'Work Mac!', new Set())).equal('claude-work-mac');
    should(suggestCredentialId('codex', undefined, new Set(['codex-login', 'codex-login-2']))).equal('codex-login-3');
  });
});

describe('renderCredentialList', () => {
  it('should show each login, where it lives and the sign-in command for one that needs it', () => {
    // Arrange
    const list = {
      format: 2 as const,
      machine: 'studio',
      credentials: [
        credential(),
        needsSignIn,
        credential({ id: 'env', store: 'environment', sharedWithTerminal: false, email: undefined }),
        credential({ id: 'slot', store: 'ferretry', sharedWithTerminal: false, clonedFrom: 'laptop' }),
      ],
    };

    // Act
    const text = renderCredentialList(list, 'fz');

    // Assert
    should(text).match(/claude-you {2}Claude Code {2}you@example\.com {2}— Ready/);
    should(text).match(/5-hour 12% used · weekly not measured yet/);
    should(text).match(/shared with claude in your terminal/);
    should(text).match(/codex-work {2}Codex {2}work {2}— Needs sign-in/);
    should(text)
      .match(/Used by: no runtime yet/)
      .and.match(/give one a label/)
      .and.match(/kept by Ferretry/);
    should(text)
      .match(/read from the environment/)
      .and.match(/copied from laptop/);
    should(text).match(/Needs sign-in:\n {2}fz credential signin codex-work$/);
  });

  it('should say how to add the first login', () => {
    should(renderCredentialList({ format: 2, machine: 'studio', credentials: [] }, 'fz')).match(
      /fz credential add claude/,
    );
  });
});

describe('registerCredentialCommands', () => {
  it('should refuse the add and the sign-in for a caller that needs a passkey confirmation', async () => {
    const world = fakeWorld({
      gateway: {
        machine: () => machine({ authority: authorityOf({ mayApply: false, applyRefusal: 'step-up-required' }) }),
      },
    });
    await should(runCommand(registerCredentialCommands, world, ['credential', 'add', 'claude'])).be.rejectedWith(
      /passkey confirmation/,
    );
    should(world.gateway.called('stage')).be.empty();
    should(world.gateway.called('startSignIn')).be.empty();
  });

  it('should list the logins, or print them as JSON', async () => {
    const world = fakeWorld({
      gateway: { credentials: () => ({ format: 2, machine: 'studio', credentials: [credential()] }) },
    });
    await runCommand(registerCredentialCommands, world, ['credentials']);
    should(world.out.text('report')).match(/Logins on studio/);

    const json = fakeWorld();
    await runCommand(registerCredentialCommands, json, ['credentials', '--json']);
    should(JSON.parse(json.out.text('report')).machine).equal('studio');
  });

  it('should add a login with a free id and then sign it in', async () => {
    // Arrange
    const world = fakeWorld({
      gateway: {
        credentials: () => ({ format: 2, machine: 'studio', credentials: [credential({ id: 'claude-work' })] }),
      },
    });

    // Act
    await runCommand(registerCredentialCommands, world, ['credential', 'add', 'Claude', '--label', 'work']);

    // Assert
    should(world.gateway.called('stage')[0]?.args[0]).eql({
      kind: 'credential.add',
      id: 'claude-work-2',
      harness: 'claude',
      label: 'work',
    });
    should(world.gateway.called('startSignIn')[0]?.args[0]).equal('claude-work-2');
    should(world.out.text('success')).match(/Signed in\. claude-work-2/);
  });

  it('should add without signing in when asked, and not sign in after a dry run', async () => {
    const later = fakeWorld();
    await runCommand(registerCredentialCommands, later, [
      'credential',
      'add',
      'codex',
      '--id',
      'codex-x',
      '--no-sign-in',
    ]);
    should(later.gateway.called('startSignIn')).be.empty();
    should(later.out.text('report')).match(/fz credential signin codex-x/);

    const dry = fakeWorld();
    await runCommand(registerCredentialCommands, dry, ['credential', 'add', 'codex', '--dry-run']);
    should(dry.gateway.called('startSignIn')).be.empty();
  });

  it('should treat a word that is neither claude nor codex as a provider, and refuse an unknown one', async () => {
    const world = fakeWorld();
    await should(runCommand(registerCredentialCommands, world, ['credential', 'add', 'gemini'])).be.rejectedWith(
      'There is no provider "gemini": see `fz login presets`',
    );
  });

  it('should exit non-zero when a check finds the login needs sign-in', async () => {
    // Arrange
    const world = fakeWorld({ gateway: { check: () => needsSignIn } });

    // Act
    await runCommand(registerCredentialCommands, world, ['credential', 'check', 'codex-work']);

    // Assert
    should(world.out.text('report')).match(/Needs sign-in/);
    should(world.out.text('error')).equal('codex-work needs sign-in: fz credential signin codex-work');
    should(world.out.exitCode).equal(1);
  });

  it('should pass a check that is fine, and print it as JSON', async () => {
    const world = fakeWorld();
    await runCommand(registerCredentialCommands, world, ['credential', 'check', 'claude-you']);
    should(world.out.exitCode).be.undefined();

    const json = fakeWorld({ gateway: { check: () => needsSignIn } });
    await runCommand(registerCredentialCommands, json, ['credential', 'check', 'codex-work', '--json']);
    should(JSON.parse(json.out.text('report')).id).equal('codex-work');
    should(json.out.text('error')).equal('');
    should(json.out.exitCode).equal(1);
  });

  it('should sign in, and exit non-zero when it fails', async () => {
    const world = fakeWorld({
      gateway: { startSignIn: () => flow({ state: 'failed', reason: 'no', remedy: 'retry' }) },
    });
    await runCommand(registerCredentialCommands, world, ['credential', 'signin', 'claude-you']);
    should(world.out.exitCode).equal(1);
  });

  it('should start a sign-in over only when forced', async () => {
    // Arrange
    const world = fakeWorld();

    // Act
    await runCommand(registerCredentialCommands, world, ['credential', 'signin', 'codex-you']);
    await runCommand(registerCredentialCommands, world, ['credential', 'signin', 'codex-you', '--force']);

    // Assert
    should(world.gateway.called('startSignIn').map(call => call.args)).eql([['codex-you'], ['codex-you', 'restart']]);
  });

  it('should sign out and remove only after a yes', async () => {
    const world = fakeWorld({ answers: ['y', 'n'] });
    await runCommand(registerCredentialCommands, world, ['credential', 'signout', 'claude-you']);
    await runCommand(registerCredentialCommands, world, ['credential', 'rm', 'claude-you']);
    should(world.gateway.called('stage').map(call => call.args[0])).eql([
      { kind: 'credential.signout', id: 'claude-you' },
      { kind: 'credential.remove', id: 'claude-you' },
    ]);
    should(world.gateway.called('apply')).have.length(1);
  });

  it('should label a login, clear a label, and refuse an empty one', async () => {
    const world = fakeWorld();
    await runCommand(registerCredentialCommands, world, ['credential', 'label', 'claude-you', ' work ']);
    await runCommand(registerCredentialCommands, world, ['credential', 'label', 'claude-you', '--clear']);
    should(world.gateway.called('stage').map(call => call.args[0])).eql([
      { kind: 'credential.label', id: 'claude-you', label: 'work' },
      { kind: 'credential.label', id: 'claude-you', label: null },
    ]);
    await should(
      runCommand(registerCredentialCommands, fakeWorld(), ['credential', 'label', 'claude-you']),
    ).be.rejectedWith(/--clear/);
  });
});

describe('registerCredentialCommands — the product’s word for a credential', () => {
  it('should list the logins under `logins` exactly as under `credentials`', async () => {
    const gateway = { credentials: () => ({ format: 2 as const, machine: 'studio', credentials: [credential()] }) };
    const long = fakeWorld({ gateway });
    const short = fakeWorld({ gateway });
    await runCommand(registerCredentialCommands, long, ['credentials']);
    await runCommand(registerCredentialCommands, short, ['logins']);
    should(short.out.text('report')).equal(long.out.text('report'));
  });

  it('should add a login under `login` exactly as under `credential`', async () => {
    const long = fakeWorld();
    const short = fakeWorld();
    await runCommand(registerCredentialCommands, long, [
      'credential',
      'add',
      'codex',
      '--id',
      'codex-x',
      '--no-sign-in',
    ]);
    await runCommand(registerCredentialCommands, short, ['login', 'add', 'codex', '--id', 'codex-x', '--no-sign-in']);
    should(short.gateway.called('stage')[0]?.args[0]).eql(long.gateway.called('stage')[0]?.args[0]);
    should(short.out.text('report')).equal(long.out.text('report'));
  });
});

describe('environment logins (docs/provider-presets.md)', () => {
  const variable = (overrides: Record<string, unknown>): FleetPresetVariable =>
    ({ required: true, allowEmpty: false, ...overrides }) as FleetPresetVariable;
  const GLM = {
    id: 'zai-glm',
    label: 'GLM / Z.ai',
    harness: 'claude' as const,
    summary: 'Claude Code on GLM.',
    docs: 'https://docs.z.ai/devpack/tool/claude',
    origin: 'built-in' as const,
    variables: [
      variable({ name: 'ANTHROPIC_BASE_URL', kind: 'plain', value: 'https://api.z.ai/api/anthropic' }),
      variable({ name: 'ANTHROPIC_AUTH_TOKEN', kind: 'secret', secret: 'ZAI_API_KEY' }),
      variable({ name: 'ANTHROPIC_MODEL', kind: 'plain' }),
      variable({ name: 'ODD', kind: 'secret' }),
    ],
    models: ['glm-5.3'],
    test: { available: true as const, spends: 'nothing' as const, note: 'Reads your quota.' },
    quota: { source: 'zai-coding-plan' as const, note: 'Coding Plan quota.' },
    unverified: [],
    verified: '2026-10-16',
    offered: { available: true as const },
  };
  const BEDROCK = {
    ...GLM,
    id: 'amazon-bedrock',
    label: 'Amazon Bedrock',
    variables: [variable({ name: 'CLAUDE_CODE_USE_BEDROCK', kind: 'plain', value: '1' })],
    cloudCredential: { kinds: ['aws-profile' as const], suggested: 'aws-profile:default' },
    test: { available: false as const, reason: 'Needs request signing.' },
  };
  const CODEX_GLM = {
    ...GLM,
    id: 'zai-glm-codex',
    harness: 'codex' as const,
    test: { available: true as const, spends: 'one-token' as const, note: 'One token.' },
    offered: { available: false as const, reason: 'Needs a model catalogue file.' },
  };
  const presets = () => ({ presets: [GLM, BEDROCK, CODEX_GLM] });

  it('should add a login from a preset, its secrets as references and an --env overriding a value', async () => {
    // Arrange
    const world = fakeWorld({ gateway: { presets } });

    // Act
    await runCommand(registerCredentialCommands, world, [
      'login',
      'add',
      'claude',
      '--preset',
      'zai-glm',
      '--env',
      'ANTHROPIC_MODEL=glm-5.3',
    ]);

    // Assert — nothing to sign in to, and the next step is said
    should(world.gateway.called('stage')[0]?.args[0]).eql({
      kind: 'credential.add',
      id: 'claude-zai-glm',
      harness: 'claude',
      store: 'environment',
      preset: 'zai-glm',
      env: {
        ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',
        ANTHROPIC_AUTH_TOKEN: '${secret:ZAI_API_KEY}',
        ANTHROPIC_MODEL: 'glm-5.3',
        ODD: '${secret:ODD}',
      },
    });
    should(world.gateway.called('startSignIn')).be.empty();
    should(world.out.text('report')).match(/fz secret set NAME`, then: fz login test claude-zai-glm/);
  });

  it("should take a preset's suggested cloud credential unless one is given, and --env alone without a preset", async () => {
    // Arrange
    const suggested = fakeWorld({ gateway: { presets } });
    const given = fakeWorld({ gateway: { presets } });
    const bare = fakeWorld();

    // Act
    await runCommand(registerCredentialCommands, suggested, ['login', 'add', 'claude', '--preset', 'amazon-bedrock']);
    await runCommand(registerCredentialCommands, given, [
      'login',
      'add',
      'claude',
      '--preset',
      'amazon-bedrock',
      '--cloud-credential',
      'aws-profile:acme',
    ]);
    await runCommand(registerCredentialCommands, bare, ['login', 'add', 'claude', '--env', 'A=1', '--env', 'B=x=y']);

    // Assert
    should(suggested.gateway.called('stage')[0]?.args[0]).containDeep({ cloudCredential: 'aws-profile:default' });
    should(given.gateway.called('stage')[0]?.args[0]).containDeep({ cloudCredential: 'aws-profile:acme' });
    should(bare.gateway.called('stage')[0]?.args[0]).eql({
      kind: 'credential.add',
      id: 'claude-login',
      harness: 'claude',
      store: 'environment',
      env: { A: '1', B: 'x=y' },
    });
    should(bare.gateway.called('presets')).be.empty();
  });

  it('should refuse an unknown preset, a preset of the other tool, and an --env that is not NAME=VALUE', async () => {
    await should(
      runCommand(registerCredentialCommands, fakeWorld({ gateway: { presets } }), [
        'login',
        'add',
        'claude',
        '--preset',
        'nope',
      ]),
    ).be.rejectedWith(/There is no preset nope: see `fz login presets`/);
    await should(
      runCommand(registerCredentialCommands, fakeWorld({ gateway: { presets } }), [
        'login',
        'add',
        'codex',
        '--preset',
        'zai-glm',
      ]),
    ).be.rejectedWith('GLM / Z.ai is a preset for Claude Code, not Codex');
    await should(
      runCommand(registerCredentialCommands, fakeWorld(), ['login', 'add', 'claude', '--env', 'NOEQUALS']),
    ).be.rejectedWith('Write --env as NAME=VALUE, not NOEQUALS');
  });

  it('should test a login, say how to consent to one token, and fail the exit code when it did not pass', async () => {
    // Arrange
    const passed = fakeWorld();
    const consent = fakeWorld({
      gateway: {
        test: () => ({
          credentialId: 'qwen',
          ok: false,
          code: 'consent_required',
          message: 'This provider has no free check.',
          spent: 'nothing',
          at: '2026-10-16T09:00:00.000Z',
        }),
      },
    });
    const json = fakeWorld();

    // Act
    await runCommand(registerCredentialCommands, passed, ['login', 'test', 'glm']);
    await runCommand(registerCredentialCommands, consent, ['login', 'test', 'qwen']);
    await runCommand(registerCredentialCommands, json, ['login', 'test', 'glm', '--allow-inference', '--json']);

    // Assert
    should(passed.out.text('report')).equal('glm: The provider accepted this login.');
    should(passed.out.exitCode).be.undefined();
    should(consent.out.text('error')).equal('To send it: fz login test qwen --allow-inference');
    should(consent.out.exitCode).equal(1);
    should(json.gateway.called('test')[0]?.args).eql(['glm', true]);
    should(JSON.parse(json.out.text('report')).code).equal('ok');
  });

  it('should list the presets by tool, with why a hidden one is not offered, or as JSON', async () => {
    // Arrange
    const text = fakeWorld({ gateway: { presets } });
    const json = fakeWorld({ gateway: { presets } });
    const claudeOnly = fakeWorld({ gateway: { presets: () => ({ presets: [GLM] }) } });

    // Act
    await runCommand(registerCredentialCommands, text, ['login', 'presets']);
    await runCommand(registerCredentialCommands, json, ['login', 'presets', '--json']);
    await runCommand(registerCredentialCommands, claudeOnly, ['login', 'presets']);

    // Assert
    should(text.out.text('report'))
      .match(/Claude Code:\n {2}zai-glm {2}GLM \/ Z\.ai {2}\(Claude only\) {2}— test: free, quota: zai-coding-plan/)
      .and.match(/amazon-bedrock {2}Amazon Bedrock {2}\(Claude only\) {2}— no test/)
      .and.match(/Codex:\n {2}zai-glm-codex {2}GLM \/ Z\.ai {2}\(not offered\) {2}— test: one token/)
      .and.match(/Not offered: Needs a model catalogue file\./)
      .and.match(/Add one: fz login add claude --preset <id>/);
    should(JSON.parse(json.out.text('report')).presets).have.length(3);
    should(claudeOnly.out.text('report')).not.match(/Codex:/);
  });

  it('should chip a dual preset "Claude + Codex" from its offered halves', async () => {
    const world = fakeWorld({ gateway: { presets: () => ({ presets: [DEEPSEEK_CLICK] }) } });
    await runCommand(registerCredentialCommands, world, ['login', 'presets']);
    should(world.out.text('report')).match(
      /deepseek {2}DeepSeek {2}\(Claude \+ Codex\) {2}— test: free, quota: deepseek-balance/,
    );
  });

  it('should show an environment login’s variables, never a hidden value, and what it needs', () => {
    // Arrange
    const row = credential({
      id: 'glm',
      store: 'environment',
      sharedWithTerminal: false,
      email: undefined,
      environment: {
        preset: { id: 'zai-glm', label: 'GLM / Z.ai', docs: 'https://docs.z.ai' },
        variables: [
          { name: 'ANTHROPIC_BASE_URL', kind: 'plain', value: 'https://api.z.ai/api/anthropic' },
          { name: 'ANTHROPIC_AUTH_TOKEN', kind: 'secret', secrets: ['ZAI_API_KEY'], set: true },
          { name: 'EXTRA', kind: 'secret', secrets: ['A', 'B'], set: false },
          { name: 'LEAKED', kind: 'hidden' },
        ],
        cloudCredential: {
          reference: 'aws-profile:acme',
          kind: 'aws-profile',
          sentence: 'Uses your AWS profile acme on this machine. It is named here, never copied.',
        },
        quotaSource: 'zai-coding-plan',
        missingSecrets: ['A', 'B'],
        test: { available: true, spends: 'nothing', note: 'Reads your quota.' },
      },
    });
    const bare = credential({
      id: 'raw',
      store: 'environment',
      sharedWithTerminal: false,
      email: undefined,
      environment: {
        variables: [],
        quotaSource: 'transcript-pricing',
        missingSecrets: [],
        test: { available: false, reason: 'No preset.' },
      },
    });

    // Act
    const text = renderCredentialList({ format: 2, machine: 'studio', credentials: [row, bare] }, 'fz');

    // Assert
    should(text)
      .match(/Preset: GLM \/ Z\.ai/)
      .and.match(/ANTHROPIC_BASE_URL=https:\/\/api\.z\.ai\/api\/anthropic/)
      .and.match(/ANTHROPIC_AUTH_TOKEN=\$\{secret:ZAI_API_KEY\} \(set\)/)
      .and.match(/EXTRA=\$\{secret:A\}, \$\{secret:B\} \(not set\)/)
      .and.match(/LEAKED=\(hidden\)/)
      .and.match(/Uses your AWS profile acme/)
      .and.match(/Needs: A, B/);
  });
});

describe('one-click providers (docs/provider-presets.md)', () => {
  it('should add a login from a provider word, asking for its secret hidden, never printing it', async () => {
    // Arrange
    const world = fakeWorld({
      gateway: { presets: () => ({ presets: [GLM_CLICK] }) },
      hiddenAnswers: ['sk-secret-value'],
    });

    // Act
    await runCommand(registerCredentialCommands, world, ['login', 'add', 'glm']);

    // Assert
    should(world.prompt.hiddenQuestions).eql(['ZAI_API_KEY: ']);
    should(world.gateway.called('putSecret')[0]?.args).eql(['ZAI_API_KEY', 'sk-secret-value']);
    should(world.gateway.called('stage')[0]?.args[0]).eql({
      kind: 'credential.add',
      id: 'claude-zai-glm',
      harness: 'claude',
      store: 'environment',
      preset: 'zai-glm',
      env: {
        ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',
        ANTHROPIC_AUTH_TOKEN: '${secret:ZAI_API_KEY}',
      },
    });
    should(world.out.text('success')).match(/claude-zai-glm added — drives Claude Code\./);
    should(world.out.text('report')).match(/Test it: fz login test claude-zai-glm/);
    should(`${world.out.text()}\n${world.prompt.hiddenQuestions.join('\n')}`).not.match(/sk-secret-value/);
  });

  it('should resolve a word by an id segment or a label word, case-insensitively', async () => {
    const foundry = fakeWorld({
      gateway: { presets: () => ({ presets: [AZURE_CLICK] }) },
      hiddenAnswers: ['azure-secret-value'],
    });
    await runCommand(registerCredentialCommands, foundry, [
      'login',
      'add',
      'AZURE',
      '--env',
      'AZURE_OPENAI_RESOURCE=acme',
    ]);
    should(foundry.gateway.called('stage')[0]?.args[0]).containDeep({ id: 'codex-azure-openai', harness: 'codex' });
  });

  it('should pick the first catalogue match for an ambiguous word, and say which else matched', async () => {
    // Arrange
    const world = fakeWorld({
      gateway: { presets: () => ({ presets: [AMAZON_BEDROCK_CLICK, BEDROCK_MANTLE_CLICK] }) },
    });

    // Act
    await runCommand(registerCredentialCommands, world, ['login', 'add', 'bedrock']);

    // Assert
    should(world.out.text('warn')).match(
      /"bedrock" could also mean bedrock-mantle — using Amazon Bedrock \(AWS profile\)\./,
    );
    should(world.gateway.called('stage')[0]?.args[0]).containDeep({
      id: 'claude-amazon-bedrock',
      preset: 'amazon-bedrock',
    });
    should(world.out.text('success')).match(/drives Claude Code\./);
  });

  it('should refuse an unknown provider word, and a provider that is not offered here', async () => {
    const unknown = fakeWorld({ gateway: { presets: () => ({ presets: [GLM_CLICK] }) } });
    await should(runCommand(registerCredentialCommands, unknown, ['login', 'add', 'zorp'])).be.rejectedWith(
      'There is no provider "zorp": see `fz login presets`',
    );

    const notOffered = fakeWorld({ gateway: { presets: () => ({ presets: [NOT_OFFERED_CLICK] }) } });
    await should(runCommand(registerCredentialCommands, notOffered, ['login', 'add', 'nope-provider'])).be.rejectedWith(
      'Nope Provider is not offered here: Needs a model catalogue file.',
    );
  });

  it('should reuse a secret the store already holds, without asking or storing it again', async () => {
    const world = fakeWorld({
      gateway: {
        presets: () => ({ presets: [GLM_CLICK] }),
        secretNames: () => new Set(['ZAI_API_KEY']),
      },
    });
    await runCommand(registerCredentialCommands, world, ['login', 'add', 'glm']);
    should(world.out.text('report')).match(/ZAI_API_KEY: already set ✓/);
    should(world.prompt.hiddenQuestions).be.empty();
    should(world.gateway.called('putSecret')).be.empty();
  });

  it('should read exactly one missing secret from stdin off a terminal, and refuse two by name', async () => {
    // Arrange
    const one = fakeWorld({
      gateway: { presets: () => ({ presets: [GLM_CLICK] }) },
      interactive: false,
      secretValue: 'from-stdin',
    });
    const two = fakeWorld({ gateway: { presets: () => ({ presets: [TWO_SECRETS_CLICK] }) }, interactive: false });

    // Act
    await runCommand(registerCredentialCommands, one, ['login', 'add', 'zai-glm']);
    const refused = runCommand(registerCredentialCommands, two, ['login', 'add', 'two-secrets']);

    // Assert
    should(one.gateway.called('putSecret')[0]?.args).eql(['ZAI_API_KEY', 'from-stdin']);
    await should(refused).be.rejectedWith(
      'FIRST_KEY, SECOND_KEY are needed for Two Secrets — pipe each in: printf %s "$FIRST_KEY" | fz secret set FIRST_KEY; printf %s "$SECOND_KEY" | fz secret set SECOND_KEY',
    );
    should(two.gateway.called('putSecret')).be.empty();
  });

  it('should ask a required, empty plain variable interactively, or refuse it off a terminal', async () => {
    // Arrange
    const asked = fakeWorld({
      gateway: { presets: () => ({ presets: [AZURE_CLICK] }) },
      answers: ['my-resource'],
      hiddenAnswers: ['azure-secret-value'],
    });
    const refused = fakeWorld({ gateway: { presets: () => ({ presets: [AZURE_CLICK] }) }, interactive: false });
    const given = fakeWorld({
      gateway: { presets: () => ({ presets: [AZURE_CLICK] }) },
      interactive: false,
      secretValue: 'azure-secret-value',
    });

    // Act
    await runCommand(registerCredentialCommands, asked, ['login', 'add', 'azure-openai']);
    const rejected = runCommand(registerCredentialCommands, refused, ['login', 'add', 'azure-openai']);
    await runCommand(registerCredentialCommands, given, [
      'login',
      'add',
      'azure-openai',
      '--env',
      'AZURE_OPENAI_RESOURCE=given-resource',
    ]);

    // Assert
    should(asked.prompt.questions).eql(['AZURE_OPENAI_RESOURCE (the resource name): ']);
    should(asked.gateway.called('stage')[0]?.args[0]).containDeep({ env: { AZURE_OPENAI_RESOURCE: 'my-resource' } });
    await should(rejected).be.rejectedWith(
      'AZURE_OPENAI_RESOURCE is needed for Azure OpenAI — pass --env AZURE_OPENAI_RESOURCE=VALUE',
    );
    should(given.gateway.called('stage')[0]?.args[0]).containDeep({ env: { AZURE_OPENAI_RESOURCE: 'given-resource' } });
  });

  it('should drive every offered half with one secret, and list the half --for names first', async () => {
    // Arrange
    const first = fakeWorld({
      gateway: { presets: () => ({ presets: [DEEPSEEK_CLICK] }) },
      hiddenAnswers: ['sk-deepseek'],
    });
    const forCodex = fakeWorld({
      gateway: { presets: () => ({ presets: [DEEPSEEK_CLICK] }) },
      hiddenAnswers: ['sk-deepseek'],
    });

    // Act
    await runCommand(registerCredentialCommands, first, ['login', 'add', 'deepseek']);
    await runCommand(registerCredentialCommands, forCodex, ['login', 'add', 'deepseek', '--for', 'codex']);

    // Assert
    should(first.gateway.called('stage')[0]?.args[0]).containDeep({ id: 'claude-deepseek', harness: 'claude' });
    should(forCodex.gateway.called('stage')[0]?.args[0]).containDeep({ id: 'codex-deepseek', harness: 'codex' });
    for (const world of [first, forCodex]) {
      should(world.gateway.called('stage')[0]?.args[0]).containDeep({
        env: {
          ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
          ANTHROPIC_AUTH_TOKEN: '${secret:DEEPSEEK_API_KEY}',
          DEEPSEEK_API_KEY: '${secret:DEEPSEEK_API_KEY}',
        },
      });
      should(world.gateway.called('putSecret')).have.length(1);
      should(world.out.text('success')).match(/drives Claude Code \+ Codex\./);
    }
  });

  it('should refuse --for naming a CLI the preset has no half for, or no OFFERED half for', async () => {
    const noHalf = fakeWorld({ gateway: { presets: () => ({ presets: [GLM_CLICK] }) } });
    await should(
      runCommand(registerCredentialCommands, noHalf, ['login', 'add', 'glm', '--for', 'codex']),
    ).be.rejectedWith('GLM / Z.ai has no half for Codex');

    const gap = fakeWorld({ gateway: { presets: () => ({ presets: [DEEPSEEK_CODEX_GAP_CLICK] }) } });
    await should(
      runCommand(registerCredentialCommands, gap, ['login', 'add', 'deepseek-half-gap', '--for', 'codex']),
    ).be.rejectedWith('DeepSeek (gap) does not drive Codex: Needs a model catalogue file.');
  });

  it('should test a one-click login right after adding it, and fail its exit code when it fails', async () => {
    // Arrange
    const passed = fakeWorld({
      gateway: { presets: () => ({ presets: [GLM_CLICK] }), secretNames: () => new Set(['ZAI_API_KEY']) },
    });
    const failed = fakeWorld({
      gateway: {
        presets: () => ({ presets: [GLM_CLICK] }),
        secretNames: () => new Set(['ZAI_API_KEY']),
        test: () => ({
          credentialId: 'claude-zai-glm',
          ok: false,
          code: 'rejected',
          message: 'The provider rejected this login.',
          spent: 'nothing',
          at: '2026-10-16T09:00:00.000Z',
        }),
      },
    });

    // Act
    await runCommand(registerCredentialCommands, passed, ['login', 'add', 'glm', '--test']);
    await runCommand(registerCredentialCommands, failed, ['login', 'add', 'glm', '--test']);

    // Assert
    should(passed.out.text('report')).match(/claude-zai-glm: The provider accepted this login\./);
    should(passed.out.exitCode).be.undefined();
    should(failed.out.text('report')).match(/claude-zai-glm: The provider rejected this login\./);
    should(failed.out.exitCode).equal(1);
  });

  it('should import from the current shell with --from-env, detecting the provider and sourcing its values', async () => {
    // Arrange
    const world = fakeWorld({
      gateway: { presets: () => ({ presets: [DEEPSEEK_CLICK] }) },
      env: {
        ANTHROPIC_BASE_URL: 'https://api.deepseek.com/v2/anthropic',
        DEEPSEEK_API_KEY: 'sk-live-shell-value',
        UNRELATED: undefined,
      },
    });

    // Act
    await runCommand(registerCredentialCommands, world, ['login', 'add', '--from-env']);

    // Assert
    should(world.out.text('report')).match(
      /Detected DeepSeek from ANTHROPIC_BASE_URL \(api\.deepseek\.com\), DEEPSEEK_API_KEY\./,
    );
    should(world.prompt.hiddenQuestions).be.empty();
    should(world.gateway.called('putSecret')[0]?.args).eql(['DEEPSEEK_API_KEY', 'sk-live-shell-value']);
    should(world.gateway.called('stage')[0]?.args[0]).containDeep({
      env: { ANTHROPIC_BASE_URL: 'https://api.deepseek.com/v2/anthropic' },
    });
    should(world.out.text()).not.match(/sk-live-shell-value/);
  });

  it('should still read values from the shell with --from-env when a provider is named explicitly', async () => {
    // Arrange — naming the provider skips detection, but the shell still fills its secret.
    const world = fakeWorld({
      gateway: { presets: () => ({ presets: [GLM_CLICK] }) },
      env: { ANTHROPIC_AUTH_TOKEN: 'sk-explicit-word-secret' },
    });

    // Act
    await runCommand(registerCredentialCommands, world, ['login', 'add', 'glm', '--from-env']);

    // Assert
    should(world.out.text('report')).not.match(/Detected/);
    should(world.prompt.hiddenQuestions).be.empty();
    should(world.gateway.called('putSecret')[0]?.args).eql(['ZAI_API_KEY', 'sk-explicit-word-secret']);
  });

  it('should refuse detection that finds no provider, naming what it recognised', async () => {
    const world = fakeWorld({
      gateway: { presets: () => ({ presets: [DEEPSEEK_CLICK] }) },
      env: { MY_SERVICE_API_KEY: 'v' },
    });
    await should(runCommand(registerCredentialCommands, world, ['login', 'add', '--from-env'])).be.rejectedWith(
      'Name a tool or provider: fz login add claude|codex|<provider>',
    );
    should(world.out.text('report')).match(/Detected a custom gateway: MY_SERVICE_API_KEY\./);
  });

  it('should detect the provider from a bare --env, and build the login the same way', async () => {
    const world = fakeWorld({
      gateway: { presets: () => ({ presets: [DEEPSEEK_CLICK] }) },
      hiddenAnswers: ['sk-bare-env'],
    });
    await runCommand(registerCredentialCommands, world, [
      'login',
      'add',
      '--env',
      'ANTHROPIC_BASE_URL=https://api.deepseek.com/v3/anthropic',
    ]);
    should(world.out.text('report')).match(/Detected DeepSeek from ANTHROPIC_BASE_URL \(api\.deepseek\.com\)\./);
    should(world.gateway.called('stage')[0]?.args[0]).containDeep({
      env: { ANTHROPIC_BASE_URL: 'https://api.deepseek.com/v3/anthropic' },
    });
  });
});

describe('login disable and enable', () => {
  it('should switch a login off with a reason and a wait, without asking', async () => {
    const world = fakeWorld();
    await runCommand(registerCredentialCommands, world, [
      'login',
      'disable',
      'claude-you',
      '--until',
      '2d',
      '--reason',
      'spend limit',
    ]);
    should(world.gateway.called('stage')[0]?.args[0]).eql({
      kind: 'credential.disable',
      id: 'claude-you',
      reason: 'spend limit',
      until: '2026-10-15T00:00:00.000Z',
    });
    should(world.prompt.questions).be.empty();
  });

  it('should switch it off for good when no end is given, and back on', async () => {
    const world = fakeWorld();
    await runCommand(registerCredentialCommands, world, ['login', 'disable', 'claude-you']);
    await runCommand(registerCredentialCommands, world, ['login', 'enable', 'claude-you']);
    should(world.gateway.called('stage').map(call => call.args[0])).eql([
      { kind: 'credential.disable', id: 'claude-you' },
      { kind: 'credential.enable', id: 'claude-you' },
    ]);
  });

  it('should refuse a blank reason and an end already passed', async () => {
    const world = fakeWorld();
    await should(
      runCommand(registerCredentialCommands, world, ['login', 'disable', 'claude-you', '--reason', ' ']),
    ).be.rejectedWith(/Say why/);
    await should(
      runCommand(registerCredentialCommands, world, ['login', 'disable', 'claude-you', '--until', '2020-01-01']),
    ).be.rejectedWith(/already passed/);
    should(world.gateway.called('stage')).be.empty();
  });
});

describe('renderCredentialList of a switched-off login', () => {
  it('should show the switch in place of the status, and how to turn it back on', () => {
    const row = credential({ id: 'liftoff', disabled: { reason: 'spend limit', source: 'login' } });
    const text = renderCredentialList({ format: 2, machine: 'studio', credentials: [row] }, 'fz');
    should(text).match(/^liftoff .*— disabled \(spend limit\)/m);
    should(text).match(/Nothing new starts on it\. Turn it back on with `login enable liftoff`\./);
  });
});
