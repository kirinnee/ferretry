/**
 * The account-model catalogue the harness's set-up machine answers (the prototype's studio-mac):
 * components with every badge a page can carry, profiles with a base, a conflict and a skipped layer,
 * and the runtimes behind them. Every answer is parsed by the caller's own schema, so a schema change
 * fails the harness rather than drawing a page the daemon could never send.
 *
 * A change stages and applies: staging answers with the change it was sent, previewed as writing
 * nothing, and applying it answers as a committed apply — so a hand review can walk a write to Done.
 */

import { harnessCredentialAnswer } from './credential-catalog.ts';

/** A `${secret:NAME}` reference, spelled so it is never mistaken for a template. */
const secretRef = (name: string): string => ['$', `{secret:${name}}`].join('');

const stack = (harness: 'claude' | 'codex', fields: Record<string, unknown> = {}) => ({
  harness,
  available: { available: true },
  applied: [],
  skipped: [],
  conflicts: [],
  partial: [],
  ...fields,
});

const CONFLICT = {
  harness: 'claude',
  field: 'settings',
  key: 'permissions.defaultMode',
  sentence: '`permissions.defaultMode` · Claude Code: acceptEdits (from Agent) overrides plan (from Default)',
  winner: 'Agent',
  overridden: ['Default'],
};

const component = (fields: Record<string, unknown>) => ({
  partial: [],
  warnings: [],
  usedBy: { profiles: [], runtimes: [] },
  editNote: 'Nothing uses it yet.',
  remove: { available: true },
  ...fields,
});

const USED_WIDELY = {
  profiles: ['Agent work', 'Default', 'Review'],
  runtimes: ['claude-agent', 'claude-default', 'claude-review', 'codex-default'],
};

const COMPONENTS = {
  format: 'version-2',
  kinds: [
    {
      kind: 'instructions',
      label: 'Instructions',
      description: 'Guidance every session reads first.',
      components: [
        component({
          reference: 'instructions/Main instructions',
          kind: 'instructions',
          name: 'Main instructions',
          scope: 'generic',
          detail: { kind: 'instructions', file: 'components/instructions/Main instructions.md' },
          content: {
            form: 'text',
            text: '# How we work\n- Keep pull requests small and focused.\n- Run the tests before you push.\n- Ask before deleting anything you did not create.\n\n## Checks\n\nRun these before a pull request:\n\n```sh\nbun test\nbun run lint\n```',
            redacted: false,
          },
          usedBy: USED_WIDELY,
          editNote: 'Used by 3 profiles and 4 runtimes. Saving changes it everywhere.',
        }),
      ],
    },
    {
      kind: 'mcp',
      label: 'MCP servers',
      description: 'Tools a session can call.',
      components: [
        component({
          reference: 'mcp/github',
          kind: 'mcp',
          name: 'github',
          scope: 'generic',
          detail: {
            kind: 'mcp',
            command: 'npx',
            args: ['-y', '@modelcontextprotocol/server-github'],
            env: [{ name: 'GITHUB_TOKEN', value: secretRef('GITHUB_TOKEN') }],
          },
          usedBy: USED_WIDELY,
        }),
        component({
          reference: 'mcp/notes',
          kind: 'mcp',
          name: 'notes',
          scope: 'generic',
          detail: {
            kind: 'mcp',
            command: 'uvx',
            args: ['notes-mcp', '--vault', '/Users/kirin-on-a-long-machine-name/Documents/Notes'],
            env: [],
          },
          warnings: ['Command not found: uvx'],
          checkPath: '/Users/kirin-on-a-long-machine-name/Documents/Notes',
          // Copied by Clone from the harness's "Work laptop" pairing, so the badge names it by that label.
          clonedFrom: 'work-mac',
          clonedFromDaemon: 'clone-source-daemon',
          usedBy: { profiles: ['Default'], runtimes: ['claude-default', 'codex-default'] },
        }),
      ],
    },
    {
      kind: 'skills',
      label: 'Skills',
      description: 'Named abilities a session can use.',
      components: [
        component({
          reference: 'skills/My skills',
          kind: 'skills',
          name: 'My skills',
          scope: 'generic',
          detail: { kind: 'skills', items: ['release-notes', 'pr-review', 'changelog', 'db-migrate'] },
          partial: [
            {
              harness: 'codex',
              reason: 'release-notes limits which tools it may use. Codex ignores that limit and loads the rest.',
            },
          ],
        }),
      ],
    },
    {
      kind: 'settings',
      label: 'Settings',
      description: 'Flags, environment and options for one tool.',
      components: [
        component({
          reference: 'settings/Claude settings',
          kind: 'settings',
          name: 'Claude settings',
          harness: 'claude',
          scope: 'claude',
          detail: { kind: 'settings', file: 'components/settings/Claude settings.json', env: [] },
          content: {
            form: 'entries',
            entries: [
              { key: 'env.ANTHROPIC_API_KEY', hidden: true },
              { key: 'env.LOG_LEVEL', value: 'info' },
              { key: 'permissions.defaultMode', value: 'plan' },
            ],
          },
        }),
        component({
          reference: 'settings/Agent settings',
          kind: 'settings',
          name: 'Agent settings',
          harness: 'claude',
          scope: 'claude',
          detail: { kind: 'settings', file: 'components/settings/Agent settings.json', env: [] },
          content: { form: 'entries', entries: [{ key: 'permissions.defaultMode', value: 'acceptEdits' }] },
        }),
        component({
          reference: 'settings/Codex settings',
          kind: 'settings',
          name: 'Codex settings',
          harness: 'codex',
          scope: 'codex',
          detail: { kind: 'settings', file: 'components/settings/Codex settings.toml', env: [] },
          content: { form: 'entries', entries: [{ key: 'approval_policy', value: 'on-request' }] },
          usedBy: { profiles: ['Codex', 'Old mix'], runtimes: ['codex-default'] },
        }),
      ],
    },
    {
      kind: 'hooks',
      label: 'Hooks',
      description: 'Commands that run at points in a session, for one tool.',
      components: [],
    },
    {
      kind: 'modelSets',
      label: 'Model sets',
      description: 'The models a runtime offers, and its default.',
      components: [
        component({
          reference: 'modelSets/Claude models',
          kind: 'modelSets',
          name: 'Claude models',
          scope: 'claude',
          detail: { kind: 'modelSets', models: ['claude-opus-5', 'claude-sonnet-5'], default: 'claude-sonnet-5' },
        }),
        component({
          reference: 'modelSets/Codex models',
          kind: 'modelSets',
          name: 'Codex models',
          scope: 'codex',
          detail: { kind: 'modelSets', models: ['gpt-6'], default: 'gpt-6' },
        }),
      ],
    },
  ],
};

