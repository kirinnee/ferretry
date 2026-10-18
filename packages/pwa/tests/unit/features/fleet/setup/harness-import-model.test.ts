import { describe, expect, it } from 'bun:test';
import type { FleetHarnessScan, FleetSetupScan } from '@ferretry/protocol';
import {
  foundRows,
  type HarnessAnswers,
  harnessImportChange,
  harnessProblems,
  importButtonLabel,
  importNotes,
  makesRuntime,
  missingTools,
  offersSignIn,
  type RuntimePlan,
  runtimeName,
  runtimePlan,
  scanHasHarness,
  scanSignedIn,
  updateDetail,
  updateTitle,
} from '../../../../../src/features/fleet/setup/harness-import-model.ts';
import { NOTHING_INSTALLED, scan } from './setup-support.ts';

const claudeWith = (overrides: Record<string, unknown>): FleetHarnessScan => ({
  ...(scan().harnesses.find(found => found.harness === 'claude') as FleetHarnessScan),
  ...overrides,
});

const codexWith = (overrides: Record<string, unknown>): FleetHarnessScan => ({
  ...(scan().harnesses.find(found => found.harness === 'codex') as FleetHarnessScan),
  ...overrides,
});

const withCodex = (overrides: Record<string, unknown>): FleetSetupScan =>
  scan({ harnesses: [scan().harnesses[0] as FleetHarnessScan, codexWith(overrides)] });

const withClaude = (overrides: Record<string, unknown>): FleetSetupScan =>
  scan({ harnesses: [claudeWith(overrides), scan().harnesses[1] as FleetHarnessScan] });

describe('what is installed', () => {
  it('knows which harnesses the scan saw installed', () => {
    expect(scanHasHarness(scan(), 'claude')).toBe(true);
    expect(scanHasHarness(NOTHING_INSTALLED, 'claude')).toBe(false);
    expect(scanHasHarness(scan({ harnesses: [] }), 'codex')).toBe(false);
  });
});

describe('missingTools', () => {
  it('lists only the tools that are not installed', () => {
    const missing = missingTools(NOTHING_INSTALLED.tools);
    expect(missing.map(tool => tool.harness)).toEqual(['claude', 'codex']);
    expect(missingTools(scan().tools)).toEqual([]);
  });
});

describe('foundRows: the account row', () => {
  const account = (found: FleetSetupScan) => foundRows(found, 'codex', false)[0];

  it('says signed in, with the email when there is one', () => {
    const [row] = foundRows(scan(), 'claude', false);
    expect(row).toEqual({
      key: 'account',
      label: 'Account',
      title: 'Signed in',
      detail: 'you@example.com',
      status: 'ready',
      badges: [],
    });
  });

  it('says signed in with no detail when there is no email', () => {
    const row = account(withCodex({ account: { state: 'signed-in' } }));
    expect(row?.title).toBe('Signed in');
    expect(row?.detail).toBeUndefined();
    expect(row?.status).toBe('ready');
  });

  it('says a refresh is due and when it renews, with the email (E6)', () => {
    const row = account(withCodex({ account: { state: 'refresh-due', email: 'a@b.test' } }));
    expect(row?.title).toBe('Signed in · refresh due');
    expect(row?.detail).toBe('a@b.test · It renews the first time you launch.');
    expect(row?.status).toBe('refresh_due');
  });

  it('says a refresh is due without an email (E6)', () => {
    const row = account(withCodex({ account: { state: 'refresh-due' } }));
    expect(row?.detail).toBe('It renews the first time you launch.');
  });

  it('says not signed in and that the setup can still be imported (E4)', () => {
    const [row] = foundRows(scan(), 'codex', false);
    expect(row?.title).toBe('Not signed in');
    expect(row?.detail).toBe('Your setup can still be imported.');
    expect(row?.status).toBe('needs_sign_in');
  });

  it('says a login could not be read, with the reason when given', () => {
    const row = account(withCodex({ account: { state: 'unreadable', reason: 'The keychain is locked.' } }));
    expect(row?.title).toBe('Couldn’t read this login');
    expect(row?.detail).toBe('The keychain is locked.');
    expect(row?.status).toBe('needs_sign_in');
  });

  it('falls back to a sentence when an unreadable login has no reason', () => {
    const row = account(withCodex({ account: { state: 'unreadable' } }));
    expect(row?.detail).toBe('Your setup can still be imported. You can sign in afterwards.');
  });

  it('says a login cannot be shared, with the reason when given', () => {
    const row = account(withCodex({ account: { state: 'not-shareable', reason: 'It belongs to a company.' } }));
    expect(row?.title).toBe('This login can’t be shared');
    expect(row?.detail).toBe('It belongs to a company.');
    expect(row?.status).toBe('needs_sign_in');
  });

  it('falls back to a sentence when a login that cannot be shared has no reason', () => {
    const row = account(withCodex({ account: { state: 'not-shareable' } }));
    expect(row?.title).toBe('This login can’t be shared');
    expect(row?.detail).toBe('Your setup can still be imported. You can sign in afterwards.');
  });
});

