/**
 * The conversions, in the owner's order of importance (brief item 5). Each step reads v4 files with this tool's own
 * parsers and writes v5 files through `V5Writer` with the schema its v5 owner declares.
 *
 * Phase A: no v5 plugin has landed a state schema yet, so every step is `pending` and names what it waits for. A
 * step becomes real by replacing its `run` — the table, the order and the not-carried list stay. While any step is
 * pending, `home.json` is not written and v5 refuses the folder: an incomplete conversion cannot be booted.
 */
import type { V4Paths } from '../v4/layout.ts';
import type { V5Writer } from '../v5/write.ts';
import type { NotCarried, StepReport } from '../report.ts';

export interface StepContext {
  readonly v4: V4Paths;
  readonly v5: V5Writer;
  readonly dryRun: boolean;
}

export interface Step {
  readonly id: string;
  readonly title: string;
  /** The v5 owner whose declared files this step writes (§9.2 of docs/design/redesign.md). */
  readonly owner: readonly string[];
  /** The v4 sources, relative to the v4 home (docs/migration/v4-formats.md has the full rows). */
  readonly reads: readonly string[];
  /** Files moved byte for byte, never opened. */
  readonly sealed: readonly string[];
  readonly notCarried: readonly NotCarried[];
  readonly run: (ctx: StepContext) => Promise<StepReport>;
}

function pending(step: Omit<Step, 'run'>, waitsFor: string): Step {
  return {
    ...step,
    run: async () => ({
      id: step.id,
      title: step.title,
      status: 'pending',
      note: `waits for ${waitsFor}`,
      kept: [],
      notCarried: step.notCarried,
      sealed: [],
    }),
  };
}

const CACHE: NotCarried = {
  what: 'derived indexes (SQLite caches)',
  why: 'v5 rebuilds every cache from the kept files',
};