const DEFAULT_LAYERS = [
  'instructions/Main instructions',
  'mcp/github',
  'mcp/notes',
  'skills/My skills',
  'settings/Claude settings',
  'modelSets/Claude models',
];

/** The generic parts both tools share, as a base the Codex profile builds on. */
const SHARED_LAYERS = ['instructions/Main instructions', 'mcp/github', 'skills/My skills'];

const MIXED_SENTENCE =
  "Profile Old mix can't be both Claude only and Codex only: settings Claude settings is Claude only and settings Codex settings is Codex only.";

/** Each layer's scope as the daemon derives it, so a draft reads Generic, one tool's, or mixed. */
const LAYER_SCOPES: Readonly<Record<string, 'claude' | 'codex' | 'mixed'>> = {
  'settings/Claude settings': 'claude',
  'settings/Agent settings': 'claude',
  'modelSets/Claude models': 'claude',
  'settings/Codex settings': 'codex',
  'modelSets/Codex models': 'codex',
  'profile/Agent': 'claude',
  'profile/Agent work': 'claude',
  'profile/Default': 'claude',
  'profile/Review': 'claude',
  'profile/Codex': 'codex',
  'profile/Old mix': 'mixed',
};

const PROFILES = {
  format: 'version-2',
  profiles: [
    {
      name: 'Agent',
      layers: ['settings/Agent settings'],
      usedBy: [],
      baseFor: ['Agent work'],
      wouldIncludeItself: ['Agent', 'Agent work'],
      scope: { kind: 'scoped', scope: 'claude' },
      harnesses: [stack('claude', { applied: ['settings/Agent settings'] }), stack('codex')],
      remove: { available: false, reason: 'It is a base for Agent work. Remove it from that profile first.' },
    },
    {
      name: 'Agent work',
      layers: ['profile/Default', 'profile/Agent'],
      usedBy: ['claude-agent'],
      baseFor: [],
      wouldIncludeItself: ['Agent work'],
      scope: { kind: 'scoped', scope: 'claude' },
      harnesses: [
        stack('claude', { applied: [...DEFAULT_LAYERS, 'settings/Agent settings'], conflicts: [CONFLICT] }),
        stack('codex'),
      ],
      remove: { available: true },
    },
    {
      name: 'Default',
      layers: DEFAULT_LAYERS,
      usedBy: ['claude-default', 'claude-work'],
      baseFor: ['Agent work', 'Review'],
      wouldIncludeItself: ['Agent work', 'Default', 'Review'],
      scope: { kind: 'scoped', scope: 'claude' },
      harnesses: [
        stack('claude', { applied: DEFAULT_LAYERS }),
        stack('codex', {
          applied: DEFAULT_LAYERS.filter(layer => !layer.startsWith('settings/')),
          skipped: [
            {
              reference: 'settings/Claude settings',
              sentence: 'Settings Claude settings is for Claude Code only, so it is skipped on Codex.',
            },
          ],
        }),
      ],
      remove: {
        available: false,
        reason: 'It is a base for Agent work and Review. Remove it from those profiles first.',
      },
    },
    {
      name: 'Review',
      layers: ['profile/Default'],
      usedBy: ['claude-review'],
      baseFor: [],
      wouldIncludeItself: ['Review'],
      scope: { kind: 'scoped', scope: 'claude' },
      harnesses: [stack('claude', { applied: DEFAULT_LAYERS }), stack('codex')],
      remove: { available: true },
    },
    {
      name: 'Shared',
      layers: SHARED_LAYERS,
      usedBy: [],
      baseFor: ['Codex'],
      wouldIncludeItself: ['Codex', 'Shared'],
      scope: { kind: 'scoped', scope: 'generic' },
      harnesses: [stack('claude', { applied: SHARED_LAYERS }), stack('codex', { applied: SHARED_LAYERS })],
      remove: { available: false, reason: 'It is a base for Codex. Remove it from that profile first.' },
    },
    {
      name: 'Codex',
      layers: ['profile/Shared', 'settings/Codex settings', 'modelSets/Codex models'],
      usedBy: ['codex-default'],
      baseFor: [],
      wouldIncludeItself: ['Codex'],
      scope: { kind: 'scoped', scope: 'codex' },
      harnesses: [
        stack('claude', { applied: SHARED_LAYERS }),
        stack('codex', { applied: [...SHARED_LAYERS, 'settings/Codex settings', 'modelSets/Codex models'] }),
      ],
      remove: { available: true },
    },
    {
      // Written before profiles had a scope: still readable, and the badge says what to fix.
      name: 'Old mix',
      layers: ['settings/Claude settings', 'settings/Codex settings'],
      usedBy: [],
      baseFor: [],
      wouldIncludeItself: ['Old mix'],
      scope: { kind: 'mixed', sentence: MIXED_SENTENCE },
      harnesses: [
        stack('claude', { applied: ['settings/Claude settings'] }),
        stack('codex', { applied: ['settings/Codex settings'] }),
      ],
      remove: { available: true },
    },
  ],
};

