import { describe, expect, it } from 'bun:test';
import type { FleetHarnessScan, FleetSetupScan } from '@ferretry/protocol';
import {
  cardMakes,
  cardName,
  createLabel,
  FIRST_RUN_FLOW_KIND,
  type FirstRunAnswers,
  firstRunSteps,
  foundRows,
  freeName,
  harnessProblems,
  importChange,
  importLabel,
  importNotes,
  importsAnything,
  includedHarnesses,
  missingTools,
  type NameCard,
  NO_ANSWERS,
  nameCards,
  nameProblem,
  nameProblems,
  offersSignIn,
  scanHasHarness,
  sendsImport,
  updateDetail,
  updateTitle,
} from '../../../../../src/features/fleet/setup/first-run-model.ts';
import { NOTHING_INSTALLED, scan } from './setup-support.ts';

const answers = (overrides: Partial<FirstRunAnswers> = {}): FirstRunAnswers => ({ ...NO_ANSWERS, ...overrides });

const BOTH_IMPORTED = answers({ choices: { claude: 'import', codex: 'import' } });

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

const ids = (steps: readonly { readonly id: string }[]) => steps.map(step => step.id);

describe('the flow', () => {
  it('has a stable kind', () => {
    expect(FIRST_RUN_FLOW_KIND).toBe('first-run');
  });
});

describe('what is installed and chosen', () => {
  it('knows which harnesses the scan saw installed', () => {
    expect(scanHasHarness(scan(), 'claude')).toBe(true);
    expect(scanHasHarness(NOTHING_INSTALLED, 'claude')).toBe(false);
    expect(scanHasHarness(scan({ harnesses: [] }), 'codex')).toBe(false);
  });

  it('includes only harnesses that were chosen to import and are installed', () => {
    expect(includedHarnesses(scan(), NO_ANSWERS)).toEqual([]);
    expect(includedHarnesses(scan(), answers({ choices: { claude: 'skip', codex: 'import' } }))).toEqual(['codex']);
    expect(includedHarnesses(scan(), BOTH_IMPORTED)).toEqual(['claude', 'codex']);
    expect(includedHarnesses(NOTHING_INSTALLED, BOTH_IMPORTED)).toEqual([]);
  });

  it('imports anything when a harness is included or an update is accepted', () => {
    expect(importsAnything(scan(), NO_ANSWERS)).toBe(false);
    expect(importsAnything(scan(), BOTH_IMPORTED)).toBe(true);
    expect(importsAnything(scan(), answers({ accepted: ['mcp/github'] }))).toBe(true);
  });
});

describe('firstRunSteps', () => {
  it('starts with Check tools in setup mode and never in import mode', () => {
    expect(ids(firstRunSteps('setup', scan(), NO_ANSWERS))).toEqual(['tools', 'claude', 'codex', 'done']);
    expect(ids(firstRunSteps('import', scan(), NO_ANSWERS))).toEqual(['claude', 'codex', 'done']);
  });

  it('labels the steps in words and marks Done final', () => {
    const steps = firstRunSteps('setup', scan(), BOTH_IMPORTED);
    expect(steps.map(step => step.label)).toEqual(['Check tools', 'Claude Code', 'Codex', 'Name runtimes', 'Done']);
    expect(steps.filter(step => step.final === true).map(step => step.id)).toEqual(['done']);
  });

  it('adds the Name step only when something is imported', () => {
    expect(ids(firstRunSteps('setup', scan(), NO_ANSWERS))).not.toContain('names');
    expect(ids(firstRunSteps('setup', scan(), answers({ choices: { claude: 'skip', codex: 'skip' } })))).not.toContain(
      'names',
    );
    expect(ids(firstRunSteps('setup', scan(), answers({ choices: { codex: 'import' } })))).toContain('names');
  });

  it('adds the updates step only when the scan offers updates', () => {
    const updates = scan({ updates: [{ reference: 'mcp/github', sources: ['/home/you/.claude/settings.json'] }] });
    expect(ids(firstRunSteps('import', updates, answers({ choices: { claude: 'import' } })))).toEqual([
      'claude',
      'codex',
      'updates',
      'names',
      'done',
    ]);
    expect(ids(firstRunSteps('import', scan(), NO_ANSWERS))).not.toContain('updates');
  });

  it('adds neither optional step before the scan has arrived', () => {
    expect(ids(firstRunSteps('setup', null, BOTH_IMPORTED))).toEqual(['tools', 'claude', 'codex', 'done']);
  });
});