describe('foundRows: what else was found', () => {
  it('lists nothing for a harness the scan does not have', () => {
    expect(foundRows(scan({ harnesses: [] }), 'claude', false)).toEqual([]);
  });

  it('lists every kind of thing Claude Code has, with badges for secrets and missing commands (E7, E8)', () => {
    const rows = foundRows(scan(), 'claude', false);
    expect(rows.map(row => row.key)).toEqual(['account', 'instructions', 'settings', 'mcp', 'skills']);
    expect(rows[1]).toEqual({
      key: 'instructions',
      label: 'Instructions',
      title: 'CLAUDE.md',
      detail: '2.1 KB',
      badges: [],
    });
    expect(rows[2]).toEqual({
      key: 'settings',
      label: 'Settings',
      title: 'settings.json',
      detail: '6 settings, 1 hook',
      badges: [{ text: '2 secret values · go to the secret store, never shown', tone: 'warn' }],
    });
    expect(rows[3]).toEqual({
      key: 'mcp',
      label: 'MCP servers',
      title: '3',
      detail: 'github, linear, notes',
      badges: [{ text: 'Command not found: uvx', tone: 'warn' }],
    });
    expect(rows[4]).toEqual({
      key: 'skills',
      label: 'Skills',
      title: '2',
      detail: 'release-notes, pr-review',
      badges: [],
    });
  });

  it('says a single secret value in the singular (E7)', () => {
    const rows = foundRows(withClaude({ secretKeys: ['env.TOKEN'] }), 'claude', false);
    expect(rows.find(row => row.key === 'settings')?.badges).toEqual([
      { text: '1 secret value · go to the secret store, never shown', tone: 'warn' },
    ]);
  });

  it('names the setting count alone when there are no hooks, and no badge when there are no secrets', () => {
    const rows = foundRows(
      withClaude({ settings: { source: 'C:\\Users\\you\\settings.json', count: 1, hooks: 0 }, secretKeys: [] }),
      'claude',
      false,
    );
    const settings = rows.find(row => row.key === 'settings');
    expect(settings?.title).toBe('settings.json');
    expect(settings?.detail).toBe('1 setting');
    expect(settings?.badges).toEqual([]);
  });

  it('gives one badge per missing command and none when every command is there (E8)', () => {
    const two = foundRows(withClaude({ missingCommands: ['uvx', 'npx'] }), 'claude', false);
    expect(two.find(row => row.key === 'mcp')?.badges.map(badge => badge.text)).toEqual([
      'Command not found: uvx',
      'Command not found: npx',
    ]);
    const none = foundRows(withClaude({ missingCommands: [] }), 'claude', false);
    expect(none.find(row => row.key === 'mcp')?.badges).toEqual([]);
  });

  it('omits the rows for things that were not found', () => {
    const rows = foundRows(
      withClaude({ instructions: undefined, settings: undefined, mcpServers: [], skills: ['one'] }),
      'claude',
      false,
    );
    expect(rows.map(row => row.key)).toEqual(['account', 'skills']);
  });

  it('shows kilobytes with a decimal only when it is not a whole number', () => {
    const size = (bytes: number) =>
      foundRows(
        withClaude({ instructions: { name: 'CLAUDE.md', source: '/x/CLAUDE.md', bytes } }),
        'claude',
        false,
      ).find(row => row.key === 'instructions')?.detail;
    expect(size(0)).toBe('0 bytes');
    expect(size(1)).toBe('1 byte');
    expect(size(1023)).toBe('1023 bytes');
    expect(size(2048)).toBe('2 KB');
    expect(size(2150)).toBe('2.1 KB');
  });

  it('says Nothing found with a Starter profile sentence naming the file (E5)', () => {
    const empty = {
      instructions: undefined,
      settings: undefined,
      mcpServers: [],
      skills: [],
      secretKeys: [],
      missingCommands: [],
    };
    const claude = foundRows(withClaude(empty), 'claude', false);
    expect(claude.map(row => row.key)).toEqual(['account', 'setup']);
    expect(claude[1]).toEqual({
      key: 'setup',
      label: 'Setup',
      title: 'Nothing found',
      detail:
        'No CLAUDE.md, settings, MCP servers or skills. Ferretry will make a plain Starter profile. You can add to it later.',
      badges: [],
    });
    const codex = foundRows(withCodex({ instructions: undefined }), 'codex', false);
    expect(codex[1]?.title).toBe('Nothing found');
    expect(codex[1]?.detail).toStartWith('No AGENTS.md, settings,');
  });

  it('is not Nothing found when only settings exist', () => {
    const rows = foundRows(
      withClaude({
        instructions: undefined,
        mcpServers: [],
        skills: [],
        settings: { source: '/x/settings.json', count: 2, hooks: 0 },
      }),
      'claude',
      false,
    );
    expect(rows.map(row => row.key)).toEqual(['account', 'settings']);
  });
});

