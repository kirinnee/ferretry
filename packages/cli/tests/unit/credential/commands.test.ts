import { describe, it } from 'bun:test';
import type { FleetPresetVariable } from '@ferretry/protocol';
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

  it('should refuse a tool it does not know', async () => {
    const world = fakeWorld();
    await should(runCommand(registerCredentialCommands, world, ['credential', 'add', 'gemini'])).be.rejectedWith(
      /use claude or codex/,
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
      .match(/Claude Code:\n {2}zai-glm {2}GLM \/ Z\.ai {2}— test: free, quota: zai-coding-plan/)
      .and.match(/amazon-bedrock {2}Amazon Bedrock {2}— no test/)
      .and.match(/Codex:\n {2}zai-glm-codex {2}GLM \/ Z\.ai {2}— test: one token/)
      .and.match(/Not offered: Needs a model catalogue file\./)
      .and.match(/Add one: fz login add claude --preset <id>/);
    should(JSON.parse(json.out.text('report')).presets).have.length(3);
    should(claudeOnly.out.text('report')).not.match(/Codex:/);
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