export const harnessRuntime = (name: string, harness: 'claude' | 'codex', profile: string, credential: string) => ({
  id: `runtime-${name}`,
  name,
  wrapper: name,
  harness,
  credential: { id: credential, store: credential === 'claude-work' ? 'ferretry' : 'host' },
  profile,
  agent: name.includes('agent'),
  stack: stack(harness),
  modelSet: { source: 'harness-default' },
  launch: { available: true },
  sameAs: [],
});

const RUNTIMES = {
  format: 'version-2',
  runtimes: [
    harnessRuntime('claude-agent', 'claude', 'Agent work', 'claude-personal'),
    harnessRuntime('claude-default', 'claude', 'Default', 'claude-personal'),
    harnessRuntime('claude-review', 'claude', 'Review', 'claude-personal'),
    harnessRuntime('claude-work', 'claude', 'Default', 'claude-work'),
    harnessRuntime('codex-default', 'codex', 'Codex', 'codex'),
  ],
};

/** The one id every staged change in the harness carries. */
const HARNESS_CHANGE_ID = 'fy_fprop_harnesspreviewchange00';

/** Staging answers with the change it was sent, previewed as writing nothing: the harness has no disk. */
/** The ferrets a removal's dry run finds still running on the runtime, as the daemon would list them. */
const RUNNING_ON_REMOVED = [
  { id: 'ms0v8vgc-d445a669', name: 'Fisher', harness: 'codex' },
  { id: 'ms0v8vgc-77c1e2b0', name: 'Otter, fixing the onboarding inset on phones', harness: 'codex' },
];

