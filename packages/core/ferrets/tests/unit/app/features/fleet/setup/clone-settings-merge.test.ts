import { describe, expect, it } from 'bun:test';
import type { FleetCloneReview, FleetMachineView } from '@ferretry/protocol';
import {
  choiceFor,
  controlsText,
  keepItemsDecisions,
  outcomeWords,
  pickId,
  refusedDocuments,
  reviewedFor,
  type SettingsPicks,
  settingsDecisions,
  settingsDocOf,
  settingsToSend,
  takeWords,
  undecidedKeys,
} from '../../../../../../app/features/fleet/setup/clone-settings-merge.ts';

const review = (settings: FleetCloneReview['settings'], items: FleetCloneReview['items'] = []): FleetCloneReview => ({
  mode: 'update',
  source: { name: 'work-mac', verified: 'browser' },
  items,
  settings,
  logins: [],
  keys: [],
  same: { count: 0, probable: 0 },
  fingerprint: 'f'.repeat(64),
});

const WARDEN: FleetCloneReview['settings'][number] = {
  path: 'warden.yaml',
  keys: [
    { key: 'caps.jevUsdPerDay', outcome: 'theirs', choice: 'take', mine: '1', theirs: '5', loosens: true },
    { key: 'intervalMinutes', outcome: 'both', mine: '5', theirs: '10' },
    { key: 'layers.llm', outcome: 'mine', choice: 'keep', mine: 'true', theirs: 'false' },
  ],
};

const MACHINE = {
  agentPermissions: 'skip',
  defaultRuntime: null,
  agentControl: { terminals: true, browsers: false, files: true, ferretrySettings: false, pageScripts: false },
} as unknown as FleetMachineView;

describe('the documents sent for review', () => {
  it('should send each ticked settings file as text, and a file the source has none of as the empty text', () => {
    const files = new Map([
      ['warden.yaml', { path: 'warden.yaml', exists: true, text: 'enabled: true\n' }],
      ['learning.yaml', { path: 'learning.yaml', exists: false, text: '# starter\n' }],
      ['voice.yaml', { path: 'voice.yaml', exists: true, text: 'x: 1\n' }],
    ]);
    expect(settingsToSend(['fleet', 'warden', 'learning'], files, MACHINE)).toEqual([
      { path: 'warden.yaml', text: 'enabled: true\n' },
      { path: 'learning.yaml', text: '' },
    ]);
  });

  it('should send the controls as JSON, leaving an unset default runtime out, only when ticked and readable', () => {
    expect(JSON.parse(controlsText(MACHINE))).toEqual({
      agentPermissions: 'skip',
      agentControl: MACHINE.agentControl,
    });
    expect(JSON.parse(controlsText({ ...MACHINE, defaultRuntime: 'claude-work' }).toString()).defaultRuntime).toBe(
      'claude-work',
    );
    expect(settingsToSend(['controls'], new Map(), MACHINE)).toHaveLength(1);
    expect(settingsToSend(['controls'], new Map(), null)).toEqual([]);
    expect(settingsToSend(['fleet'], new Map(), MACHINE)).toEqual([]);
  });

  it('should map a settings item to its document and the fleet to none', () => {
    expect([settingsDocOf('warden'), settingsDocOf('controls'), settingsDocOf('fleet')]).toEqual([
      'warden.yaml',
      'controls',
      undefined,
    ]);
  });
});

describe('what is chosen', () => {
  it('should leave a key both machines changed UNCHOSEN until the person picks', () => {
    const picks: SettingsPicks = new Map();
    expect(choiceFor('warden.yaml', WARDEN.keys[1] as never, picks)).toBeUndefined();
    expect(undecidedKeys([WARDEN], picks)).toEqual(['warden.yaml: intervalMinutes']);
    const picked: SettingsPicks = new Map([[pickId('warden.yaml', 'intervalMinutes'), 'take']]);
    expect(undecidedKeys([WARDEN], picked)).toEqual([]);
  });

  it('should use the daemon’s default for every other key, and the person’s pick over it', () => {
    expect(choiceFor('warden.yaml', WARDEN.keys[0] as never, new Map())).toBe('take');
    const picks: SettingsPicks = new Map([[pickId('warden.yaml', 'caps.jevUsdPerDay'), 'keep']]);
    expect(choiceFor('warden.yaml', WARDEN.keys[0] as never, picks)).toBe('keep');
  });

  it('should send an explicit choice for each decided key and none for an undecided one', () => {
    expect(settingsDecisions([WARDEN], new Map())).toEqual({
      'warden.yaml': { 'caps.jevUsdPerDay': 'take', 'layers.llm': 'keep' },
    });
    expect(settingsDecisions([WARDEN], new Map([[pickId('warden.yaml', 'intervalMinutes'), 'keep']]))).toEqual({
      'warden.yaml': { 'caps.jevUsdPerDay': 'take', intervalMinutes: 'keep', 'layers.llm': 'keep' },
    });
  });

  it('should name a document the daemon will not copy', () => {
    expect(refusedDocuments([WARDEN])).toEqual([]);
    expect(
      refusedDocuments([{ path: 'warden.yaml', refused: 'this device may not change warden.yaml', keys: [] }]),
    ).toEqual([{ path: 'warden.yaml', why: 'this device may not change warden.yaml' }]);
  });

  it('should leave every item as it is: skip a new one, keep any other', () => {
    const item = (ref: string, outcome: FleetCloneReview['items'][number]['outcome']) =>
      ({ ref, kind: 'instructions', outcome, match: 'key', files: [] }) as FleetCloneReview['items'][number];
    expect(
      keepItemsDecisions([
        item('instructions/a', 'new'),
        item('instructions/b', 'theirs'),
        item('instructions/c', 'both'),
        item('instructions/d', 'gone'),
        item('instructions/e', 'removed-here'),
      ]),
    ).toEqual({
      'instructions/a': 'skip',
      'instructions/b': 'keep',
      'instructions/c': 'keep',
      'instructions/d': 'keep',
      'instructions/e': 'keep',
    });
  });

  it('should show only the documents of the ticked items', () => {
    const both = review([WARDEN, { path: 'controls', keys: [] }]);
    expect(reviewedFor(both, ['fleet', 'warden']).map(document => document.path)).toEqual(['warden.yaml']);
    expect(reviewedFor(both, ['controls']).map(document => document.path)).toEqual(['controls']);
    expect(reviewedFor(both, ['fleet'])).toEqual([]);
  });
});

describe('the words', () => {
  it('should say where each outcome came from', () => {
    expect(outcomeWords('theirs', 'work-mac')).toBe('Changed on work-mac');
    expect(outcomeWords('mine', 'work-mac')).toBe('Changed here, kept');
    expect(outcomeWords('both', 'work-mac')).toBe('Changed on both');
    expect(takeWords({ key: 'a', outcome: 'gone' }, 'work-mac')).toBe('Remove it here too');
    expect(takeWords({ key: 'a', outcome: 'new' }, 'work-mac')).toBe('Add it from work-mac');
  });
});
