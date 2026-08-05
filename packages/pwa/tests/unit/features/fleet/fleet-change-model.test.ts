import { describe, expect, it } from 'bun:test';

import { fleetAssetRefProblem } from '@ferretry/protocol';
import type { FleetRefusalKind } from '../../../../src/features/fleet/fleet-api.ts';
import {
  accountProblems,
  approvalCommand,
  assetPathProblem,
  CHANGE_LIMITS,
  classifyInventory,
  createAccountProposal,
  currentUnreadable,
  declaredLayer,
  derivedWrapper,
  draftModels,
  editAccountProposal,
  emptyAccountDraft,
  emptyLayerDraft,
  type FleetAccountDraft,
  type FleetLayerDraft,
  fleetAuthority,
  harnessEvidence,
  initializeProposal,
  layerDraftFrom,
  layerProblems,
  mayComposeChange,
  mayInitialize,
  operationLedger,
  outcomeSummary,
  rosterDiff,
  selectLayerAssets,
  unreadableAssetProblems,
  unseenAssets,
} from '../../../../src/features/fleet/fleet-change-model.ts';
import { defaultFleetHarness } from '../../../../src/features/fleet/fleet-model.ts';
import {
  account,
  accountId,
  assetIndex,
  config,
  type FleetAccountFixture,
  manifest,
  permissions,
} from './fleet-support.ts';

const CONTROL = String.fromCodePoint(1);

const refused = (kind: FleetRefusalKind, detail = 'the daemon said so') => ({
  ok: false as const,
  refusal: { kind, detail },
});
const observed = <T>(value: T) => ({ ok: true as const, value });

const liveManifest = manifest();
const declared = config();

describe('what a daemon fleet read means', () => {
  it('renders a published manifest as live, including one with no accounts in it', () => {
    expect(classifyInventory(observed(liveManifest), observed(declared))).toEqual({
      kind: 'live',
      manifest: liveManifest,
    });
    const empty = manifest([]);
    const inventory = classifyInventory(observed(empty), observed(declared));
    expect(inventory.kind).toBe('live');
    expect(inventory.kind === 'live' ? inventory.manifest.accounts : ['not empty']).toHaveLength(0);
  });

  it('keeps a first run, an unpublished fleet and a damaged one as three different states', () => {
    expect(classifyInventory(refused('not-applied'), refused('config-missing', 'no fleet config at /x')).kind).toBe(
      'uninitialized',
    );
    expect(classifyInventory(refused('not-applied'), observed(declared)).kind).toBe('not-applied');
    expect(classifyInventory(refused('not-applied'), refused('config-invalid', 'bad yaml')).kind).toBe('damaged');
    expect(classifyInventory(refused('manifest-invalid'), observed(declared)).kind).toBe('damaged');
  });

  it('never turns a refusal or an unanswered read into an empty fleet', () => {
    const forbidden = classifyInventory(refused('forbidden', 'nope'), refused('forbidden', 'nope'));
    const unreachable = classifyInventory(refused('unreachable', 'gone'), refused('unreachable', 'gone'));
    expect([forbidden.kind, unreachable.kind]).toEqual(['forbidden', 'unreachable']);
    for (const inventory of [forbidden, unreachable]) {
      expect(inventory.kind === 'live').toBe(false);
    }
  });

  it('lets a change be composed only from a configuration that exists and parses', () => {
    expect(mayComposeChange({ kind: 'live', manifest: liveManifest })).toBe(true);
    expect(mayComposeChange({ kind: 'not-applied', detail: '' })).toBe(true);
    expect(mayComposeChange({ kind: 'uninitialized', detail: '' })).toBe(false);
    expect(mayInitialize({ kind: 'uninitialized', detail: '' })).toBe(true);
    expect(mayInitialize({ kind: 'damaged', detail: '' })).toBe(false);
  });
});

describe('authority', () => {
  it('reads direct, approval and read-only from the daemon rather than assuming one', () => {
    expect(fleetAuthority(null)).toBe('read-only');
    expect(fleetAuthority({ ...permissions({ mayApplyDirectly: true }) })).toBe('direct');
    expect(fleetAuthority(permissions())).toBe('approval');
    expect(fleetAuthority(permissions({ mayApplyWithApproval: false }))).toBe('read-only');
  });

  it('binds the approval command to one exact proposal id', () => {
    expect(approvalCommand(permissions(), 'fy_fprop_ABC')).toBe('fy fleet authorize fy_fprop_ABC');
  });
});