describe('foundRows: Codex instructions against Claude Code (E9)', () => {
  it('says same when Claude is being imported and the files are identical', () => {
    const rows = foundRows(scan({ instructionsIdentical: true }), 'codex', true);
    expect(rows.find(row => row.key === 'instructions')?.badges).toEqual([
      { text: 'Same as your CLAUDE.md · one shared copy', tone: 'ok' },
    ]);
  });

  it('says different when Claude is being imported and the files differ', () => {
    const rows = foundRows(scan({ instructionsIdentical: false }), 'codex', true);
    expect(rows.find(row => row.key === 'instructions')?.badges).toEqual([
      { text: 'Different from your CLAUDE.md · kept separately', tone: 'accent' },
    ]);
  });

  it('says nothing about the match when Claude is not being imported', () => {
    expect(
      foundRows(scan({ instructionsIdentical: true }), 'codex', false).find(row => row.key === 'instructions')?.badges,
    ).toEqual([]);
  });

  it('says nothing about the match when the scan could not tell', () => {
    const { instructionsIdentical: _omitted, ...rest } = scan();
    const unknown = scan({ ...rest, instructionsIdentical: undefined });
    expect(foundRows(unknown, 'codex', true).find(row => row.key === 'instructions')?.badges).toEqual([]);
  });

  it('never compares Claude Code against itself', () => {
    expect(
      foundRows(scan({ instructionsIdentical: true }), 'claude', true).find(row => row.key === 'instructions')?.badges,
    ).toEqual([]);
  });
});

describe('harnessProblems', () => {
  it('returns the problems the scan found for the harness', () => {
    expect(harnessProblems(withClaude({ problems: ['settings.json is not valid JSON.'] }), 'claude')).toEqual([
      'settings.json is not valid JSON.',
    ]);
    expect(harnessProblems(scan(), 'claude')).toEqual([]);
  });

  it('returns none for a harness the scan does not have', () => {
    expect(harnessProblems(scan({ harnesses: [] }), 'codex')).toEqual([]);
  });
});

describe('offersSignIn', () => {
  it('offers Sign in now only for an own login that is there to share but not signed in', () => {
    expect(offersSignIn(scan(), 'codex')).toBe(true);
    expect(offersSignIn(scan(), 'claude')).toBe(false);
    expect(offersSignIn(withCodex({ account: { state: 'refresh-due' } }), 'codex')).toBe(false);
    expect(offersSignIn(withCodex({ account: { state: 'unreadable' } }), 'codex')).toBe(false);
    expect(offersSignIn(withCodex({ account: { state: 'not-shareable' } }), 'codex')).toBe(false);
    expect(offersSignIn(scan({ harnesses: [] }), 'codex')).toBe(false);
  });
});

