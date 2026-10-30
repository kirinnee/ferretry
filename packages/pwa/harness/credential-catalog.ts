/**
 * The logins and runtimes the harness's set-up machine answers (the prototype's studio-mac), for the
 * Runtimes and Credentials tabs: a login shared with the terminal, two logins on one email told apart
 * by label (E26), one whose refresh is due, an empty slot a clone made (E31), an agent runtime with its
 * fixed layer (E24), a model the login cannot use (E23) and a harness that is not installed (E29).
 *
 * Every answer is parsed by the caller's own schema. Sign-in shows a real-shaped Claude link; nothing
 * is signed in.
 */

const usage = (fiveHour: number, weekly: number) => ({
  fiveHour: { usedPercent: fiveHour, resetsAt: new Date(Date.now() + 130 * 60_000).toISOString() },
  weekly: { usedPercent: weekly, resetsAt: new Date(Date.now() + 3 * 86_400_000).toISOString() },
  source: 'anthropic-usage',
  at: new Date().toISOString(),
});

const STATUS = {
  ready: {
    word: 'ready',
    label: 'Ready',
    reason: 'provider_accepted',
    explanation: 'Ready. Checked a few minutes ago.',
  },
  refresh_due: {
    word: 'refresh_due',
    label: 'Refresh due',
    reason: 'access_expired_refreshable',
    explanation: 'Refresh due. Ferretry renews it the next time a runtime uses it.',
  },
  needs_sign_in: {
    word: 'needs_sign_in',
    label: 'Needs sign-in',
    reason: 'not_signed_in',
    explanation: 'Needs sign-in. Runtimes that use this login can’t launch.',
  },
} as const;

/** Five days out, at the start of a UTC day, as the daemon publishes a calendar-date `until`. */
const DISABLED_UNTIL = `${new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10)}T00:00:00.000Z`;
const LOGIN_OFF_REASON = 'Org monthly spend limit reached';

const login = (fields: Record<string, unknown> & { readonly id: string; readonly word: keyof typeof STATUS }) => {
  const { word, id, ...rest } = fields;
  return {
    id,
    harness: 'claude',
    store: 'ferretry',
    email: 'you@example.com',
    needsLabel: false,
    sharedWithTerminal: false,
    status: { ...STATUS[word], lastCheckInconclusive: false },
    usage: { fiveHour: {}, weekly: {} },
    usedBy: [],
    signIn: { available: true },
    checkNow: { available: true },
    signOut: {
      available: true,
      sentence: 'Sign out of you@example.com? No runtime uses it.',
      runtimesAffected: 0,
      signsOutTerminal: false,
    },
    ...rest,
  };
};

