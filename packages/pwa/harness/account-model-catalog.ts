/**
 * The account-model catalogue the harness's set-up machine answers (the prototype's studio-mac):
 * components with every badge a page can carry, profiles with a base, a conflict and a skipped layer,
 * and the runtimes behind them. Every answer is parsed by the caller's own schema, so a schema change
 * fails the harness rather than drawing a page the daemon could never send.
 *
 * Changes are previewed by nothing here: staging one answers the refusal a machine gives while the
 * account model is switched off, so a hand review of a write shows that one sentence.
 */

import { FyHttpError } from '@ferretry/protocol/client';
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
          detail: { kind: 'instructions', file: 'components/instructions/Main instructions.md' },
          content: {
            form: 'text',
            text: '# How we work\n- Keep pull requests small and focused.\n- Run the tests before you push.\n- Ask before deleting anything you did not create.',
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
          detail: {
            kind: 'mcp',
            command: 'uvx',
            args: ['notes-mcp', '--vault', '/Users/kirin-on-a-long-machine-name/Documents/Notes'],
            env: [],
          },
          warnings: ['Command not found: uvx'],
          checkPath: '/Users/kirin-on-a-long-machine-name/Documents/Notes',
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
          detail: { kind: 'settings', file: 'components/settings/Agent settings.json', env: [] },
          content: { form: 'entries', entries: [{ key: 'permissions.defaultMode', value: 'acceptEdits' }] },
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
          detail: { kind: 'modelSets', models: ['claude-opus-5', 'claude-sonnet-5'], default: 'claude-sonnet-5' },
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

const PROFILES = {
  format: 'version-2',
  profiles: [
    {
      name: 'Agent',
      layers: ['settings/Agent settings'],
      usedBy: [],
      baseFor: ['Agent work'],
      wouldIncludeItself: ['Agent', 'Agent work'],
      harnesses: [stack('claude', { applied: ['settings/Agent settings'] }), stack('codex')],
      remove: { available: false, reason: 'It is a base for Agent work. Remove it from that profile first.' },
    },
    {
      name: 'Agent work',
      layers: ['profile/Default', 'profile/Agent'],
      usedBy: ['claude-agent'],
      baseFor: [],
      wouldIncludeItself: ['Agent work'],
      harnesses: [
        stack('claude', { applied: [...DEFAULT_LAYERS, 'settings/Agent settings'], conflicts: [CONFLICT] }),
        stack('codex'),
      ],
      remove: { available: true },
    },
    {
      name: 'Default',
      layers: DEFAULT_LAYERS,
      usedBy: ['claude-default', 'claude-work', 'codex-default'],
      baseFor: ['Agent work', 'Review'],
      wouldIncludeItself: ['Agent work', 'Default', 'Review'],
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
      harnesses: [stack('claude', { applied: DEFAULT_LAYERS }), stack('codex')],
      remove: { available: true },
    },
  ],
};

const runtime = (name: string, harness: 'claude' | 'codex', profile: string, credential: string) => ({
  name,
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
    runtime('claude-agent', 'claude', 'Agent work', 'claude-personal'),
    runtime('claude-default', 'claude', 'Default', 'claude-personal'),
    runtime('claude-review', 'claude', 'Review', 'claude-personal'),
    runtime('claude-work', 'claude', 'Default', 'claude-work'),
    runtime('codex-default', 'codex', 'Default', 'codex'),
  ],
};

const PERMISSIONS = {
  mayInspect: true,
  mayPropose: true,
  mayApply: true,
  applyRefusal: 'granted',
  confirmation: 'none',
};

/** A draft's layers, resolved the way the daemon would for the review step: the conflict appears with both bases. */
const draftView = (init: RequestInit | undefined) => {
  const layers = (JSON.parse(String(init?.body ?? '{}')) as { layers?: string[] }).layers ?? [];
  const conflicts = layers.includes('profile/Default') && layers.includes('profile/Agent') ? [CONFLICT] : [];
  return { harnesses: [stack('claude', { applied: layers, conflicts }), stack('codex')] };
};

/**
 * The catalogue's answer for `path`, or `undefined` when it is not a catalogue path. A change is refused
 * with the account model's own switched-off sentence.
 */
export function harnessCatalogAnswer(path: string, init?: RequestInit): unknown {
  const login = harnessCredentialAnswer(path, init);
  if (login !== undefined) return login;
  switch (path) {
    case '/v1/fleet/components':
      return COMPONENTS;
    case '/v1/fleet/profile-stacks':
      return PROFILES;
    case '/v1/fleet/runtimes':
      return RUNTIMES;
    case '/v1/fleet/profile-stacks/preview':
      return draftView(init);
    case '/v1/fleet/permissions':
      return PERMISSIONS;
    case '/v1/fleet/changes':
      throw new FyHttpError(
        'Account-model changes are switched off on this machine. Turn on accountModel.enabled in its daemon config to make changes here.',
        409,
        'fleet_change_disabled',
      );
    default:
      return undefined;
  }
}
