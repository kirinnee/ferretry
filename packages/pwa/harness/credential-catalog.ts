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
      usedBy: ['claude-agent', 'claude-default', 'claude-review'],
      signOut: {
        available: true,
        sentence:
          'Sign out of you@example.com (personal)? This also signs out claude in your terminal on studio-mac. 3 runtimes will need sign-in.',
        runtimesAffected: 3,
        signsOutTerminal: true,
      },
    }),
    login({
      id: 'claude-work',
      word: 'refresh_due',
      label: 'work',
      usage: usage(71, 83),
      usedBy: ['claude-work'],
      signOut: {
        available: true,
        sentence: 'Sign out of you@example.com (work)? 1 runtime will need sign-in.',
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
  ],
};

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
    runtime({ name: 'claude-default', sameAs: [] }),
    runtime({ name: 'claude-review', profile: 'Review' }),
    runtime({
      name: 'claude-work',
      credential: { id: 'claude-work', store: 'ferretry', label: 'work', status: 'refresh_due' },
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