/** The ferrets running on the two runtimes that use claude-work, as a login removal's dry run lists them. */
const RUNNING_ON_LOGIN = [
  { id: 'ms0v8vgc-d445a669', name: 'Fisher', harness: 'claude', runtime: 'claude-review' },
  {
    id: 'ms0v8vgc-77c1e2b0',
    name: 'Otter, fixing the onboarding inset on phones',
    harness: 'claude',
    runtime: 'claude-review',
  },
  { id: 'ms0v8vgc-5e0a31c9', name: 'Stoat', harness: 'claude', runtime: 'claude-work' },
];

interface HarnessChange {
  readonly kind?: string;
  readonly id?: string;
  readonly switchRuntimes?: Record<string, string>;
  readonly removeRuntimes?: readonly string[];
}

/** What removing a login says it does, in the daemon's words, for the choices made in the dialog. */
const loginRemoval = (change: HarnessChange) => {
  const used = change.id === 'claude-work';
  const switches = Object.entries(change.switchRuntimes ?? {});
  const removals = change.removeRuntimes ?? [];
  const consequences: string[] = [];
  for (const target of new Set(switches.map(([, to]) => to))) {
    const names = switches.filter(([, to]) => to === target).map(([name]) => name);
    consequences.push(
      `${names.join(' and ')} ${names.length === 1 ? 'moves' : 'move'} to login ${target}, starting with it the next time ${names.length === 1 ? 'it launches' : 'they launch'}.`,
    );
  }
  if (removals.length > 0)
    consequences.push(
      `Removes ${removals.length} ${removals.length === 1 ? 'runtime' : 'runtimes'}: ${removals.join(', ')}. Their past sessions stay in history.`,
    );
  if (used)
    consequences.push(
      '3 ferrets are running on those runtimes. They keep running, but restarting one on a removed runtime later needs another runtime.',
    );
  consequences.push('Its saved sign-in stays on this machine. To delete it, sign the login out before removing it.');
  return { consequences, running: used ? RUNNING_ON_LOGIN : [] };
};

const stagedView = (init: RequestInit | undefined) => {
  const { change } = JSON.parse(String(init?.body ?? '{}')) as { change?: HarnessChange };
  // A removal says what it does to the ferrets on the runtime first, as the daemon's dry run does.
  const removal = change?.kind === 'runtime.remove';
  const login = change?.kind === 'credential.remove' ? loginRemoval(change) : null;
  const running = login === null ? (removal ? RUNNING_ON_REMOVED : []) : login.running;
  return {
    id: HARNESS_CHANGE_ID,
    revision: 'harness',
    change,
    summary: 'Preview of this change on studio-mac',
    consequences:
      login !== null
        ? login.consequences
        : removal
          ? [
              '2 ferrets are running on it. They keep running, but restarting them later needs another runtime. Its past sessions stay in history.',
            ]
          : [],
    expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    state: 'pending',
    preview: {
      kind: 'apply',
      operations: [],
      documents: [],
      runtimes: [],
      ...(running.length > 0 ? { runningSessions: running } : {}),
    },
  };
};

/** Applying it answers as a committed apply that wrote nothing. */
const APPLIED = {
  outcome: 'applied',
  apply: {
    outcome: 'committed',
    result: {
      accountCount: 5,
      operationCount: 0,
      manifestPath: '/home/pilot/.ferretry/fleet/manifest.json',
      prunedWrappers: [],
      sharedHistory: [],
    },
  },
};