describe('sendsImport', () => {
  const steps = firstRunSteps('setup', scan(), BOTH_IMPORTED);

  it('sends from the last step before Done when there is something to send', () => {
    expect(sendsImport(steps, 'names', true)).toBe(true);
  });

  it('sends nothing from any other step', () => {
    expect(sendsImport(steps, 'codex', true)).toBe(false);
    expect(sendsImport(steps, 'done', true)).toBe(false);
  });

  it('sends nothing when there is nothing to send', () => {
    expect(sendsImport(steps, 'names', false)).toBe(false);
  });

  it('sends nothing from a flow too short to have a step before Done', () => {
    expect(sendsImport([{ id: 'done', label: 'Done', final: true }], 'done', true)).toBe(false);
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

describe('importLabel', () => {
  it('offers a plain import for a login that is usable', () => {
    expect(importLabel(scan(), 'claude')).toBe('Import');
    expect(importLabel(withCodex({ account: { state: 'refresh-due' } }), 'codex')).toBe('Import');
  });

  it('offers to sign in later for every other state (E4)', () => {
    expect(importLabel(scan(), 'codex')).toBe('Import, sign in later');
    expect(importLabel(withCodex({ account: { state: 'unreadable' } }), 'codex')).toBe('Import, sign in later');
    expect(importLabel(withCodex({ account: { state: 'not-shareable' } }), 'codex')).toBe('Import, sign in later');
  });

  it('offers to sign in later when the harness was not scanned', () => {
    expect(importLabel(scan({ harnesses: [] }), 'claude')).toBe('Import, sign in later');
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

describe('nameCards', () => {
  it('makes no cards when nothing is imported', () => {
    expect(nameCards(scan(), NO_ANSWERS)).toEqual([]);
  });

  it('makes one card per imported harness with the suggested runtime name', () => {
    expect(nameCards(scan(), BOTH_IMPORTED)).toEqual([
      { harness: 'claude', suggested: 'claude-default' },
      { harness: 'codex', suggested: 'codex-default' },
    ]);
    expect(nameCards(scan(), answers({ choices: { codex: 'import' } }))).toEqual([
      { harness: 'codex', suggested: 'codex-default' },
    ]);
  });

  it('marks a card that duplicates an existing runtime, with the suggestion and the runtime it matches (E15)', () => {
    const duplicated = scan({
      runtimes: [{ harness: 'codex', name: 'codex-default', profile: 'default' }],
      duplicates: [{ harness: 'claude', existing: 'claude-work', suggested: 'claude-default' }],
    });
    expect(nameCards(duplicated, BOTH_IMPORTED)).toEqual([
      { harness: 'claude', suggested: 'claude-default', duplicate: 'claude-work' },
      { harness: 'codex', suggested: 'codex-default' },
    ]);
  });

  it('makes no card for an imported harness that has neither a runtime nor a duplicate', () => {
    expect(nameCards(scan({ runtimes: [], duplicates: [] }), BOTH_IMPORTED)).toEqual([]);
  });
});

describe('cardMakes and cardName', () => {
  const plain: NameCard = { harness: 'claude', suggested: 'claude-default' };
  const duplicate: NameCard = { harness: 'codex', suggested: 'codex-2', duplicate: 'codex-default' };

  it('makes a plain card by default and a duplicate card never by default (E15)', () => {
    expect(cardMakes(plain, NO_ANSWERS)).toBe(true);
    expect(cardMakes(duplicate, NO_ANSWERS)).toBe(false);
  });

  it('follows the tick the person made', () => {
    expect(cardMakes(plain, answers({ make: { claude: false } }))).toBe(false);
    expect(cardMakes(duplicate, answers({ make: { codex: true } }))).toBe(true);
  });

  it('uses the suggestion until a name is typed', () => {
    expect(cardName(plain, NO_ANSWERS)).toBe('claude-default');
    expect(cardName(plain, answers({ names: { claude: 'mine' } }))).toBe('mine');
  });
});

describe('freeName', () => {
  it('keeps a free name', () => {
    expect(freeName('claude', new Set())).toBe('claude');
  });

  it('counts up from -2 until the name is free', () => {
    expect(freeName('claude', new Set(['claude']))).toBe('claude-2');
    expect(freeName('claude', new Set(['claude', 'claude-2', 'claude-3']))).toBe('claude-4');
  });
});

describe('nameProblem', () => {
  const taken = new Set(['studio', 'studio-2']);

  it('accepts a good, free name', () => {
    expect(nameProblem('work', taken, ['other'], 'studio-mac')).toBeNull();
    expect(nameProblem('a', taken, [], 'studio-mac')).toBeNull();
    expect(nameProblem('a-b-9', taken, [], 'studio-mac')).toBeNull();
    expect(nameProblem('a'.repeat(64), taken, [], 'studio-mac')).toBeNull();
  });

  it('asks for a name when it is empty', () => {
    expect(nameProblem('', taken, [], 'studio-mac')).toEqual({ message: 'Give the runtime a name.' });
  });

  it('refuses bad grammar and suggests a free slug', () => {
    expect(nameProblem('My Work!', taken, [], 'studio-mac')).toEqual({
      message: 'Use only letters, digits and dashes.',
      suggestion: 'my-work',
    });
    expect(nameProblem('-bad-', taken, [], 'studio-mac')?.suggestion).toBe('bad');
    expect(nameProblem('Studio?', taken, [], 'studio-mac')?.suggestion).toBe('studio-3');
  });

  it('suggests a plain word when nothing of the name is usable', () => {
    expect(nameProblem('!!!', taken, [], 'studio-mac')?.suggestion).toBe('runtime');
  });

  it('refuses a name that is too long', () => {
    const problem = nameProblem('a'.repeat(65), taken, [], 'studio-mac');
    expect(problem?.message).toBe('Use only letters, digits and dashes.');
    expect(problem?.suggestion).toBe('a'.repeat(65));
  });

  it('refuses a name already on the machine and suggests the next free one with -2', () => {
    expect(nameProblem('claude', new Set(['claude']), [], 'studio-mac')).toEqual({
      message: 'claude is already a runtime on studio-mac.',
      suggestion: 'claude-2',
    });
    expect(nameProblem('studio', taken, [], 'studio-mac')?.suggestion).toBe('studio-3');
  });

  it('avoids a name another card is about to use when suggesting', () => {
    expect(nameProblem('claude', new Set(['claude']), ['claude-2'], 'studio-mac')?.suggestion).toBe('claude-3');
  });

  it('refuses two cards with the same name', () => {
    expect(nameProblem('same', taken, ['same'], 'studio-mac')).toEqual({
      message: 'Both runtimes have this name.',
      suggestion: 'same-2',
    });
  });
});

describe('nameProblems', () => {
  const cards = nameCards(scan(), BOTH_IMPORTED);
  const machine = 'studio-mac';

  it('is empty when every name is good', () => {
    expect(nameProblems(cards, BOTH_IMPORTED, new Set(), machine)).toEqual({});
  });

  it('reports an empty name on its card', () => {
    const typed = answers({ ...BOTH_IMPORTED, names: { claude: '' } });
    expect(nameProblems(cards, typed, new Set(), machine)).toEqual({ claude: { message: 'Give the runtime a name.' } });
  });

  it('reports bad grammar with a slug suggestion', () => {
    const typed = answers({ ...BOTH_IMPORTED, names: { codex: 'My Codex' } });
    expect(nameProblems(cards, typed, new Set(), machine)).toEqual({
      codex: { message: 'Use only letters, digits and dashes.', suggestion: 'my-codex' },
    });
  });

  it('reports a clash with a runtime already on the machine, suggesting -2', () => {
    expect(nameProblems(cards, BOTH_IMPORTED, new Set(['claude-default']), machine)).toEqual({
      claude: { message: 'claude-default is already a runtime on studio-mac.', suggestion: 'claude-default-2' },
    });
  });

  it('reports both cards when they have the same name', () => {
    const typed = answers({ ...BOTH_IMPORTED, names: { claude: 'same', codex: 'same' } });
    expect(nameProblems(cards, typed, new Set(), machine)).toEqual({
      claude: { message: 'Both runtimes have this name.', suggestion: 'same-2' },
      codex: { message: 'Both runtimes have this name.', suggestion: 'same-2' },
    });
  });

  it('ignores a card that will not be made', () => {
    const typed = answers({ ...BOTH_IMPORTED, names: { claude: 'same', codex: 'same' }, make: { codex: false } });
    expect(nameProblems(cards, typed, new Set(), machine)).toEqual({});
  });
});

describe('createLabel', () => {
  const cards = nameCards(scan(), BOTH_IMPORTED);

  it('counts the runtimes that will be made', () => {
    expect(createLabel(cards, BOTH_IMPORTED)).toBe('Create 2 runtimes');
    expect(createLabel(cards, answers({ ...BOTH_IMPORTED, make: { codex: false } }))).toBe('Create 1 runtime');
  });

  it('offers an import without runtimes when none will be made', () => {
    expect(createLabel(cards, answers({ ...BOTH_IMPORTED, make: { claude: false, codex: false } }))).toBe(
      'Import without runtimes',
    );
    expect(createLabel([], NO_ANSWERS)).toBe('Import without runtimes');
  });
});

describe('importChange', () => {
  it('includes the harnesses chosen and names the runtimes made', () => {
    expect(importChange(scan(), BOTH_IMPORTED)).toEqual({
      kind: 'setup.import',
      include: ['claude', 'codex'],
      names: { claude: 'claude-default', codex: 'codex-default' },
    });
  });

  it('sends the name the person typed', () => {
    expect(importChange(scan(), answers({ ...BOTH_IMPORTED, names: { claude: 'work' } }))).toMatchObject({
      names: { claude: 'work', codex: 'codex-default' },
    });
  });

  it('sends no names when no card makes a runtime', () => {
    const change = importChange(scan(), answers({ ...BOTH_IMPORTED, make: { claude: false, codex: false } }));
    expect(change).toEqual({ kind: 'setup.import', include: ['claude', 'codex'] });
    expect('names' in change).toBe(false);
  });

  it('sends the updates the person accepted, and only then', () => {
    expect(importChange(scan(), answers({ accepted: ['mcp/github'] }))).toEqual({
      kind: 'setup.import',
      include: [],
      acceptedUpdates: ['mcp/github'],
    });
    expect('acceptedUpdates' in importChange(scan(), BOTH_IMPORTED)).toBe(false);
  });

  it('adds duplicates when a ticked card duplicates a runtime (E15)', () => {
    const duplicated = scan({
      runtimes: [{ harness: 'codex', name: 'codex-default', profile: 'default' }],
      duplicates: [{ harness: 'claude', existing: 'claude-work', suggested: 'claude-2' }],
    });
    const change = importChange(duplicated, answers({ ...BOTH_IMPORTED, make: { claude: true } }));
    expect(change).toEqual({
      kind: 'setup.import',
      include: ['claude', 'codex'],
      names: { claude: 'claude-2', codex: 'codex-default' },
      addDuplicates: true,
    });
  });

  it('leaves a duplicate out by default and does not ask for duplicates', () => {
    const duplicated = scan({
      runtimes: [{ harness: 'codex', name: 'codex-default', profile: 'default' }],
      duplicates: [{ harness: 'claude', existing: 'claude-work', suggested: 'claude-2' }],
    });
    const change = importChange(duplicated, BOTH_IMPORTED);
    expect(change).toEqual({ kind: 'setup.import', include: ['claude', 'codex'], names: { codex: 'codex-default' } });
    expect('addDuplicates' in change).toBe(false);
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