describe('updates', () => {
  it('titles a known kind in words, never the word component', () => {
    expect(updateTitle('mcp/github')).toBe('MCP server · github');
    expect(updateTitle('instructions/CLAUDE.md')).toBe('Instructions · CLAUDE.md');
    expect(updateTitle('skills/pr-review')).toBe('Skills · pr-review');
    expect(updateTitle('settings/claude')).toBe('Settings · claude');
    expect(updateTitle('hooks/pre')).toBe('Hooks · pre');
    expect(updateTitle('modelSets/fast')).toBe('Model set · fast');
  });

  it('keeps a name that has slashes in it whole', () => {
    expect(updateTitle('skills/team/review')).toBe('Skills · team/review');
  });

  it('shows the reference itself for an unknown kind or a missing name', () => {
    expect(updateTitle('widgets/one')).toBe('widgets/one');
    expect(updateTitle('mcp')).toBe('mcp');
    expect(updateTitle('mcp/')).toBe('mcp/');
    expect(updateTitle('')).toBe('');
  });

  it('says what changed using file names only', () => {
    expect(updateDetail(['/home/you/.claude/settings.json'])).toBe('Changed since the last import: settings.json.');
    expect(updateDetail(['/a/CLAUDE.md', '/b/settings.json', '/c/skill.md'])).toBe(
      'Changed since the last import: CLAUDE.md, settings.json and skill.md.',
    );
  });
});

describe('importNotes', () => {
  it('returns the notes for the harnesses that were imported', () => {
    expect(importNotes(scan(), ['claude', 'codex'])).toEqual([
      'notes needs uvx: install uv on studio-mac and it starts working.',
      'Codex needs sign-in before it launches.',
    ]);
    expect(importNotes(scan(), ['codex'])).toEqual(['Codex needs sign-in before it launches.']);
  });

  it('returns nothing when nothing was imported', () => {
    expect(importNotes(scan(), [])).toEqual([]);
  });
});

describe('scanSignedIn', () => {
  it('is signed in for a signed-in login and for one whose refresh is due', () => {
    expect(scanSignedIn(scan(), 'claude')).toBe(true);
    expect(scanSignedIn(withCodex({ account: { state: 'refresh-due' } }), 'codex')).toBe(true);
  });

  it('is not signed in for any other state, or a harness the scan does not have', () => {
    expect(scanSignedIn(scan(), 'codex')).toBe(false);
    expect(scanSignedIn(withCodex({ account: { state: 'unreadable' } }), 'codex')).toBe(false);
    expect(scanSignedIn(withCodex({ account: { state: 'not-shareable' } }), 'codex')).toBe(false);
    expect(scanSignedIn(scan({ harnesses: [] }), 'claude')).toBe(false);
  });
});

const DUPLICATED = scan({
  runtimes: [{ harness: 'codex', name: 'codex-default', profile: 'default' }],
  duplicates: [{ harness: 'claude', existing: 'claude-work', suggested: 'claude-default-2' }],
});

describe('runtimePlan', () => {
  it('plans the runtime the scan says the import makes', () => {
    expect(runtimePlan(scan(), 'claude')).toEqual({ kind: 'new', suggested: 'claude-default' });
    expect(runtimePlan(scan(), 'codex')).toEqual({ kind: 'new', suggested: 'codex-default' });
  });

  it('plans a duplicate with the runtime it matches and the name offered instead (E15)', () => {
    expect(runtimePlan(DUPLICATED, 'claude')).toEqual({
      kind: 'duplicate',
      existing: 'claude-work',
      suggested: 'claude-default-2',
    });
    expect(runtimePlan(DUPLICATED, 'codex')).toEqual({ kind: 'new', suggested: 'codex-default' });
  });

  it('plans nothing when the scan names neither a runtime nor a duplicate', () => {
    expect(runtimePlan(scan({ runtimes: [], duplicates: [] }), 'claude')).toEqual({ kind: 'none' });
  });
});

const NEW: RuntimePlan = { kind: 'new', suggested: 'claude-default' };
const DUPLICATE: RuntimePlan = { kind: 'duplicate', existing: 'claude-work', suggested: 'claude-default-2' };
const NONE: RuntimePlan = { kind: 'none' };
const NO_ANSWERS: HarnessAnswers = {};