/** What each component sets, by key, as the harness's stand-in for the daemon's Resolved projection. */
const SETS: Readonly<Record<string, readonly (readonly [field: string, key: string, value: string, hidden?: true])[]>> =
  {
    'instructions/Main instructions': [
      ['instructions', 'Main instructions', 'components/instructions/Main instructions.md'],
    ],
    'mcp/github': [['mcp', 'github', 'npx -y @modelcontextprotocol/server-github']],
    'mcp/notes': [['mcp', 'notes', 'uvx notes-mcp --vault /Users/kirin-on-a-long-machine-name/Documents/Notes']],
    'skills/My skills': [
      ['skills', 'release-notes', 'included'],
      ['skills', 'pr-review', 'included'],
    ],
    'settings/Claude settings': [
      ['settings', 'permissions.defaultMode', 'plan'],
      ['env', 'env.LOG_LEVEL', 'info'],
      ['env', 'env.ANTHROPIC_API_KEY', '‹hidden›', true],
    ],
    'settings/Agent settings': [['settings', 'permissions.defaultMode', 'acceptEdits']],
    'settings/Codex settings': [['settings', 'approval_policy', 'on-request']],
    'modelSets/Claude models': [['model', 'model', 'claude-sonnet-5']],
    'modelSets/Codex models': [['model', 'model', 'gpt-6']],
  };

/** A content item flattened to its components, each with the item that brought it in. */
const flatten = (layers: readonly string[], origin?: string): readonly (readonly [string, string])[] =>
  layers.flatMap(layer => {
    if (!layer.startsWith('profile/')) return [[layer, origin ?? layer] as const];
    const named = PROFILES.profiles.find(each => `profile/${each.name}` === layer);
    return named === undefined ? [] : flatten(named.layers, origin ?? layer);
  });

/** Every final value per harness, later winning, each with what it overrode. */
const resolvedOf = (layers: readonly string[]) =>
  (['claude', 'codex'] as const).flatMap(harness => {
    const final = new Map<string, Record<string, unknown>>();
    for (const [reference, from] of flatten(layers)) {
      const scope = LAYER_SCOPES[reference];
      if (scope !== undefined && scope !== harness) continue;
      for (const [field, key, value, hidden] of SETS[reference] ?? []) {
        const id = `${field}\n${key}`;
        const before = final.get(id);
        const overridden =
          before === undefined
            ? []
            : [
                ...(before.overridden as unknown[]),
                { value: before.value, ...(before.hidden ? { hidden: true } : {}), from: before.from },
              ];
        final.delete(id);
        final.set(id, { harness, field, key, value, ...(hidden ? { hidden } : {}), from, overridden });
      }
    }
    return [...final.values()];
  });

/** A draft's layers, resolved the way the daemon would for the review step: the conflict appears with both bases. */
const draftView = (init: RequestInit | undefined) => {
  const layers = (JSON.parse(String(init?.body ?? '{}')) as { layers?: string[] }).layers ?? [];
  const conflicts = layers.includes('profile/Default') && layers.includes('profile/Agent') ? [CONFLICT] : [];
  const harnesses = [stack('claude', { applied: layers, conflicts }), stack('codex')];
  const claude = layers.find(layer => LAYER_SCOPES[layer] === 'claude' || LAYER_SCOPES[layer] === 'mixed');
  const codex = layers.find(layer => LAYER_SCOPES[layer] === 'codex' || LAYER_SCOPES[layer] === 'mixed');
  if (claude !== undefined && codex !== undefined) {
    const words = (layer: string) => layer.replace('/', ' ').replace('modelSets', 'model set');
    const sentence = `A profile can't be both Claude only and Codex only: ${words(claude)} is Claude only and ${words(codex)} is Codex only.`;
    return { harnesses, scope: { kind: 'mixed', sentence }, refusal: sentence, resolved: resolvedOf(layers) };
  }
  const scope = claude !== undefined ? 'claude' : codex !== undefined ? 'codex' : 'generic';
  return { harnesses, scope: { kind: 'scoped', scope }, resolved: resolvedOf(layers) };
};

/** The catalogue's answer for `path`, or `undefined` when it is not a catalogue path. */
export function harnessCatalogAnswer(path: string, init?: RequestInit): unknown {
  const login = harnessCredentialAnswer(path, init);
  if (login !== undefined) return login;
  switch (path) {
    case '/v1/fleet/components':
      return COMPONENTS;
    case '/v1/fleet/profiles':
      return PROFILES;
    case '/v1/fleet/runtimes':
      return RUNTIMES;
    case '/v1/fleet/profiles/preview':
      return draftView(init);
    case '/v1/fleet/proposals':
      return stagedView(init);
    case `/v1/fleet/proposals/${HARNESS_CHANGE_ID}/apply`:
      return APPLIED;
    default:
      return undefined;
  }
}