const CREDENTIALS = {
  format: 2,
  machine: 'studio-mac',
  credentials: [
    login({
      id: 'claude-personal',
      word: 'ready',
      store: 'host',
      label: 'personal',
      sharedWithTerminal: true,
      usage: usage(38, 61),
      usedBy: ['claude-agent', 'claude-default'],
      signOut: {
        available: true,
        sentence:
          'Sign out of you@example.com (personal)? This also signs out claude in your terminal on studio-mac. 2 runtimes will need sign-in.',
        runtimesAffected: 2,
        signsOutTerminal: true,
      },
    }),
    login({
      id: 'claude-work',
      word: 'refresh_due',
      label: 'work',
      // Switched off by hand (docs/disabling.md): shows the reason, the end, and that nothing was stopped.
      disabled: { reason: LOGIN_OFF_REASON, until: DISABLED_UNTIL, source: 'login' },
      usage: usage(71, 83),
      usedBy: ['claude-review', 'claude-work'],
      signOut: {
        available: true,
        sentence: 'Sign out of you@example.com (work)? 2 runtimes will need sign-in.',
        runtimesAffected: 1,
        signsOutTerminal: false,
      },
    }),
    login({
      id: 'claude-team',
      word: 'needs_sign_in',
      email: 'you@team.example.com',
      clonedFrom: 'work-linux',
      usedBy: ['claude-team', 'claude-team-agent', 'claude-team-review'],
      checkNow: { available: false, reason: 'Sign in first. There is nothing to check yet.' },
    }),
    login({
      id: 'codex',
      word: 'ready',
      harness: 'codex',
      store: 'host',
      sharedWithTerminal: true,
      usage: usage(12, 27),
      usedBy: ['codex-default'],
    }),
    login({
      id: 'codex-team',
      word: 'needs_sign_in',
      harness: 'codex',
      email: 'you@team.example.com',
      checkNow: { available: false, reason: 'Sign in first. There is nothing to check yet.' },
    }),
    // An ENVIRONMENT login (docs/provider-presets.md): GLM through Z.ai's Anthropic-compatible endpoint.
    // Its key is a secret NAME with "set ✓"; there is no sign-in and nothing to check.
    login({
      id: 'glm-env',
      word: 'ready',
      store: 'environment',
      usedBy: ['glm-agent'],
      // Its quota, read from Z.ai's Coding Plan endpoint by the daemon's provider quota reader
      // (docs/provider-quotas.md): the 5-hour and weekly windows, and the separate tool allowance.
      usage: {
        fiveHour: { usedPercent: 64, resetsAt: new Date(Date.now() + 130 * 60_000).toISOString() },
        weekly: { usedPercent: 31, resetsAt: new Date(Date.now() + 3 * 86_400_000).toISOString() },
        source: 'provider-quota',
        at: new Date().toISOString(),
        provider: {
          source: 'zai-coding-plan',
          via: 'endpoint',
          windows: [
            { label: '5h', usedPercent: 64, resetsAt: new Date(Date.now() + 130 * 60_000).toISOString() },
            { label: 'week', usedPercent: 31, resetsAt: new Date(Date.now() + 3 * 86_400_000).toISOString() },
            {
              label: 'tools',
              unit: 'requests',
              used: 120,
              limit: 1000,
              usedPercent: 12,
              resetsAt: new Date(Date.now() + 20 * 86_400_000).toISOString(),
            },
          ],
          exhausted: false,
          unverified: true,
          at: new Date().toISOString(),
        },
      },
      status: {
        word: 'ready',
        label: 'Ready',
        reason: 'from_environment',
        explanation: 'This login comes from environment variables, so there is no sign-in to check.',
        lastCheckInconclusive: false,
      },
      signIn: {
        available: false,
        reason: '"glm-env" is authenticated by its environment variables, so there is nothing to sign in to.',
      },
      checkNow: {
        available: false,
        reason: 'This login comes from environment variables, so there is nothing to check.',
      },
      signOut: {
        available: false,
        sentence: 'Sign out of glm-env? 1 runtime will need sign-in.',
        runtimesAffected: 1,
        signsOutTerminal: false,
      },
      environment: {
        preset: { id: 'zai-glm', label: 'GLM / Z.ai', docs: 'https://docs.z.ai/devpack/tool/claude' },
        variables: [
          { name: 'ANTHROPIC_AUTH_TOKEN', kind: 'secret', secrets: ['ZAI_API_KEY'], set: true },
          { name: 'ANTHROPIC_BASE_URL', kind: 'plain', value: 'https://api.z.ai/api/anthropic' },
          { name: 'ANTHROPIC_DEFAULT_HAIKU_MODEL', kind: 'plain', value: 'glm-5.3-flash' },
          { name: 'ANTHROPIC_DEFAULT_OPUS_MODEL', kind: 'plain', value: 'glm-5.3' },
        ],
        quotaSource: 'zai-coding-plan',
        missingSecrets: [],
        test: { available: true, spends: 'nothing', note: 'Reads your Coding Plan quota. Spends nothing.' },
      },
    }),
    // ONE provider key for BOTH CLIs (docs/provider-presets.md): DeepSeek's `claude:` and `codex:` halves.
    // It is listed once, in its own "Claude Code + Codex" group, and offered for either CLI.
    login({
      id: 'deepseek',
      word: 'ready',
      store: 'environment',
      harnesses: ['claude', 'codex'],
      email: undefined,
      usedBy: [],
      status: {
        word: 'ready',
        label: 'Ready',
        reason: 'from_environment',
        explanation: 'This login comes from environment variables, so there is no sign-in to check.',
        lastCheckInconclusive: false,
      },
      signIn: {
        available: false,
        reason: '"deepseek" is authenticated by its environment variables, so there is nothing to sign in to.',
      },
      checkNow: {
        available: false,
        reason: 'This login comes from environment variables, so there is nothing to check.',
      },
      signOut: {
        available: false,
        sentence: 'Sign out of deepseek? No runtime uses it.',
        runtimesAffected: 0,
        signsOutTerminal: false,
      },
      environment: {
        preset: {
          id: 'deepseek',
          label: 'DeepSeek',
          docs: 'https://api-docs.deepseek.com/quick_start/agent_integrations/claude_code',
        },
        variables: [
          { name: 'ANTHROPIC_BASE_URL', kind: 'plain', value: 'https://api.deepseek.com/anthropic', harness: 'claude' },
          { name: 'ANTHROPIC_AUTH_TOKEN', kind: 'secret', secrets: ['DEEPSEEK_API_KEY'], set: true, harness: 'claude' },
          { name: 'DEEPSEEK_API_KEY', kind: 'secret', secrets: ['DEEPSEEK_API_KEY'], set: true, harness: 'codex' },
        ],
        codexProvider: { id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/' },
        quotaSource: 'deepseek-balance',
        missingSecrets: [],
        test: { available: true, spends: 'nothing', note: 'Lists the models the key can use. Spends nothing.' },
      },
    }),
  ],
};

/** The secret NAMES this harness's store holds. A Store adds the name; no value is kept anywhere. */
const heldSecrets = new Set<string>(['ANTHROPIC_API_KEY', 'ZAI_API_KEY']);

const presetVariable = (fields: Record<string, unknown> & { readonly name: string }) => ({
  kind: 'plain',
  required: true,
  allowEmpty: false,
  ...fields,
});

const preset = (fields: Record<string, unknown> & { readonly id: string; readonly label: string }) => ({
  harness: 'claude',
  summary: 'Claude Code through an Anthropic-compatible endpoint.',
  docs: 'https://docs.example.com',
  origin: 'built-in',
  variables: [],
  models: [],
  test: { available: true, spends: 'nothing', note: 'Lists the models the key can use. Spends nothing.' },
  quota: { source: 'transcript-pricing', note: 'Counted from the transcript.' },
  unverified: [],
  verified: '2026-10-16',
  offered: { available: true },
  ...fields,
});

/** Both halves offered: a login from it drives Claude Code and Codex with one key. */
const BOTH = [
  { harness: 'claude', offered: { available: true }, models: [] },
  { harness: 'codex', offered: { available: true }, models: [] },
];

/** A slice of the built-in provider presets, as `GET /v1/fleet/presets` answers them, in the catalogue's order. */
const PRESETS = {
  presets: [
    preset({
      id: 'anthropic-api-key',
      group: 'popular',
      label: 'Anthropic API key',
      summary: 'Claude Code with an API key from the Claude Platform console, billed per token.',
      variables: [presetVariable({ name: 'ANTHROPIC_API_KEY', kind: 'secret', secret: 'ANTHROPIC_API_KEY' })],
    }),
    preset({
      id: 'openai-api-key',
      group: 'popular',
      label: 'OpenAI API key',
      harness: 'codex',
      summary: 'Codex with an OpenAI platform API key, billed per token, through the Responses API.',
      variables: [presetVariable({ name: 'OPENAI_API_KEY', kind: 'secret', secret: 'OPENAI_API_KEY' })],
    }),
    preset({
      id: 'litellm',
      group: 'self-hosted',
      label: 'LiteLLM proxy',
      summary: 'Claude Code through your own LiteLLM proxy, with a master or virtual key.',
      variables: [
        presetVariable({ name: 'ANTHROPIC_BASE_URL', value: '', description: "the proxy's address, https://…" }),
        presetVariable({ name: 'ANTHROPIC_AUTH_TOKEN', kind: 'secret', secret: 'LITELLM_API_KEY' }),
      ],
    }),
    preset({
      id: 'amazon-bedrock',
      group: 'cloud',
      label: 'Amazon Bedrock (AWS profile)',
      summary: 'Claude Code on Amazon Bedrock with an AWS profile this machine already has.',
      cloudCredential: { kinds: ['aws-profile'], suggested: 'aws-profile:default' },
      variables: [
        presetVariable({ name: 'CLAUDE_CODE_USE_BEDROCK', value: '1' }),
        presetVariable({ name: 'AWS_REGION', value: 'us-east-1' }),
      ],
      test: { available: false, reason: 'Bedrock needs AWS request signing, which Ferretry does not do.' },
      detect: { hosts: ['bedrock-runtime.amazonaws.com'], variables: ['CLAUDE_CODE_USE_BEDROCK'], keyPrefixes: [] },
    }),
    preset({
      id: 'azure-openai',
      group: 'cloud',
      label: 'Azure OpenAI',
      harness: 'codex',
      summary: 'Codex on your Azure OpenAI resource with its API key. The model is your deployment name.',
      variables: [
        presetVariable({
          name: 'AZURE_OPENAI_RESOURCE',
          value: '',
          description: 'the resource name, as in <name>.openai.azure.com',
        }),
        presetVariable({ name: 'AZURE_OPENAI_API_KEY', kind: 'secret', secret: 'AZURE_OPENAI_API_KEY' }),
      ],
      detect: { hosts: ['openai.azure.com'], variables: ['AZURE_OPENAI_*'], keyPrefixes: [] },
    }),
    preset({
      id: 'custom-gateway',
      group: 'self-hosted',
      label: 'Custom gateway',
      summary: 'Claude Code through any gateway that speaks the Anthropic Messages API.',
      variables: [
        presetVariable({ name: 'ANTHROPIC_BASE_URL', value: '', description: "the gateway's address, https://…" }),
        presetVariable({ name: 'ANTHROPIC_AUTH_TOKEN', kind: 'secret', secret: 'GATEWAY_API_KEY' }),
        presetVariable({ name: 'ANTHROPIC_API_KEY', value: '', allowEmpty: true }),
        presetVariable({ name: 'ANTHROPIC_MODEL', value: '', required: false }),
      ],
    }),
    preset({
      id: 'deepseek',
      group: 'popular',
      label: 'DeepSeek',
      summary: 'Claude Code and Codex on DeepSeek models with one DeepSeek platform key.',
      docs: 'https://api-docs.deepseek.com/quick_start/agent_integrations/claude_code',
      halves: BOTH,
      variables: [
        presetVariable({
          name: 'ANTHROPIC_BASE_URL',
          value: 'https://api.deepseek.com/anthropic',
          harnesses: ['claude'],
        }),
        presetVariable({
          name: 'ANTHROPIC_AUTH_TOKEN',
          kind: 'secret',
          secret: 'DEEPSEEK_API_KEY',
          harnesses: ['claude'],
        }),
        presetVariable({ name: 'ANTHROPIC_MODEL', value: 'deepseek-flash[1m]', harnesses: ['claude'] }),
        presetVariable({ name: 'DEEPSEEK_API_KEY', kind: 'secret', secret: 'DEEPSEEK_API_KEY', harnesses: ['codex'] }),
      ],
      models: ['deepseek-flash', 'deepseek-v4-pro'],
      quota: { source: 'deepseek-balance', note: 'Your DeepSeek balance, in the currency you topped up in.' },
      detect: { hosts: ['api.deepseek.com'], variables: ['DEEPSEEK_*'], keyPrefixes: [] },
    }),
    preset({
      id: 'kimi',
      group: 'popular',
      label: 'Kimi (Moonshot)',
      summary: 'Claude Code and Codex on Kimi models with one Moonshot platform key.',
      halves: BOTH,
      variables: [
        presetVariable({
          name: 'ANTHROPIC_BASE_URL',
          value: 'https://api.moonshot.ai/anthropic',
          harnesses: ['claude'],
        }),
        presetVariable({
          name: 'ANTHROPIC_AUTH_TOKEN',
          kind: 'secret',
          secret: 'MOONSHOT_API_KEY',
          harnesses: ['claude'],
        }),
        presetVariable({ name: 'MOONSHOT_API_KEY', kind: 'secret', secret: 'MOONSHOT_API_KEY', harnesses: ['codex'] }),
      ],
      detect: { hosts: ['api.moonshot.ai'], variables: ['MOONSHOT_*'], keyPrefixes: [] },
    }),
    preset({
      id: 'minimax',
      group: 'popular',
      label: 'MiniMax',
      summary: 'Claude Code and Codex on MiniMax models with one MiniMax key.',
      halves: BOTH,
      variables: [
        presetVariable({
          name: 'ANTHROPIC_BASE_URL',
          value: 'https://api.minimax.io/anthropic',
          harnesses: ['claude'],
        }),
        presetVariable({
          name: 'ANTHROPIC_AUTH_TOKEN',
          kind: 'secret',
          secret: 'MINIMAX_API_KEY',
          harnesses: ['claude'],
        }),
        presetVariable({ name: 'MINIMAX_API_KEY', kind: 'secret', secret: 'MINIMAX_API_KEY', harnesses: ['codex'] }),
      ],
      detect: { hosts: ['api.minimax.io'], variables: ['MINIMAX_*'], keyPrefixes: [] },
    }),
    preset({
      id: 'ollama-codex',
      group: 'self-hosted',
      label: 'Ollama (local)',
      harness: 'codex',
      summary: 'Codex on a model served by Ollama on this machine. No key.',
      variables: [],
      quota: { source: 'none', note: 'A local model has no quota.' },
      detect: { hosts: ['localhost:11434'], variables: ['OLLAMA_*'], keyPrefixes: [] },
    }),
    preset({
      id: 'openrouter',
      group: 'popular',
      label: 'OpenRouter',
      summary: 'Claude Code and Codex through OpenRouter with one OpenRouter key.',
      halves: BOTH,
      variables: [
        presetVariable({ name: 'ANTHROPIC_BASE_URL', value: 'https://openrouter.ai/api', harnesses: ['claude'] }),
        presetVariable({
          name: 'ANTHROPIC_AUTH_TOKEN',
          kind: 'secret',
          secret: 'OPENROUTER_API_KEY',
          harnesses: ['claude'],
        }),
        presetVariable({ name: 'ANTHROPIC_API_KEY', value: '', allowEmpty: true, harnesses: ['claude'] }),
        presetVariable({
          name: 'OPENROUTER_API_KEY',
          kind: 'secret',
          secret: 'OPENROUTER_API_KEY',
          harnesses: ['codex'],
        }),
      ],
      detect: { hosts: ['openrouter.ai'], variables: ['OPENROUTER_*'], keyPrefixes: ['sk-or-'] },
    }),
    preset({
      id: 'zai-glm',
      group: 'popular',
      label: 'GLM / Z.ai',
      summary: 'Claude Code on GLM models with a Z.ai Coding Plan key.',
      docs: 'https://docs.z.ai/devpack/tool/claude',
      unverified: [
        'The quota endpoint the Test and usage read is described by community tools, not by Z.ai’s own documentation.',
      ],
      // Its Codex half exists and is NOT offered, so the login it makes is Claude only.
      halves: [
        { harness: 'claude', offered: { available: true }, models: ['glm-5.3', 'glm-5.3-flash'] },
        {
          harness: 'codex',
          offered: {
            available: false,
            reason: 'Codex only runs GLM with a model catalogue file Ferretry would have to write.',
          },
          models: [],
        },
      ],
      variables: [
        presetVariable({ name: 'ANTHROPIC_BASE_URL', value: 'https://api.z.ai/api/anthropic' }),
        presetVariable({ name: 'ANTHROPIC_AUTH_TOKEN', kind: 'secret', secret: 'ZAI_API_KEY' }),
        presetVariable({ name: 'API_TIMEOUT_MS', value: '3000000', required: false }),
        presetVariable({ name: 'ANTHROPIC_DEFAULT_OPUS_MODEL', value: 'glm-5.3' }),
        presetVariable({ name: 'ANTHROPIC_DEFAULT_HAIKU_MODEL', value: 'glm-5.3-flash' }),
        // Not part of Z.ai's preset: a second, unstored secret, so a review sees both secret states at once.
        presetVariable({
          name: 'ZAI_QUOTA_TOKEN',
          kind: 'secret',
          secret: 'ZAI_QUOTA_KEY',
          required: false,
          description: 'harness only',
        }),
      ],
      models: ['glm-5.3', 'glm-5.3-flash'],
      test: { available: true, spends: 'nothing', note: 'Reads your Coding Plan quota. Spends nothing.' },
      quota: { source: 'zai-coding-plan', note: 'Z.ai’s Coding Plan quota — a 5-hour and a weekly window.' },
      detect: { hosts: ['api.z.ai', 'open.bigmodel.cn'], variables: ['ZAI_*', 'GLM_*'], keyPrefixes: [] },
    }),
    preset({
      id: 'google-vertex',
      group: 'cloud',
      label: 'Google Vertex AI',
      summary: 'Claude Code on Vertex AI with this machine’s gcloud application-default credentials.',
      offered: { available: false, reason: 'gcloud is not installed on this machine.' },
      cloudCredential: { kinds: ['gcloud-adc'], suggested: 'gcloud-adc' },
    }),
  ],
};

/** The answer for an environment-login path (presets, the secret names, a Test), or `undefined`. */
function environmentAnswer(path: string, init?: RequestInit): unknown {
  if (path === '/v1/fleet/presets') return PRESETS;
  if (path === '/v1/secrets' && init?.method === 'POST') {
    const { name } = JSON.parse(String(init.body ?? '{}')) as { name: string };
    heldSecrets.add(name);
    return { name, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  }
  if (path === '/v1/secrets') {
    const at = '2026-10-16T08:00:00.000Z';
    return {
      v: 1,
      health: 'ready',
      secrets: [...heldSecrets].map(name => ({ name, createdAt: at, updatedAt: at })),
      references: [],
    };
  }
  const test = /^\/v1\/fleet\/credentials\/([^/]+)\/test$/u.exec(path);
  if (test !== null)
    return {
      credentialId: decodeURIComponent(test[1] ?? ''),
      ok: true,
      code: 'ok',
      message: 'The provider accepted this login.',
      spent: 'nothing',
      latencyMs: 212,
      at: new Date().toISOString(),
    };
  return undefined;
}

const stack = (harness: 'claude' | 'codex', fields: Record<string, unknown> = {}) => ({
  harness,
  available: { available: true },
  applied: [
    'instructions/Main instructions',
    'mcp/github',
    'mcp/linear',
    'mcp/notes',
    'skills/My skills',
    'settings/Claude settings',
    'modelSets/Claude models',
  ],
  skipped: [],
  conflicts: [],
  partial: [],
  ...fields,
});

const CLAUDE_MODELS = {
  source: 'model-set',
  name: 'Claude models',
  models: [
    { id: 'Opus 5.5', available: true },
    { id: 'Sonnet 5.5', available: true },
    { id: 'Haiku 5.5', available: true },
  ],
  declaredDefault: 'Sonnet 5.5',
  default: 'Sonnet 5.5',
};

const runtime = (fields: Record<string, unknown> & { readonly name: string }) => ({
  id: `runtime-${fields.name}`,
  wrapper: fields.name,
  harness: 'claude',
  credential: { id: 'claude-personal', store: 'host', label: 'personal', status: 'ready' },
  profile: 'Default',
  agent: false,
  stack: stack('claude'),
  modelSet: CLAUDE_MODELS,
  launch: { available: true },
  sameAs: [],
  ...fields,
});

const TEAM = { id: 'claude-team', store: 'ferretry', status: 'needs_sign_in' };

const RUNTIMES = {
  format: 'version-2',
  runtimes: [
    runtime({
      name: 'claude-agent',
      profile: 'Agent work',
      agent: true,
      modelSet: { ...CLAUDE_MODELS, name: 'Heavy', default: 'Opus 5.5', declaredDefault: 'Opus 5.5' },
      fixedLayer: {
        agentPermissions: 'auto',
        entries: [
          { key: 'permissions.defaultMode', value: 'auto' },
          { key: 'trust prompt', value: 'off' },
          { key: 'onboarding', value: 'done' },
        ],
        overridden: [
          {
            key: 'permissions.defaultMode',
            value: 'acceptEdits',
            from: 'Agent settings',
            sentence: 'From your Agent settings · Overridden for agents by Ferretry',
          },
        ],
      },
    }),
    // Switched off on its own block: its switch turns it back on.
    runtime({
      name: 'claude-default',
      sameAs: [],
      disabled: { reason: 'Keeping the personal quota for Friday', until: DISABLED_UNTIL, source: 'runtime' },
      launch: { available: false, reason: 'claude-default is disabled (Keeping the personal quota for Friday).' },
    }),
    // Off because its LOGIN is off: the switch is locked and points at the login.
    runtime({
      name: 'claude-review',
      profile: 'Review',
      credential: { id: 'claude-work', store: 'ferretry', label: 'work', status: 'refresh_due' },
      disabled: { reason: LOGIN_OFF_REASON, until: DISABLED_UNTIL, source: 'login' },
      launch: { available: false, reason: `login claude-work is disabled (${LOGIN_OFF_REASON}).` },
    }),
    runtime({
      name: 'claude-work',
      credential: { id: 'claude-work', store: 'ferretry', label: 'work', status: 'refresh_due' },
      disabled: { reason: LOGIN_OFF_REASON, until: DISABLED_UNTIL, source: 'login' },
      launch: { available: false, reason: `login claude-work is disabled (${LOGIN_OFF_REASON}).` },
    }),
    runtime({ name: 'claude-team', credential: TEAM, launch: { available: false, reason: 'Sign in to launch' } }),
    runtime({
      name: 'claude-team-agent',
      credential: TEAM,
      agent: true,
      launch: { available: false, reason: 'Sign in to launch' },
    }),
    runtime({
      name: 'claude-team-review',
      credential: TEAM,
      profile: 'Review',
      launch: { available: false, reason: 'Sign in to launch' },
    }),
    runtime({
      name: 'codex-default',
      harness: 'codex',
      profile: 'Codex',
      credential: { id: 'codex', store: 'host', status: 'ready' },
      stack: stack('codex', {
        applied: ['instructions/Main instructions', 'mcp/github', 'mcp/linear', 'mcp/notes', 'skills/My skills'],
        skipped: [
          {
            reference: 'settings/Claude settings',
            sentence: 'Settings Claude settings is for Claude Code only, so it is skipped on Codex.',
          },
        ],
        partial: [{ reference: 'skills/My skills', reason: 'release-notes limits which tools it may use.' }],
      }),
      modelSet: {
        source: 'model-set',
        name: 'Mixed',
        models: [
          { id: 'GPT-6', available: true },
          { id: 'Opus 5.5', available: false },
          { id: 'Sonnet 5.5', available: false },
        ],
        declaredDefault: 'Opus 5.5',
        default: 'GPT-6',
      },
    }),
  ],
};

const flow = (credentialId: string) => ({
  harness: 'claude',
  flowId: 'harness-flow',
  credentialId,
  identity: 'claude:you@team.example.com',
  startedAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
  state: 'awaiting-code',
  verificationUrl: 'https://claude.ai/oauth/authorize?code=true&client_id=harness-preview',
});

/**
 * Codex's sign-in for the empty `codex-team` login: a device code first, then — on "Sign in with a link
 * instead" — the link sign-in Codex runs when an account has device codes turned off, then the moment
 * after the address is pasted. The flow is held here so the panel's re-reads see where it got to.
 */
const CODEX_FLOW_ID = 'codex-flow';
const codexFlow = (fields: Record<string, unknown>) => ({
  harness: 'codex',
  flowId: CODEX_FLOW_ID,
  credentialId: 'codex-team',
  identity: 'codex:you@team.example.com',
  startedAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
  ...fields,
});
const CODEX_DEVICE = {
  state: 'awaiting-approval',
  verificationUrl: 'https://auth.openai.com/codex/device',
  userCode: 'HRNS-PRVW',
};
const CODEX_LINK = {
  state: 'awaiting-callback',
  verificationUrl:
    'https://auth.openai.com/oauth/authorize?response_type=code&client_id=harness-preview&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&code_challenge=harness-preview&code_challenge_method=S256&state=harness-preview',
};
let codexStage: Record<string, unknown> = CODEX_DEVICE;

/** The logins whose Claude sign-in this harness already started, so a second start picks it up. */
const claudeStarted = new Set<string>();
/** The first start-over of the Codex link finds the callback ports held by somebody else's program. */
let codexPortsHeld = true;
const CODEX_PORTS_HELD = {
  state: 'failed',
  reason:
    'Codex cannot listen for the sign-in: ports 1455 and 1457 are in use by "nginx" (pid 4242), which is not a Codex sign-in, so Ferretry will not stop it',
  remedy: 'Stop that program yourself and start over, or sign in with a device code instead.',
};

/** The answer for a Runtimes or Credentials path, or `undefined` when it is not one of theirs. */
export function harnessCredentialAnswer(path: string, init?: RequestInit): unknown {
  const environment = environmentAnswer(path, init);
  if (environment !== undefined) return environment;
  if (path === '/v1/fleet/credentials') return CREDENTIALS;
  if (path === '/v1/fleet/runtimes') return RUNTIMES;
  if (path === '/v1/fleet/login' && init?.method === 'POST') {
    const body = JSON.parse(String(init.body ?? '{}')) as {
      credentialId?: string;
      method?: string;
      restart?: boolean;
    };
    if (body.credentialId === 'codex-team') {
      if (body.restart === true && body.method === 'link' && codexPortsHeld) {
        codexPortsHeld = false;
        return codexFlow(CODEX_PORTS_HELD);
      }
      codexStage = body.method === 'link' ? CODEX_LINK : CODEX_DEVICE;
      return codexFlow(codexStage);
    }
    const credentialId = body.credentialId ?? 'claude-team';
    const resumed = body.restart !== true && claudeStarted.has(credentialId);
    claudeStarted.add(credentialId);
    return { ...flow(credentialId), ...(resumed ? { resumed: true } : {}) };
  }
  if (path === `/v1/fleet/login/${CODEX_FLOW_ID}`) {
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body ?? '{}')) as { method?: string };
      codexStage = body.method === 'link' ? CODEX_LINK : { state: 'finishing' };
      return { outcome: 'accepted', flow: codexFlow(codexStage) };
    }
    if (init?.method === 'DELETE') {
      codexStage = CODEX_DEVICE;
      return codexFlow({ state: 'failed', reason: 'this sign-in was cancelled', remedy: 'Start a new sign-in.' });
    }
    return codexFlow(codexStage);
  }
  if (path === '/v1/fleet/login/harness-flow') return flow('claude-team');
  const check = /^\/v1\/fleet\/credentials\/([^/]+)\/check$/u.exec(path);
  if (check !== null) return CREDENTIALS.credentials.find(item => item.id === decodeURIComponent(check[1] ?? ''));
  return undefined;
}