describe('the operation ledger', () => {
  it('numbers every operation family from one and names it in plain language', () => {
    const ledger = operationLedger([
      { kind: 'directory', path: '/a' },
      { kind: 'file', path: '/b', mode: 493 },
      { kind: 'copy', path: '/c', source: '/assets/c' },
      { kind: 'symlink', path: '/d', source: '/pool/d' },
      { kind: 'settings', path: '/e', format: 'json', mode: 384, preserveExisting: true, layerCount: 1 },
      { kind: 'codex-sqlite-ownership', path: '/f', markerPath: '/f.marker', sqliteHome: '/pool', enabled: true },
      { kind: 'prune', path: '/g', marker: 'ferretry-managed', keep: [] },
    ]);
    expect(ledger.map(entry => entry.index)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(ledger.map(entry => entry.action)).toEqual([
      'create directory',
      'write file',
      'copy asset',
      'link',
      'merge settings',
      'take codex history ownership',
      'remove unclaimed wrappers',
    ]);
    expect(ledger[2]?.source).toBe('/assets/c');
    expect(ledger[0]?.source).toBeUndefined();
    expect(operationLedger([])).toHaveLength(0);
  });

  it('states every operator-relevant field, not just the path it touches', () => {
    const ledger = operationLedger([
      { kind: 'directory', path: '/homes/studio', mode: 448 },
      { kind: 'file', path: '/bin/claude-studio', mode: 493 },
      { kind: 'copy', path: '/homes/studio/CLAUDE.md', source: '/assets/studio.md', mode: 420 },
      {
        kind: 'settings',
        path: '/homes/studio/settings.json',
        format: 'json',
        layerCount: 3,
        preserveExisting: true,
        mode: 384,
      },
      { kind: 'prune', path: '/bin', marker: 'ferretry-managed', keep: ['claude-studio', 'codex-archive'] },
      {
        kind: 'codex-sqlite-ownership',
        path: '/homes/codex/config.toml',
        markerPath: '/homes/codex/.fy-sqlite-owner',
        sqliteHome: '/fleet/shared/codex/sqlite',
        enabled: true,
      },
    ]);
    expect(ledger[0]?.details).toEqual(['mode 0700']);
    expect(ledger[1]?.details).toEqual(['mode 0755']);
    expect(ledger[2]?.details).toEqual(['mode 0644']);
    expect(ledger[3]?.details).toEqual([
      'mode 0600',
      'format json',
      '3 settings layers',
      'folds in the file already there',
    ]);
    expect(ledger[4]?.details).toEqual([
      'removes only files carrying Ferretry’s marker',
      'keeps claude-studio, codex-archive',
    ]);
    expect(ledger[5]?.details).toEqual([
      'takes ownership of the sidecar',
      'marker /homes/codex/.fy-sqlite-owner',
      'sqlite home /fleet/shared/codex/sqlite',
    ]);
  });

  it('says when a settings write replaces the file, when a prune spares nothing, and when the sidecar goes back', () => {
    const ledger = operationLedger([
      { kind: 'settings', path: '/s.json', format: 'toml', mode: 384, layerCount: 1, preserveExisting: false },
      { kind: 'prune', path: '/bin', marker: 'ferretry-managed', keep: [] },
      { kind: 'codex-sqlite-ownership', path: '/c.toml', markerPath: '/m', sqliteHome: '/pool', enabled: false },
    ]);
    expect(ledger[0]?.details).toEqual([
      'mode 0600',
      'format toml',
      '1 settings layer',
      'replaces the file already there',
    ]);
    expect(ledger[1]?.details).toEqual(['removes only files carrying Ferretry’s marker', 'keeps nothing']);
    expect(ledger[2]?.details).toEqual(['gives the sidecar back', 'marker /m', 'sqlite home /pool']);
  });
});

describe('harness evidence', () => {
  it('offers a suggestion only from accounts a daemon actually published', () => {
    expect(harnessEvidence([])).toHaveLength(0);
    expect(defaultFleetHarness(harnessEvidence([]))).toBeUndefined();

    const evidence = harnessEvidence([
      account(),
      account({ id: accountId(2), kind: 'codex', wrapper: 'codex-studio' }),
      account({
        id: accountId(3),
        kind: 'codex',
        wrapper: 'codex-broken',
        available: false,
        unavailableReason: 'no wrapper',
      }),
    ]);
    expect(evidence.map(entry => entry.kind)).toEqual(['claude', 'codex']);
    expect(evidence[1]?.launchable).toEqual(['codex-studio']);
    expect(evidence[1]?.blocked).toEqual(['codex-broken: no wrapper']);
    // The policy itself stays in defaultFleetHarness; this only feeds it.
    expect(defaultFleetHarness(evidence)).toBe('claude');
  });

  it('suggests codex when codex is the only harness with a published wrapper', () => {
    const evidence = harnessEvidence([account({ kind: 'codex', wrapper: 'codex-solo' })]);
    expect(defaultFleetHarness(evidence)).toBe('codex');
  });
});

describe('live host versus proposed host', () => {
  it('marks each row added, changed, unchanged or removed', () => {
    const kept = account();
    const edited = account({ id: accountId(6), wrapper: 'claude-edit', displayName: 'Before' });
    const dropped = account({ id: accountId(5), wrapper: 'claude-drop' });
    const rows = rosterDiff(
      [kept, edited, dropped],
      [kept, { ...edited, displayName: 'After' }, account({ id: accountId(4), wrapper: 'claude-new' })],
    );
    expect(rows.map(row => [row.id, row.change])).toEqual([
      [kept.id, 'unchanged'],
      [accountId(6), 'changed'],
      [accountId(4), 'added'],
      [accountId(5), 'removed'],
    ]);
  });

  it('notices a change in what an account can serve, in either the list or one entry', () => {
    const before = account({ models: [{ id: 'opus', available: true }] });
    const added = account({
      models: [
        { id: 'opus', available: true },
        { id: 'sonnet', available: true },
      ],
    });
    // An unavailable model must say why: the shared schema makes the reason part of the shape.
    const withdrawn = account({ models: [{ id: 'opus', available: false, unavailableReason: 'withdrawn' }] });
    const reordered = account({
      models: [
        { id: 'sonnet', available: true },
        { id: 'opus', available: true },
      ],
    });
    expect(rosterDiff([before], [added])[0]?.change).toBe('changed');
    expect(rosterDiff([before], [withdrawn])[0]?.change).toBe('changed');
    expect(rosterDiff([added], [reordered])[0]?.change).toBe('changed');
  });

  it('calls two accounts equal even when two schemas emitted their fields in a different order', () => {
    const declared = account();
    // Same account, every key in a different order — which is what two zod schemas routinely produce.
    const reordered: FleetAccountFixture = {
      models: declared.models.map(model => ({
        available: model.available,
        id: model.id,
      })) as FleetAccountFixture['models'],
      unavailableReason: declared.unavailableReason,
      available: declared.available,
      defaultModel: declared.defaultModel,
      displayName: declared.displayName,
      home: declared.home,
      wrapper: declared.wrapper,
      mode: declared.mode,
      kind: declared.kind,
      id: declared.id,
    };
    expect(rosterDiff([declared], [reordered])).toEqual([{ id: declared.id, change: 'unchanged', account: reordered }]);
  });
});

describe('what an apply did to the host', () => {
  it('says the fleet DID land when only shared history failed', () => {
    const summary = outcomeSummary({
      outcome: 'committed-with-history-failure',
      failedHarness: 'claude',
      reason: 'pool not writable',
      committed: {
        accountCount: 2,
        operationCount: 9,
        manifestPath: '/m',
        manifest: liveManifest,
        prunedWrappers: [],
        sharedHistory: [],
      },
    });
    expect(summary.tone).toBe('warn');
    expect(summary.hostState).toContain('The fleet DID land');
    expect(summary.hostState).toContain('Do not re-apply');
  });

  it('separates a verified rollback from an unverified one', () => {
    const back = outcomeSummary({ outcome: 'rolled-back', failedOperation: 'file /bin/x', reason: 'denied' });
    expect(back.tone).toBe('warn');
    expect(back.hostState).toContain('still carries the configuration');

    const partial = outcomeSummary({
      outcome: 'rollback-incomplete',
      failedOperation: 'settings /x',
      reason: 'disk full',
      unrestored: [{ path: '/x', reason: 'rename failed' }],
    });
    expect(partial.tone).toBe('err');
    expect(partial.hostState).toContain('1 path(s) could not be verified');
  });

  it('reports preparing a host as its own state, not as an apply that published nothing', () => {
    const ready = outcomeSummary({
      outcome: 'initialized',
      created: ['/fleet/config.yaml'],
      kept: ['/fleet/assets/shared.md'],
      directories: ['/fleet', '/fleet/bin'],
      pathEntry: 'export PATH="$HOME/.ferretry/fleet/bin:$PATH"',
    });
    expect(ready).toEqual({
      tone: 'ok',
      title: 'Host prepared',
      hostState:
        'Created 1 file(s) and kept 1 that already existed. NO fleet manifest has been published yet — declare the accounts you want and apply that change to publish one.',
    });

    const partial = outcomeSummary({
      outcome: 'initialization-partial',
      reason: 'permission denied',
      failedPath: '/fleet/bin/.keep',
      created: ['/fleet/config.yaml'],
      kept: [],
      directories: ['/fleet'],
    });
    expect(partial.tone).toBe('warn');
    expect(partial.title).toBe('Host partly prepared');
    expect(partial.hostState).toContain('stopped at /fleet/bin/.keep');
    expect(partial.hostState).toContain('running it again is safe');
  });

  it('reports a plain success with what was published', () => {
    const done = outcomeSummary({
      outcome: 'committed',
      result: { accountCount: 3, operationCount: 12, manifestPath: '/m', prunedWrappers: [], sharedHistory: [] },
    });
    expect(done).toEqual({
      tone: 'ok',
      title: 'Applied',
      hostState: 'The host published 3 account(s) from 12 operation(s).',
    });
  });
});

describe('drafts', () => {
  it('starts empty and derives the wrapper the daemon will derive', () => {
    expect(emptyLayerDraft()).toEqual({
      instructions: { path: '', text: '' },
      skillsDirectory: '',
      skills: [],
      settingsText: '',
      env: [],
      preserved: {},
    });
    const draft = emptyAccountDraft('codex');
    expect(draft.harness).toBe('codex');
    expect(draft.variant).toBe('default');
    expect(derivedWrapper({ ...draft, name: 'studio' })).toBe('codex-studio');
    expect(derivedWrapper({ ...draft, name: 'studio', variant: 'auto' })).toBe('codex-auto-studio');
  });

  it('accepts models one per line or comma separated', () => {
    expect(draftModels(' opus \n sonnet,haiku \n\n')).toEqual(['opus', 'sonnet', 'haiku']);
    expect(draftModels('')).toHaveLength(0);
  });

  it('seeds a draft from the layer an account already declares', () => {
    expect(layerDraftFrom(undefined)).toEqual(emptyLayerDraft());
    const draft = layerDraftFrom({
      memory: 'instructions/studio.md',
      skills: 'skills/studio',
      settings: { model: 'opus' },
      env: { FY_LANE: 'studio', FY_COUNT: 3 },
    });
    expect(draft.instructions).toEqual({ path: 'instructions/studio.md', text: '' });
    expect(draft.skillsDirectory).toBe('skills/studio');
    expect(JSON.parse(draft.settingsText)).toEqual({ model: 'opus' });
    expect(draft.env).toEqual([
      { id: 'FY_LANE', name: 'FY_LANE', value: 'studio' },
      { id: 'FY_COUNT', name: 'FY_COUNT', value: '3' },
    ]);
  });

  it('preserves every field this editor does not offer, so editing one slot deletes none', () => {
    const declaredLayerValue = {
      memory: 'instructions/studio.md',
      skills: 'skills/studio',
      env: { FY_LANE: 'studio' },
      flags: ['--dangerously-skip-permissions'],
      hooks: 'hooks/studio.json',
      hooksDir: 'hooks/studio',
      mcp: 'mcp/studio.json',
      claude: { settings: { model: 'opus' } },
      codex: { env: { CODEX_LANE: 'studio' } },
    };
    const draft = layerDraftFrom(declaredLayerValue);
    expect(Object.keys(draft.preserved).sort()).toEqual(['claude', 'codex', 'flags', 'hooks', 'hooksDir', 'mcp']);

    // The regression: change ONLY the instructions text. The patch states the four visible concerns
    // and OMITS every field this editor cannot show, which is what makes the daemon keep them.
    const edited = editAccountProposal('abc', {
      ...draft,
      instructions: { path: 'instructions/studio.md', text: '# new' },
    });
    expect(edited.mutation).toEqual({
      kind: 'edit-account',
      accountId: 'abc',
      layer: {
        memory: 'instructions/studio.md',
        skills: 'skills/studio',
        settings: null,
        env: { FY_LANE: 'studio' },
      },
    });
    expect(edited.assetEdits).toEqual([{ path: 'instructions/studio.md', content: '# new' }]);
  });

  it('never sends an opinion about a settings FILE REFERENCE it could not show', () => {
    const draft = layerDraftFrom({ settings: 'settings/shared.json', memory: 'instructions/a.md' });
    expect(draft.settingsText).toBe('');
    expect(draft.preserved).toEqual({ settings: 'settings/shared.json' });
    // `settings` is absent from the patch — not null — so the operator's reference survives.
    expect(editAccountProposal('abc', draft).mutation).toEqual({
      kind: 'edit-account',
      accountId: 'abc',
      layer: { memory: 'instructions/a.md', skills: null, env: null },
    });
  });

  it('removes exactly the one concern a person cleared, and keeps the rest', () => {
    const declaredLayerValue = {
      memory: 'instructions/studio.md',
      skills: 'skills/studio',
      settings: { model: 'opus' },
      env: { FY_LANE: 'studio' },
      flags: ['--skip'],
    };
    const draft = layerDraftFrom(declaredLayerValue);
    const cleared = editAccountProposal('abc', { ...draft, instructions: { path: '', text: '' } });
    expect(cleared.mutation).toEqual({
      kind: 'edit-account',
      accountId: 'abc',
      layer: { memory: null, skills: 'skills/studio', settings: { model: 'opus' }, env: { FY_LANE: 'studio' } },
    });
    // Nothing is written into the asset tree for a file that is no longer declared.
    expect(cleared.assetEdits).toHaveLength(0);
  });

  it('removes all four concerns when all four are cleared, and still does not delete the layer', () => {
    const draft = layerDraftFrom({
      memory: 'instructions/a.md',
      skills: 'skills/a',
      env: { A: '1' },
      flags: ['--skip'],
    });
    const cleared = editAccountProposal('abc', {
      ...draft,
      instructions: { path: '', text: '' },
      skillsDirectory: '',
      settingsText: '',
      env: [],
    });
    expect(cleared.mutation).toEqual({
      kind: 'edit-account',
      accountId: 'abc',
      // Four explicit removals. NOT `layer: null`, which would take `flags` with it.
      layer: { memory: null, skills: null, settings: null, env: null },
    });
  });

  it('leaves a settings FILE REFERENCE alone rather than turning it into a literal', () => {
    const draft = layerDraftFrom({ settings: 'settings/shared.json', memory: 42, skills: ['not a path'] });
    expect(draft.settingsText).toBe('');
    expect(draft.instructions.path).toBe('');
    expect(draft.skillsDirectory).toBe('');
  });

  it('finds the declared layer of one exact route and nothing else', () => {
    const withLayer = config({
      default: { id: 'a', wrapper: 'claude-a', layer: { memory: 'instructions/a.md' } },
      auto: { id: accountId(2), wrapper: 'claude-auto-a' },
    });
    expect(declaredLayer(withLayer, 'a')).toEqual({ memory: 'instructions/a.md' });
    expect(declaredLayer(withLayer, 'b')).toBeUndefined();
    expect(declaredLayer(withLayer, 'missing')).toBeUndefined();
    expect(declaredLayer(null, 'a')).toBeUndefined();
  });
});

describe('the assets one layer references', () => {
  const index = assetIndex;

  it('takes the instructions file and every document under the skills directory, and nothing else', () => {
    const selection = selectLayerAssets(
      index([
        { path: 'instructions/studio.md', bytes: 6, readable: true },
        { path: 'skills/studio/one.md', bytes: 4, readable: true },
        { path: 'skills/studio/nested/two.md', bytes: 4, readable: true },
        { path: 'skills/other/three.md', bytes: 4, readable: true },
        { path: 'instructions/other.md', bytes: 4, readable: true },
      ]),
      'instructions/studio.md',
      'skills/studio',
    );
    expect(selection.readable).toEqual([
      'instructions/studio.md',
      'skills/studio/one.md',
      'skills/studio/nested/two.md',
    ]);
    expect(selection.unreadable).toHaveLength(0);
  });

  it('keeps an unreadable entry with the reason the shared schema makes required', () => {
    const selection = selectLayerAssets(
      index([
        { path: 'skills/a/huge.md', bytes: 999_999, readable: false, reason: 'over the limit' },
        { path: 'skills/a/odd.md', bytes: 3, readable: false, reason: 'not editable text' },
      ]),
      '',
      'skills/a',
    );
    expect(selection.unreadable).toEqual([
      { scope: 'file', path: 'skills/a/huge.md', reason: 'over the limit' },
      { scope: 'file', path: 'skills/a/odd.md', reason: 'not editable text' },
    ]);
  });

  it('treats a truncated walk as a blocker, because what it cut off may be a skill document', () => {
    const truncated = selectLayerAssets(
      index([{ path: 'skills/a/one.md', bytes: 4, readable: true }], false),
      '',
      'skills/a',
    );
    expect(truncated.readable).toEqual(['skills/a/one.md']);
    expect(truncated.unreadable[0]).toEqual({
      scope: 'tree',
      path: 'skills/a',
      reason: 'the daemon stopped walking the asset tree at a bound, so this list is not all of it',
    });

    const noDirectory = selectLayerAssets(index([], false), 'instructions/a.md', '');
    expect(noDirectory.unreadable[0]?.path).toBe('fleet/assets');
  });

  it('drops a file blocker the draft no longer names, and keeps a truncated walk whatever is typed', () => {
    const entries = [
      { scope: 'file' as const, path: 'instructions/huge.md', reason: 'over the limit' },
      { scope: 'file' as const, path: 'skills/a/huge.md', reason: 'over the limit' },
      { scope: 'tree' as const, path: 'skills/a', reason: 'the walk stopped at a bound' },
    ];
    const naming: FleetLayerDraft = {
      ...emptyLayerDraft(),
      instructions: { path: 'instructions/huge.md', text: '' },
      skillsDirectory: 'skills/a',
      skills: [{ id: '1', path: 'skills/a/huge.md', text: '' }],
    };
    expect(currentUnreadable(entries, naming)).toEqual(entries);

    // Clearing the instructions path means `editLayerPatch` sends `memory: null` and `assetEdits`
    // carries nothing for it, so there is no longer anything to overwrite — and nothing to warn about.
    const cleared = currentUnreadable(entries, { ...naming, instructions: { path: '', text: '' } });
    expect(cleared.map(entry => entry.path)).toEqual(['skills/a/huge.md', 'skills/a']);

    // Deleting the skill ROW is not enough while the directory is still declared: the directory hands
    // over contents the browser never saw, and the row was never there to delete in the first place.
    const withoutRow = currentUnreadable(entries, { ...naming, skills: [] });
    expect(withoutRow.map(entry => entry.path)).toEqual(['instructions/huge.md', 'skills/a/huge.md', 'skills/a']);

    // Clearing the DIRECTORY does clear the file blocker under it. The tree entry survives regardless.
    const withoutDirectory = currentUnreadable(entries, { ...naming, skillsDirectory: '', skills: [] });
    expect(withoutDirectory.map(entry => entry.path)).toEqual(['instructions/huge.md', 'skills/a']);

    // And an empty draft still cannot clear the tree entry: an unenumerated directory is not a file
    // anybody can stop naming.
    expect(currentUnreadable(entries, emptyLayerDraft()).map(entry => entry.scope)).toEqual(['tree']);
  });

  it('blocks a path the draft newly names that already exists and was never loaded', () => {
    // The load: `instructions/a.md` was referenced, so only it was read. `b.md` is there, unread.
    const knowledge = {
      listed: ['instructions/a.md', 'instructions/b.md', 'skills/a/one.md'],
      loaded: ['instructions/a.md'],
    };
    const editing: FleetLayerDraft = {
      ...emptyLayerDraft(),
      instructions: { path: 'instructions/a.md', text: 'AAA' },
    };
    expect(unseenAssets(editing, knowledge)).toEqual([]);

    // RED before this existed: retargeting sent `{path: "instructions/b.md", content: "AAA"}` — a.md's
    // text written over a document nobody here has seen.
    const retargeted = { ...editing, instructions: { path: 'instructions/b.md', text: 'AAA' } };
    expect(unseenAssets(retargeted, knowledge)).toEqual([
      {
        scope: 'file',
        path: 'instructions/b.md',
        reason: 'this editor has not loaded the document already at that path',
      },
    ]);
    // And it goes through the SAME filter as a load-time blocker, so it clears itself the moment the
    // draft stops naming that path.
    expect(currentUnreadable(unseenAssets(retargeted, knowledge), editing)).toEqual([]);

    // A new skill row naming an existing document used to send `content: ''` for it.
    const newRow = {
      ...editing,
      skillsDirectory: 'skills/a',
      skills: [{ id: '1', path: 'skills/a/one.md', text: '' }],
    };
    expect(unseenAssets(newRow, knowledge).map(entry => entry.path)).toEqual(['skills/a/one.md']);

    // A path the index does NOT list is a document being created. Nothing to overwrite, so nothing to
    // block: this is the whole reason the check is keyed to the listing rather than to `loaded` alone.
    const creating = { ...editing, instructions: { path: 'instructions/new.md', text: 'NEW' } };
    expect(unseenAssets(creating, knowledge)).toEqual([]);
    // Nor does an empty box count as naming something.
    expect(unseenAssets(emptyLayerDraft(), knowledge)).toEqual([]);
  });

  it('speaks once per path when load-time and draft-time evidence reach the same file', () => {
    const layer: FleetLayerDraft = {
      ...emptyLayerDraft(),
      instructions: { path: 'instructions/huge.md', text: '' },
    };
    const knowledge = { listed: ['instructions/huge.md'], loaded: [] };
    // The index called it unreadable AND the draft names a document this editor never loaded. Both are
    // true; the daemon's own reason is the useful one, and two sentences about one file is noise.
    const spoken = currentUnreadable(
      [
        { scope: 'file' as const, path: 'instructions/huge.md', reason: 'over the limit' },
        ...unseenAssets(layer, knowledge),
      ],
      layer,
    );
    expect(spoken).toEqual([{ scope: 'file', path: 'instructions/huge.md', reason: 'over the limit' }]);
  });

  it('says why an unreadable asset stops a change rather than merely mentioning it', () => {
    expect(unreadableAssetProblems([{ scope: 'file', path: 'skills/a/huge.md', reason: 'over the limit' }])).toEqual([
      '"skills/a/huge.md" could not be read (over the limit), so staging a change would overwrite text this browser never saw',
    ]);
    expect(unreadableAssetProblems([])).toHaveLength(0);
  });
});

describe('the shared asset grammar, labelled for the field it was typed into', () => {
  it('refuses every shape the shared grammar refuses, and accepts a relative one', () => {
    expect(assetPathProblem('instructions/studio.md', 'p')).toBeNull();
    expect(assetPathProblem('x'.repeat(201), 'p')).toContain('longer than 200');
    expect(assetPathProblem('a\\b', 'p')).toContain('"/" separators');
    expect(assetPathProblem('/etc/passwd', 'p')).toContain('relative to the asset directory');
    expect(assetPathProblem('C:/x', 'p')).toContain('relative to the asset directory');
    expect(assetPathProblem(`a${CONTROL}b`, 'p')).toContain('control characters');
    expect(assetPathProblem('a/b/c/d/e/f/g/h/i', 'p')).toContain('deeper than 8');
    expect(assetPathProblem('a//b', 'p')).toContain('empty path segment');
    expect(assetPathProblem('a/./b', 'p')).toContain('path traversal');
    expect(assetPathProblem('../../.ssh/authorized_keys', 'p')).toContain('path traversal');
    expect(assetPathProblem('a/ b', 'p')).toContain('whitespace');
  });

  it('refuses the three shapes the hand-copied grammar used to let through', () => {
    // A home alias is expanded by the fleet, so it leaves the asset tree. The browser used to accept
    // both spellings and let the person find out on submit.
    expect(assetPathProblem('~/notes.md', 'the instructions path')).toBe(
      'the instructions path must be relative to the asset directory, not to a home',
    );
    expect(assetPathProblem('$HOME/notes.md', 'the skills directory')).toBe(
      'the skills directory must be relative to the asset directory, not to a home',
    );
    // A FORMAT control (\p{Cf}) rather than a C0 control: invisible, and it makes a path print as
    // something other than what it opens. The old copy only checked \p{Cc}.
    const formatControl = String.fromCodePoint(0x200e);
    expect(assetPathProblem(`instructions/${formatControl}studio.md`, 'p')).toContain('control characters');
  });

  it('says what a home alias is NOT: only the two spellings the fleet expands', () => {
    // `~kirin/notes` and `$EDITOR/x` are expanded by nobody, so they stay inside the tree and refusing
    // them would be a rule about a danger that is not there. This is the shared grammar's decision, and
    // pinning it here is what tells us if the browser ever drifts from it again.
    expect(assetPathProblem('~kirin/notes.md', 'p')).toBeNull();
    expect(assetPathProblem('$EDITOR/x.md', 'p')).toBeNull();
  });

  it('adds only the label, so the shared reason reaches the screen verbatim', () => {
    const path = '../escape.md';
    expect(assetPathProblem(path, 'the instructions path')).toBe(`the instructions path ${fleetAssetRefProblem(path)}`);
  });
});

describe('layer problems', () => {
  const layer = (overrides: Partial<FleetLayerDraft>): FleetLayerDraft => ({ ...emptyLayerDraft(), ...overrides });

  it('accepts a complete layer and an empty one', () => {
    expect(layerProblems(emptyLayerDraft())).toHaveLength(0);
    expect(
      layerProblems(
        layer({
          instructions: { path: 'instructions/a.md', text: '# hi' },
          skillsDirectory: 'skills/a',
          skills: [{ id: '1', path: 'skills/a/one.md', text: 'x' }],
          settingsText: '{"model":"opus"}',
          env: [{ id: '1', name: 'FY_LANE', value: 'studio' }],
        }),
      ),
    ).toHaveLength(0);
  });

  it('will not write instructions text into a file nobody named', () => {
    expect(layerProblems(layer({ instructions: { path: '', text: '# hi' } }))).toEqual([
      'name the file the instructions are written to',
    ]);
    expect(layerProblems(layer({ instructions: { path: '../x.md', text: '' } }))[0]).toContain('path traversal');
  });

  it('refuses skill documents with no directory, no path, a bad path, or a path outside the tree', () => {
    expect(layerProblems(layer({ skills: [{ id: '1', path: 'skills/a/one.md', text: '' }] }))).toEqual([
      'name the skills directory these documents belong to',
    ]);
    expect(layerProblems(layer({ skillsDirectory: '/abs' }))[0]).toContain('relative to the asset directory');
    expect(layerProblems(layer({ skillsDirectory: 'skills/a', skills: [{ id: '1', path: '', text: '' }] }))).toEqual([
      'every skill document needs a path',
    ]);
    expect(
      layerProblems(layer({ skillsDirectory: 'skills/a', skills: [{ id: '1', path: '../out.md', text: '' }] })),
    ).toEqual([
      'the skill path "../out.md" contains a path traversal segment',
      '"../out.md" is not inside the skills directory "skills/a"',
    ]);
  });

  it('refuses two texts written to one path, whichever rows carry them', () => {
    // Two skill rows on one document. `assetEdits` sent both and the last one won, so the review showed
    // two texts for one path with nothing saying which would survive.
    expect(
      layerProblems(
        layer({
          skillsDirectory: 'skills/a',
          skills: [
            { id: '1', path: 'skills/a/one.md', text: 'first' },
            { id: '2', path: 'skills/a/one.md', text: 'second' },
          ],
        }),
      ),
    ).toEqual(['"skills/a/one.md" is written twice by this change; one path carries one text']);

    // The instructions file named again as a skill document is the same collision across two fields.
    expect(
      layerProblems(
        layer({
          instructions: { path: 'instructions/a.md', text: 'from the instructions box' },
          skillsDirectory: 'instructions',
          skills: [{ id: '1', path: 'instructions/a.md', text: 'from a skill row' }],
        }),
      ),
    ).toEqual(['"instructions/a.md" is written twice by this change; one path carries one text']);

    // Said once per colliding path, not once per row.
    expect(
      layerProblems(
        layer({
          skillsDirectory: 'skills/a',
          skills: [
            { id: '1', path: 'skills/a/one.md', text: 'a' },
            { id: '2', path: 'skills/a/one.md', text: 'b' },
            { id: '3', path: 'skills/a/one.md', text: 'c' },
          ],
        }),
      ),
    ).toHaveLength(1);

    // Distinct paths are the ordinary case, and two EMPTY rows are already reported as missing paths.
    expect(
      layerProblems(
        layer({
          skillsDirectory: 'skills/a',
          skills: [
            { id: '1', path: 'skills/a/one.md', text: 'a' },
            { id: '2', path: 'skills/a/two.md', text: 'b' },
          ],
        }),
      ),
    ).toHaveLength(0);
    expect(
      layerProblems(
        layer({
          skillsDirectory: 'skills/a',
          skills: [
            { id: '1', path: '', text: '' },
            { id: '2', path: '', text: '' },
          ],
        }),
      ),
    ).toEqual(['every skill document needs a path', 'every skill document needs a path']);
  });

  it('refuses settings that are not a JSON object', () => {
    expect(layerProblems(layer({ settingsText: '{' }))).toEqual(['settings must be valid JSON']);
    expect(layerProblems(layer({ settingsText: '[1,2]' }))).toEqual(['settings must be a JSON object']);
    expect(layerProblems(layer({ settingsText: '   ' }))).toHaveLength(0);
  });

  it('refuses an unusable, unnamed or repeated environment variable', () => {
    expect(layerProblems(layer({ env: [{ id: '1', name: '', value: 'x' }] }))).toEqual([
      'every environment variable needs a name',
    ]);
    expect(layerProblems(layer({ env: [{ id: '1', name: '9lives', value: 'x' }] }))).toEqual([
      '"9lives" is not a usable environment variable name',
    ]);
    expect(
      layerProblems(
        layer({
          env: [
            { id: '1', name: 'FY_LANE', value: 'a' },
            { id: '2', name: 'FY_LANE', value: 'b' },
          ],
        }),
      ),
    ).toEqual(['"FY_LANE" is set more than once']);
  });
});

describe('account problems', () => {
  const draft = (overrides: Partial<FleetAccountDraft>): FleetAccountDraft => ({
    ...emptyAccountDraft('claude'),
    name: 'studio',
    modelsText: 'claude-opus-5',
    defaultModel: 'claude-opus-5',
    ...overrides,
  });

  it('accepts a servable account in a declared lane', () => {
    expect(accountProblems(draft({}), declared)).toHaveLength(0);
  });

  it('refuses a name that would escape a directory or corrupt a wrapper', () => {
    expect(accountProblems(draft({ name: '' }), declared)).toContain('name the provider account this lane belongs to');
    expect(accountProblems(draft({ name: ' studio' }), declared)).toContain(
      'the account name must not start or end with whitespace',
    );
    expect(accountProblems(draft({ name: 'x'.repeat(65) }), declared)).toContain(
      'the account name must be 64 characters or shorter',
    );
    for (const name of ['a/b', 'a\\b', '..', `a${CONTROL}b`]) {
      expect(accountProblems(draft({ name }), declared)).toContain(
        'the account name must not contain a path separator, "..", or control characters',
      );
    }
  });

  it('will not put an account in a lane this fleet does not declare', () => {
    expect(accountProblems(draft({ variant: '' }), declared)).toContain('name the lane this account occupies');
    expect(accountProblems(draft({ variant: 'ghost' }), declared)[0]).toContain('declares no "ghost" lane');
    // With no configuration read there is nothing to check the lane against, so it is not invented.
    expect(accountProblems(draft({ variant: 'ghost' }), null)).toHaveLength(0);
  });

  it('requires an account that claims to be available to be able to serve something', () => {
    expect(accountProblems(draft({ modelsText: '' }), declared)).toContain(
      'an available account must list at least one model it can serve',
    );
    expect(accountProblems(draft({ defaultModel: '' }), declared)).toContain(
      'name the default model this account serves',
    );
    expect(accountProblems(draft({ defaultModel: 'gpt-9' }), declared)[0]).toContain(
      'the default model "gpt-9" is not one of the models listed',
    );
  });

  it('carries the layer problems too, so one list is the whole answer', () => {
    expect(accountProblems(draft({ layer: { ...emptyLayerDraft(), settingsText: '{' } }), declared)).toEqual([
      'settings must be valid JSON',
    ]);
  });
});

describe('drafts become one named mutation', () => {
  it('sends create with the derived fields, the layer and its asset text', () => {
    const request = createAccountProposal({
      harness: 'claude',
      name: ' studio '.trim(),
      variant: 'default',
      displayName: ' Studio Claude ',
      mode: 'auto',
      modelsText: 'opus, sonnet',
      defaultModel: 'opus',
      layer: {
        instructions: { path: 'instructions/studio.md', text: '# be careful' },
        skillsDirectory: 'skills/studio',
        skills: [{ id: '1', path: ' skills/studio/one.md ', text: 'x' }],
        settingsText: '{"model":"opus"}',
        env: [{ id: '1', name: ' FY_LANE ', value: 'studio' }],
        preserved: {},
      },
    });
    expect(request.mutation).toEqual({
      kind: 'create-account',
      harness: 'claude',
      name: 'studio',
      variant: 'default',
      mode: 'auto',
      models: ['opus', 'sonnet'],
      defaultModel: 'opus',
      displayName: 'Studio Claude',
      layer: {
        memory: 'instructions/studio.md',
        skills: 'skills/studio',
        settings: { model: 'opus' },
        env: { FY_LANE: 'studio' },
      },
    });
    expect(request.assetEdits).toEqual([
      { path: 'instructions/studio.md', content: '# be careful' },
      { path: 'skills/studio/one.md', content: 'x' },
    ]);
  });

  it('omits a display name and a layer nobody filled in', () => {
    const request = createAccountProposal({
      ...emptyAccountDraft('codex'),
      name: 'solo',
      modelsText: 'gpt',
      defaultModel: 'gpt',
    });
    expect(request.mutation).toEqual({
      kind: 'create-account',
      harness: 'codex',
      name: 'solo',
      variant: 'default',
      mode: 'auto',
      models: ['gpt'],
      defaultModel: 'gpt',
    });
    expect(request.assetEdits).toHaveLength(0);
  });

  it('sends an edit as a patch that removes every concern the person cleared', () => {
    expect(editAccountProposal('abc', emptyLayerDraft())).toEqual({
      mutation: {
        kind: 'edit-account',
        accountId: 'abc',
        layer: { memory: null, skills: null, settings: null, env: null },
      },
      assetEdits: [],
    });
    const edited = editAccountProposal('abc', { ...emptyLayerDraft(), instructions: { path: 'a.md', text: '' } });
    expect(edited.mutation).toEqual({
      kind: 'edit-account',
      accountId: 'abc',
      layer: { memory: 'a.md', skills: null, settings: null, env: null },
    });
    // A declared instructions file with no text is still written: a reference to a missing file is worse.
    expect(edited.assetEdits).toEqual([{ path: 'a.md', content: '' }]);
  });

  it('asks for initialization without deriving anything', () => {
    expect(initializeProposal()).toEqual({ mutation: { kind: 'initialize' } });
  });
});

describe('declared limits', () => {
  it('states the YAML, settings-merge and asset limits rather than implying none', () => {
    expect(CHANGE_LIMITS).toHaveLength(3);
    expect(CHANGE_LIMITS[0]).toContain('YAML comments');
    expect(CHANGE_LIMITS[1]).toContain('MERGED');
    expect(CHANGE_LIMITS[2]).toContain('per-skill selection');
  });
});
