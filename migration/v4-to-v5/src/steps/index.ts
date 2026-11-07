/**
 * The conversions, in the owner's order of importance (brief item 5). Each step reads v4 files with this tool's own
 * parsers and writes v5 files through `V5Writer` with the schema its v5 owner declares.
 *
 * A step whose v5 owner has not landed its state schema yet is `pending` and names what it waits for. A step
 * becomes real by replacing its `run` (the Vault and identity steps are real: `./secrets.ts`) — the table, the order and the not-carried list stay. While any step is
 * pending, `home.json` is not written and v5 refuses the folder: an incomplete conversion cannot be booted.
 */
import type { V4Paths } from '../v4/layout.ts';
import type { V5Writer } from '../v5/write.ts';
import type { NotCarried, StepReport } from '../report.ts';
import { ferretsStep } from './ferrets.ts';
import { terminalsStep } from './terminals.ts';
import { harnessHomesStep } from './harness-homes.ts';
import { identityStep, vaultStep } from './secrets.ts';

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
  ferretsStep,
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
  terminalsStep,
  harnessHomesStep,
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
    'the Asks and Agenda state schemas (asks get v5 global ids through one old-to-new map that also rewrites card and agenda links, M6)',
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
      sealed: ['state/catalogs/link-keys.json', 'state/mcp-oauth-secrets.json'],
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
  vaultStep,
  identityStep,
  pending(
    {
      id: 'accounts',
      title: 'Website accounts (index, sign-in and copy rules; sealed values moved unopened)',
      owner: ['plugin-accounts'],
      reads: ['state/login-entries.json', 'state/accounts/sign-in-rules.json', 'state/secure-copy/rules.json'],
      sealed: ['state/login-secrets.json'],
      notCarried: [{ what: 'login-entries.v1.json', why: 'a v4 upgrade backup, never read' }],
    },
    'the Accounts state schema and its sealed-document declaration',
  ),
  pending(
    {
      id: 'access',
      title: 'Paired devices and passkeys (public keys, grants, unlock settings)',
      owner: ['plugin-access', 'kernel'],
      reads: ['state/devices.json', 'state/passkeys.json', 'state/security.json', 'config/daemon.json (grants key)'],
      sealed: ['state/push-vapid.json', 'state/push.json'],
      notCarried: [
        { what: 'pairing codes', why: 'single-use and two minutes long; none survives a stop' },
        { what: 'live unlocks', why: 'each device unlocks again with its passkey' },
      ],
    },
    'the Access state schema and the Kernel identity key path',
  ),
];