export const STEPS: readonly Step[] = [
  pending(
    {
      id: 'ferrets',
      title: 'Ferrets (identity, lineage, archive, tokens)',
      owner: ['core-ferrets'],
      reads: [
        'state/sessions/<sid>/{config,state}.json, events.jsonl',
        'state/archived-sessions.json',
        'state/{callsigns,system-callsigns,agent-pins,worktrees}.json',
        'state/forks/',
        'state/restarts/queue.json',
      ],
      sealed: [],
      notCarried: [
        CACHE,
        { what: 'v4 session-version markers', why: 'v5 files carry their own format' },
        {
          what: 'per-ferret environment.json (a plaintext credential)',
          why: 'never opened; v5 keeps only its hash (sessionCapabilityHash) and re-mints at the next launch',
        },
      ],
    },
    'the Ferrets state schema (@ferretry/core-ferrets/contract)',
  ),
  pending(
    {
      id: 'conversation',
      title: 'Conversation (message queue, shared drafts, pins, sitrep)',
      owner: ['plugin-conversation'],
      reads: [
        'state/sessions/<sid>/channel/{queue,sends,answers}.jsonl',
        'state/sessions/<sid>/{turns/,pins.json,media/}',
        'state/shared-drafts/',
        'state/renders/',
        'state/attachments/<daemonId>/',
      ],
      sealed: ['state/session-message-token.key'],
      notCarried: [{ what: 'search and finder caches', why: 'rebuilt' }],
    },
    'the Conversation state schema (@ferretry/plugin-conversation/contract)',
  ),
  pending(
    {
      id: 'terminals',
      title: 'Terminals (running ferrets handed over by pane handle)',
      owner: ['plugin-terminals'],
      reads: [
        'state/sessions/<sid>/terminal-pane.json',
        'tmux.sock (home root; the live socket is hard-linked, never connected to)',
      ],
      sealed: [],
      notCarried: [
        {
          what: 'in-flight input holds',
          why: 'a hold mid-delivery is closed and its pane quarantined, as at any restart',
        },
      ],
    },
    'the Terminals state schema and the runner attach handle (spine D15)',
  ),
  pending(
    {
      id: 'harness-homes',
      title: 'Harness folders (Claude Code / Codex conversations, for resume)',
      owner: ['plugin-claude-code', 'plugin-codex'],
      reads: [
        'fleet/homes/<runtime uuid>/ (keyed by runtime)',
        'fleet/shared/<claude|codex>/ (the transcripts; moved whole, never parsed)',
      ],
      sealed: [],
      notCarried: [],
    },
    'the agent-homes location declared by the Claude Code and Codex plugins',
  ),
  pending(
    {
      id: 'board',
      title: 'Board (cards, lanes, links, dependencies, history)',
      owner: ['plugin-board'],
      reads: [
        'state/board/tasks/<id>.json',
        'state/board/counters.json',
        'board/ (lanes and switch, at the home root)',
      ],
      sealed: [],
      notCarried: [CACHE],
    },
    'the Board state schema (@ferretry/plugin-board/contract)',
  ),
  pending(
    {
      id: 'asks',
      title: 'Asks and agenda (asks, answers, notices, seen)',
      owner: ['core-asks', 'plugin-agenda'],
      reads: [
        'state/sessions/<sid>/{agenda,agenda-seen,agenda-replies}.json',
        'state/sessions/<sid>/agenda-history.jsonl',
      ],
      sealed: [],
      notCarried: [{ what: 'pending agenda change journals', why: 'applied or dropped by v4 before it stopped' }],
    },
    'the Asks and Agenda state schemas',
  ),
  pending(
    {
      id: 'projects',
      title: 'Projects',
      owner: ['plugin-projects'],
      reads: ['state/projects.json'],
      sealed: [],
      notCarried: [],
    },
    'the Projects state schema',
  ),
  pending(
    {
      id: 'lessons',
      title: 'Lessons',
      owner: ['plugin-lessons'],
      reads: ['state/learning/**', 'config/learning.yaml'],
      sealed: [],
      notCarried: [],
    },
    'the Lessons state and config schemas',
  ),
  pending(
    {
      id: 'usage',
      title: 'Usage history and budgets',
      owner: ['plugin-usage'],
      reads: [
        'state/budget-holds.json',
        'state/budget-told.json',
        'config/daemon.json (analyticsPricing keys)',
        'fleet/credentials/<login>/usage.json',
      ],
      sealed: [],
      notCarried: [CACHE],
    },
    'the Usage state schema',
  ),
  pending(
    {
      id: 'warden',
      title: 'Warden history and settings',
      owner: ['plugin-warden'],
      reads: ['state/warden/**', 'config/warden.yaml'],
      sealed: [],
      notCarried: [],
    },
    'the Warden state and config schemas',
  ),
  pending(
    {
      id: 'catalogs',
      title: 'Catalogs and shares (published catalogs, links, members, installs)',
      owner: ['plugin-catalogs', 'plugin-skills', 'plugin-mcp'],
      reads: ['state/catalogs/**', 'state/catalog-installs.json', 'state/local-skill-installs.json'],
      sealed: ['state/catalogs/link-keys.json'],
      notCarried: [
        { what: 'catalogs.v1.json, catalogs.v2.json, members.before-unique-names.json', why: 'v4 upgrade backups' },
      ],
    },
    'the Catalogs, Skills and MCP state schemas',
  ),
  pending(
    {
      id: 'layouts',
      title: 'Layouts and settings',
      owner: ['plugin-layouts', 'kernel'],
      reads: ['config/*.yaml'],
      sealed: [],
      notCarried: [],
    },
    'the Layouts config schema and each plugin’s config schema',
  ),
  pending(
    {
      id: 'runtimes',
      title: 'Runtimes and profiles',
      owner: ['plugin-runtimes'],
      reads: ['config/runtimes/**', 'config/profiles/**'],
      sealed: [],
      notCarried: [],
    },
    'the Runtimes config schemas',
  ),
  pending(
    {
      id: 'logins',
      title: 'Logins (harness sign-ins linked, never read)',
      owner: ['plugin-logins'],
      reads: ['config/logins/**', 'fleet/credentials/** (moved whole, never opened)'],
      sealed: [],
      notCarried: [],
    },
    'the Logins config schema and credentials location',
  ),
  pending(
    {
      id: 'vault',
      title: 'Secrets (sealed vault and key, moved unopened)',
      owner: ['core-vault'],
      reads: [],
      sealed: ['state/secrets.key', 'state/secrets.json', 'state/login-secrets.json', 'state/mcp-oauth-secrets.json'],
      notCarried: [{ what: 'live input requests', why: 'they belong to a moment that has passed' }],
    },
    'the Vault sealed-store paths (spine D16: byte-compatible)',
  ),
  pending(
    {
      id: 'access',
      title: 'Paired devices and passkeys (public keys, grants, unlock settings)',
      owner: ['plugin-access', 'kernel'],
      reads: ['state/devices.json', 'state/passkeys.json', 'state/security.json', 'config/daemon.json (grants key)'],
      sealed: ['state/daemon-identity.json', 'state/push-vapid.json', 'state/push.json'],
      notCarried: [
        { what: 'pairing codes', why: 'single-use and two minutes long; none survives a stop' },
        { what: 'live unlocks', why: 'each device unlocks again with its passkey' },
      ],
    },
    'the Access state schema and the Kernel identity key path',
  ),
];