describe('makesRuntime', () => {
  it('always makes a new runtime', () => {
    expect(makesRuntime(NEW, NO_ANSWERS)).toBe(true);
    expect(makesRuntime(NEW, { addAnother: false })).toBe(true);
  });

  it('makes a duplicate only when it was ticked (E15)', () => {
    expect(makesRuntime(DUPLICATE, NO_ANSWERS)).toBe(false);
    expect(makesRuntime(DUPLICATE, { addAnother: false })).toBe(false);
    expect(makesRuntime(DUPLICATE, { addAnother: true })).toBe(true);
  });

  it('makes nothing when there is no plan, whatever was ticked', () => {
    expect(makesRuntime(NONE, NO_ANSWERS)).toBe(false);
    expect(makesRuntime(NONE, { addAnother: true })).toBe(false);
  });
});

describe('runtimeName', () => {
  it('is the daemon’s suggestion until a name is typed', () => {
    expect(runtimeName(NEW, NO_ANSWERS)).toBe('claude-default');
    expect(runtimeName(DUPLICATE, NO_ANSWERS)).toBe('claude-default-2');
  });

  it('is what was typed, even an empty field', () => {
    expect(runtimeName(NEW, { name: 'work' })).toBe('work');
    expect(runtimeName(NEW, { name: '' })).toBe('');
  });

  it('is empty when there is no plan and nothing was typed', () => {
    expect(runtimeName(NONE, NO_ANSWERS)).toBe('');
    expect(runtimeName(NONE, { name: 'x' })).toBe('x');
  });
});

describe('importButtonLabel', () => {
  it('names the runtime the import creates', () => {
    expect(importButtonLabel(NEW, NO_ANSWERS, true)).toBe('Import and create claude-default');
    expect(importButtonLabel(NEW, { name: 'work' }, true)).toBe('Import and create work');
    expect(importButtonLabel(DUPLICATE, { addAnother: true }, true)).toBe('Import and create claude-default-2');
  });

  it('is a plain Import when no runtime is made', () => {
    expect(importButtonLabel(DUPLICATE, NO_ANSWERS, true)).toBe('Import');
    expect(importButtonLabel(NONE, NO_ANSWERS, true)).toBe('Import');
  });

  it('offers to sign in later when the login is not signed in (E4)', () => {
    expect(importButtonLabel(NEW, NO_ANSWERS, false)).toBe('Import and create claude-default, sign in later');
    expect(importButtonLabel(NONE, NO_ANSWERS, false)).toBe('Import, sign in later');
  });
});

describe('harnessImportChange', () => {
  it('imports this CLI alone and names the runtime it makes', () => {
    expect(harnessImportChange('claude', NEW, NO_ANSWERS)).toEqual({
      kind: 'setup.import',
      include: ['claude'],
      names: { claude: 'claude-default' },
    });
  });

  it('sends the name the person typed', () => {
    expect(harnessImportChange('codex', { kind: 'new', suggested: 'codex-default' }, { name: 'codex-work' })).toEqual({
      kind: 'setup.import',
      include: ['codex'],
      names: { codex: 'codex-work' },
    });
  });

  it('sends no names when the import makes no runtime', () => {
    const change = harnessImportChange('claude', NONE, NO_ANSWERS);
    expect(change).toEqual({ kind: 'setup.import', include: ['claude'] });
    expect('names' in change).toBe(false);
    const skipped = harnessImportChange('claude', DUPLICATE, NO_ANSWERS);
    expect(skipped).toEqual({ kind: 'setup.import', include: ['claude'] });
    expect('addDuplicates' in skipped).toBe(false);
  });

  it('sends the updates the person ticked, and only then (O6)', () => {
    expect(harnessImportChange('claude', NEW, { accepted: ['mcp/github'] })).toEqual({
      kind: 'setup.import',
      include: ['claude'],
      names: { claude: 'claude-default' },
      acceptedUpdates: ['mcp/github'],
    });
    expect('acceptedUpdates' in harnessImportChange('claude', NEW, { accepted: [] })).toBe(false);
  });

  it('asks for duplicates when a ticked duplicate is made (E15)', () => {
    expect(harnessImportChange('claude', DUPLICATE, { addAnother: true })).toEqual({
      kind: 'setup.import',
      include: ['claude'],
      names: { claude: 'claude-default-2' },
      addDuplicates: true,
    });
    expect('addDuplicates' in harnessImportChange('claude', NEW, NO_ANSWERS)).toBe(false);
  });
});
