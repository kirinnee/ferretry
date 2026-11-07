import { describe, it } from 'bun:test';
import { sha256Hex } from '../../../daemon/lib/foreign.ts';
import should from 'should';
import {
  analyseCloneSettings as analyse,
  applyControls,
  type CloneSettingsInput,
  controlsDocument,
  planCloneSettings,
  reviewCloneSettings,
} from '../../../daemon/lib/account/clone-settings.ts';
import { CloneRefusal } from '../../../daemon/lib/account/clone-parts.ts';
import { parseAccountModel } from '../../../daemon/lib/account/schema.ts';
import { configText, DEFAULT_WARDEN_CONFIG } from './fixtures/config-text.ts';

const analyseCloneSettings = (
  inputs: readonly CloneSettingsInput[],
  base: Parameters<typeof analyse>[1],
): ReturnType<typeof analyse> => analyse(inputs, base, configText);

const digest = (value: unknown): string => sha256Hex(JSON.stringify(value));

const MINE = `# yaml-language-server: $schema=../schema/warden.json
# My warden: kept on, Jev off until I have read the bill.
enabled: true # do not turn off
layers:
  jev: false # off on purpose
  llm: false
caps:
  jevUsdPerDay: 1
intervalMinutes: 5
`;

const warden = (patch: Partial<CloneSettingsInput> = {}): CloneSettingsInput => ({
  path: 'warden.yaml',
  theirs: MINE,
  mine: MINE,
  mineExists: true,
  effective: DEFAULT_WARDEN_CONFIG,
  ...patch,
});

/** The record's digests for a document, as a copy would have left them. */
const base = (values: Record<string, unknown>): Record<string, string> =>
  Object.fromEntries(Object.entries(values).map(([key, value]) => [key, digest(value)]));

/** `digestOf` is canonical JSON: for scalars and lists of scalars it is plain JSON. */
const BASE_OF_MINE = base({
  enabled: true,
  'layers.jev': false,
  'layers.llm': false,
  'caps.jevUsdPerDay': 1,
  intervalMinutes: 5,
});

const rowsOf = (input: CloneSettingsInput, recorded?: Record<string, string>) => {
  const analysis = analyseCloneSettings([input], recorded === undefined ? undefined : { [input.path]: recorded });
  return { analysis, review: reviewCloneSettings(analysis)[0] as ReturnType<typeof reviewCloneSettings>[number] };
};

const outcomes = (input: CloneSettingsInput, recorded?: Record<string, string>): Record<string, string> =>
  Object.fromEntries(rowsOf(input, recorded).review.keys.map(row => [row.key, row.outcome]));

describe('clone settings: per-key outcomes (design §3 per key)', () => {
  it('lists nothing when both sides agree', () => {
    should(outcomes(warden(), BASE_OF_MINE)).eql({});
    should(rowsOf(warden(), BASE_OF_MINE).review.keys).eql([]);
  });

  it('changed on the source only: theirs, taken by default', () => {
    const theirs = MINE.replace('intervalMinutes: 5', 'intervalMinutes: 10');
    const { review } = rowsOf(warden({ theirs }), BASE_OF_MINE);
    should(review.keys).eql([{ key: 'intervalMinutes', outcome: 'theirs', choice: 'take', mine: '5', theirs: '10' }]);
  });

  it('changed here only: mine, kept by default, and it can only be kept', () => {
    const mine = MINE.replace('intervalMinutes: 5', 'intervalMinutes: 7');
    const analysis = analyseCloneSettings([warden({ mine, theirs: MINE })], { 'warden.yaml': BASE_OF_MINE });
    const [row] = (reviewCloneSettings(analysis)[0] as { keys: { key: string; outcome: string; choice?: string }[] })
      .keys;
    should(row).containEql({ key: 'intervalMinutes', outcome: 'mine', choice: 'keep' });
    should(() => planCloneSettings(analysis, { 'warden.yaml': { intervalMinutes: 'take' } })).throw(CloneRefusal);
    const plan = planCloneSettings(analysis, undefined);
    should(plan.files).eql([]);
    should(plan.done.kept).eql(['warden.yaml: intervalMinutes']);
  });

  it('changed on both sides: both, with NO default choice', () => {
    const mine = MINE.replace('intervalMinutes: 5', 'intervalMinutes: 7');
    const theirs = MINE.replace('intervalMinutes: 5', 'intervalMinutes: 10');
    const { review } = rowsOf(warden({ mine, theirs }), BASE_OF_MINE);
    const [row] = review.keys;
    should(row).containEql({ key: 'intervalMinutes', outcome: 'both', mine: '7', theirs: '10' });
    should(row).not.have.property('choice');
  });

  it('both sides made the same edit: nothing to do', () => {
    const edited = MINE.replace('intervalMinutes: 5', 'intervalMinutes: 10');
    should(outcomes(warden({ mine: edited, theirs: edited }), BASE_OF_MINE)).eql({});
  });

  it('a key only the source has, and this machine never had: new, taken by default', () => {
    const theirs = `${MINE}unattendedMinutes: 30\n`;
    const { review } = rowsOf(warden({ theirs }), BASE_OF_MINE);
    should(review.keys).eql([{ key: 'unattendedMinutes', outcome: 'new', choice: 'take', theirs: '30' }]);
  });

  it('a key the source dropped and nobody here changed: gone, kept by default, removed only if taken', () => {
    const theirs = MINE.replace('intervalMinutes: 5\n', '');
    const analysis = analyseCloneSettings([warden({ theirs })], { 'warden.yaml': BASE_OF_MINE });
    const [row] = reviewCloneSettings(analysis)[0]?.keys ?? [];
    should(row).containEql({ key: 'intervalMinutes', outcome: 'gone', choice: 'keep', mine: '5' });
    should(planCloneSettings(analysis, undefined).files).eql([]);
    const [write] = planCloneSettings(analysis, { 'warden.yaml': { intervalMinutes: 'take' } }).files;
    should(write?.text).not.containEql('intervalMinutes');
    should(write?.text).containEql('# My warden: kept on');
  });

  it('a key the source dropped that I also changed: both', () => {
    const mine = MINE.replace('intervalMinutes: 5', 'intervalMinutes: 7');
    const theirs = MINE.replace('intervalMinutes: 5\n', '');
    should(outcomes(warden({ mine, theirs }), BASE_OF_MINE)).eql({ intervalMinutes: 'both' });
  });

  it('a key I removed since the last copy: removed here, stays removed unless added back', () => {
    const mine = MINE.replace('intervalMinutes: 5\n', '');
    const analysis = analyseCloneSettings([warden({ mine, theirs: MINE })], { 'warden.yaml': BASE_OF_MINE });
    const [row] = reviewCloneSettings(analysis)[0]?.keys ?? [];
    should(row).containEql({ key: 'intervalMinutes', outcome: 'removed-here', choice: 'keep', theirs: '5' });
    should(planCloneSettings(analysis, undefined).files).eql([]);
    const [write] = planCloneSettings(analysis, { 'warden.yaml': { intervalMinutes: 'take' } }).files;
    should(write?.text).containEql('intervalMinutes: 5');
  });

  it('a key I removed that the source also changed: both', () => {
    const mine = MINE.replace('intervalMinutes: 5\n', '');
    const theirs = MINE.replace('intervalMinutes: 5', 'intervalMinutes: 9');
    should(outcomes(warden({ mine, theirs }), BASE_OF_MINE)).eql({ intervalMinutes: 'both' });
  });

  it('a key only here with no record of the source is a local addition, not listed', () => {
    const mine = `${MINE}unattendedMinutes: 30\n`;
    should(outcomes(warden({ mine }), BASE_OF_MINE)).eql({});
    should(outcomes(warden({ mine }), undefined)).eql({});
  });

  it('with no record of the source, a key both sides set differently is asked, not guessed', () => {
    const theirs = MINE.replace('intervalMinutes: 5', 'intervalMinutes: 10');
    should(outcomes(warden({ theirs }), undefined)).eql({ intervalMinutes: 'both' });
  });

  it('a file this machine does not have: every key is new, and the file is marked new', () => {
    const analysis = analyseCloneSettings([warden({ mine: '', mineExists: false })], undefined);
    const review = reviewCloneSettings(analysis)[0];
    should(review).containEql({ path: 'warden.yaml', isNew: true });
    should(new Set(review?.keys.map(row => row.outcome))).eql(new Set(['new']));
  });

  it('a file the source has none of (sent as the empty text): what a record held is gone, nothing else is listed', () => {
    const analysis = analyseCloneSettings([warden({ theirs: '' })], { 'warden.yaml': BASE_OF_MINE });
    should(new Set(reviewCloneSettings(analysis)[0]?.keys.map(row => row.outcome))).eql(new Set(['gone']));
    should(rowsOf(warden({ theirs: '' }), undefined).review.keys).eql([]);
  });
});

describe('clone settings: lists are one value', () => {
  const mineList = `${MINE}accounts:\n  - agent: claude-a\n  - agent: claude-b\n`;

  it('an edited list is one change, listed under the list key', () => {
    const theirs = `${MINE}accounts:\n  - agent: claude-a\n  - agent: claude-c\n    model: opus\n`;
    const recorded = { ...BASE_OF_MINE, ...base({ accounts: [{ agent: 'claude-a' }, { agent: 'claude-b' }] }) };
    const { review } = rowsOf(warden({ mine: mineList, theirs }), recorded);
    should(review.keys.map(row => [row.key, row.outcome])).eql([['accounts', 'theirs']]);
    should(review.keys[0]?.theirs).containEql('claude-c');
  });

  it('a reordered list is one change, and the key order of its items does not matter', () => {
    const reordered = `${MINE}accounts:\n  - agent: claude-b\n  - agent: claude-a\n`;
    should(rowsOf(warden({ mine: mineList, theirs: reordered }), undefined).review.keys.map(row => row.key)).eql([
      'accounts',
    ]);
    const sameItems = `${MINE}accounts:\n  - agent: claude-a\n  - agent: claude-b\n`;
    should(outcomes(warden({ mine: mineList, theirs: sameItems }), undefined)).eql({});
  });

  it('taking a list replaces it whole and leaves the comments around it', () => {
    const mine = `${mineList}# trailing note\n`;
    const theirs = `${MINE}accounts:\n  - agent: claude-z\n`;
    const analysis = analyseCloneSettings([warden({ mine, theirs })], undefined);
    const plan = planCloneSettings(analysis, { 'warden.yaml': { accounts: 'take' } });
    should(plan.files[0]?.text).containEql('claude-z');
    should(plan.files[0]?.text).not.containEql('claude-b');
    should(plan.files[0]?.text).containEql('# My warden: kept on');
  });
});

describe('clone settings: a value on one side and a mapping on the other is ONE decision (review finding 1)', () => {
  const EMPTY = MINE.replace(/layers:\n {2}jev: false # off on purpose\n {2}llm: false\n/u, 'layers: {}\n');

  it('an emptied mapping on the source is one row for the parent; the kept children are not rows of their own', () => {
    const { review, analysis } = rowsOf(warden({ theirs: EMPTY }), BASE_OF_MINE);
    should(review.keys.map(row => [row.key, row.outcome])).eql([['layers', 'both']]);
    should(review.keys[0]).not.have.property('choice');
    should(review.keys[0]?.mine).containEql('"jev":false');
    should(review.keys[0]?.theirs).equal('{}');
    // Nothing is chosen for the person, and keeping the parent leaves the children where they were.
    should(() => planCloneSettings(analysis, undefined)).throw(/warden.yaml: layers/);
    const kept = planCloneSettings(analysis, { 'warden.yaml': { layers: 'keep' } });
    should(kept.files).eql([]);
    should(kept.done.kept).eql(['warden.yaml: layers']);
    // Taking it is the person saying so, for the whole mapping: the review listed exactly that.
    const taken = planCloneSettings(analysis, { 'warden.yaml': { layers: 'take' } });
    should(taken.files[0]?.text).containEql('layers: {}');
    should(taken.files[0]?.text).not.containEql('jev:');
    should(taken.files[0]?.keys).eql(['layers']);
  });

  it('with no record of the source the local-only children are still listed, not silently deleted', () => {
    const { review, analysis } = rowsOf(warden({ theirs: EMPTY }));
    should(review.keys.map(row => [row.key, row.outcome])).eql([['layers', 'both']]);
    should(() => planCloneSettings(analysis, undefined)).throw(/warden.yaml: layers/);
    should(planCloneSettings(analysis, { 'warden.yaml': { layers: 'keep' } }).files).eql([]);
  });

  it('a record forged to name the children cannot make taking the parent silent', () => {
    const forged = { ...BASE_OF_MINE, layers: digest({ jev: false, llm: false }) };
    const { review } = rowsOf(warden({ theirs: EMPTY }), forged);
    // The record says the source held exactly this mapping: only the source changed it, so it is a plain `theirs`.
    should(review.keys.map(row => [row.key, row.outcome])).eql([['layers', 'theirs']]);
    // A locally edited child is a different mapping from the one the record holds: both changed, asked.
    const edited = MINE.replace('llm: false', 'llm: true');
    should(outcomes(warden({ mine: edited, theirs: EMPTY }), forged)).eql({ layers: 'both' });
  });

  it('a mapping that gains keys where this machine holds an empty one is one row, taken by default', () => {
    const mine = EMPTY;
    const recorded = { ...BASE_OF_MINE, layers: digest({}) };
    const { review, analysis } = rowsOf(warden({ mine, theirs: MINE }), recorded);
    should(review.keys.map(row => [row.key, row.outcome, row.choice])).eql([['layers', 'theirs', 'take']]);
    const text = planCloneSettings(analysis, undefined).files[0]?.text;
    should(text).containEql('jev: false');
    should(text).containEql('llm: false');
  });

  it('a scalar against a mapping is compared whole, and the record keeps the digest of the subtree', () => {
    const mine = 'x: 1\n';
    const theirs = 'x:\n  y: 2\n  z: 3\n';
    const analysis = analyseCloneSettings([{ path: 'voice.yaml', mine, theirs, mineExists: true }], undefined);
    should(reviewCloneSettings(analysis)[0]?.keys.map(row => [row.key, row.outcome, row.theirs])).eql([
      ['x', 'both', '{"y":2,"z":3}'],
    ]);
    const plan = planCloneSettings(analysis, { 'voice.yaml': { x: 'take' } });
    should(plan.files[0]?.text).containEql('y: 2');
    should(plan.files[0]?.text).not.containEql('x: 1');
    should(plan.recorded['voice.yaml']).eql({ x: digest({ y: 2, z: 3 }), 'x.y': digest(2), 'x.z': digest(3) });
  });
});

describe('clone settings: the merged text is built from this machine’s file', () => {
  const theirs = MINE.replace('intervalMinutes: 5', 'intervalMinutes: 10').replace('  llm: false', '  llm: true');

  it('changes only the taken keys and keeps comments and key order', () => {
    const mine = MINE.replace('caps:', '# my caps\ncaps:');
    const analysis = analyseCloneSettings([warden({ mine, theirs })], { 'warden.yaml': BASE_OF_MINE });
    const plan = planCloneSettings(analysis, { 'warden.yaml': { 'layers.llm': 'keep' } });
    const text = plan.files[0]?.text ?? '';
    should(text).containEql('intervalMinutes: 10');
    should(text).containEql('llm: false');
    should(text).containEql('# my caps\ncaps:');
    should(text).containEql('jev: false # off on purpose');
    should(text).containEql('enabled: true # do not turn off');
    // The whole text is exactly this machine's, with the one line changed.
    should(text).equal(mine.replace('intervalMinutes: 5', 'intervalMinutes: 10'));
    should(plan.done.taken).eql(['warden.yaml: intervalMinutes']);
    should(plan.done.kept).eql(['warden.yaml: layers.llm']);
  });

  it('writes nothing when no key is taken', () => {
    const analysis = analyseCloneSettings([warden({ theirs })], { 'warden.yaml': BASE_OF_MINE });
    const plan = planCloneSettings(analysis, {
      'warden.yaml': { intervalMinutes: 'keep', 'layers.llm': 'keep' },
    });
    should(plan.files).eql([]);
    // …but the record still moves on: B := theirs for every key the review showed.
    should(plan.recorded['warden.yaml']).eql(
      base({
        enabled: true,
        'layers.jev': false,
        'layers.llm': true,
        'caps.jevUsdPerDay': 1,
        intervalMinutes: 10,
      }),
    );
  });

  it('a nested key whose parent this machine does not have is created, and a parent left empty is removed with its last key', () => {
    const mine = 'enabled: true\n';
    const analysis = analyseCloneSettings(
      [warden({ mine, theirs: 'enabled: true\nlayers:\n  llm: true\n' })],
      undefined,
    );
    const taken = planCloneSettings(analysis, undefined).files[0]?.text ?? '';
    should(taken).containEql('layers:\n  llm: true');

    const recorded = { 'layers.llm': digest(true), enabled: digest(true) };
    const gone = analyseCloneSettings(
      [warden({ mine: 'enabled: true\nlayers:\n  llm: true\n', theirs: 'enabled: true\n' })],
      { 'warden.yaml': recorded },
    );
    const removed = planCloneSettings(gone, { 'warden.yaml': { 'layers.llm': 'take' } }).files[0]?.text ?? '';
    should(removed).not.containEql('layers');
  });

  it('a new file taken whole is the source’s own text', () => {
    const analysis = analyseCloneSettings([warden({ mine: '', mineExists: false })], undefined);
    const plan = planCloneSettings(analysis, undefined);
    should(plan.files[0]).containEql({ path: 'warden.yaml', text: MINE });
    should(plan.files[0]?.previous).be.undefined();
  });

  it('a new file with some keys left out is built from only the taken ones', () => {
    const analysis = analyseCloneSettings([warden({ mine: '', mineExists: false })], undefined);
    const plan = planCloneSettings(analysis, { 'warden.yaml': { intervalMinutes: 'keep' } });
    should(plan.files[0]?.text).containEql('enabled: true');
    should(plan.files[0]?.text).not.containEql('intervalMinutes');
  });
});

describe('clone settings: loosening is flagged per key', () => {
  it('flags the key that turns a spending layer on, and only that one', () => {
    const theirs = MINE.replace('jev: false # off on purpose', 'jev: true').replace(
      'intervalMinutes: 5',
      'intervalMinutes: 10',
    );
    const { review } = rowsOf(warden({ theirs }), BASE_OF_MINE);
    const by = Object.fromEntries(review.keys.map(row => [row.key, row.loosens === true]));
    should(by).eql({ 'layers.jev': true, intervalMinutes: false });
  });

  it('flags a raised cap, not a lowered one', () => {
    const raised = rowsOf(warden({ theirs: MINE.replace('jevUsdPerDay: 1', 'jevUsdPerDay: 5') }), BASE_OF_MINE);
    should(raised.review.keys[0]?.loosens).equal(true);
    const lowered = rowsOf(warden({ theirs: MINE.replace('jevUsdPerDay: 1', 'jevUsdPerDay: 0.25') }), BASE_OF_MINE);
    should(lowered.review.keys[0]).not.have.property('loosens');
  });

  it('marks the written file as loosening only when a taken key does', () => {
    const theirs = MINE.replace('jev: false # off on purpose', 'jev: true').replace(
      'intervalMinutes: 5',
      'intervalMinutes: 10',
    );
    const analysis = analyseCloneSettings([warden({ theirs })], { 'warden.yaml': BASE_OF_MINE });
    const everything = planCloneSettings(analysis, undefined);
    should(everything.files[0]?.loosens).equal(true);
    const safe = planCloneSettings(analysis, { 'warden.yaml': { 'layers.jev': 'keep' } });
    should(safe.files[0]?.loosens).equal(false);
  });

  it('does not charge a key with a loosening this machine’s own file already carries', () => {
    const mine = MINE.replace('jev: false # off on purpose', 'jev: true # waiting for me to confirm it');
    const theirs = mine.replace('intervalMinutes: 5', 'intervalMinutes: 10');
    const recorded = { ...BASE_OF_MINE, 'layers.jev': digest(true) };
    const { review } = rowsOf(warden({ mine, theirs }), recorded);
    should(review.keys).eql([{ key: 'intervalMinutes', outcome: 'theirs', choice: 'take', mine: '5', theirs: '10' }]);
  });
});

describe('clone settings: a document with very many differing keys', () => {
  const extra = (count: number): string =>
    Array.from({ length: count }, (_, index) => `extra${String(index)}: ${String(index)}\n`).join('');

  it('is not judged key by key past a few hundred: every key is flagged as loosening', () => {
    const { review } = rowsOf(warden({ theirs: `${MINE}${extra(300)}` }), BASE_OF_MINE);
    should(review.keys).have.length(300);
    should(review.keys.every(row => row.loosens === true)).equal(true);
  });

  it('is refused outright past what a copy merges, naming the file and writing nothing', () => {
    const analysis = analyseCloneSettings([warden({ theirs: `${MINE}${extra(2100)}` })], undefined);
    const review = reviewCloneSettings(analysis)[0];
    should(review?.refused).containEql('more than 2048 settings');
    should(review?.keys).eql([]);
    should(() => planCloneSettings(analysis, undefined)).throw(/Nothing was changed/);
  });
});

describe('clone settings: the apply is refused until every both-changed key has a choice', () => {
  const mine = MINE.replace('intervalMinutes: 5', 'intervalMinutes: 7');
  const theirs = MINE.replace('intervalMinutes: 5', 'intervalMinutes: 10').replace(
    'jevUsdPerDay: 1',
    'jevUsdPerDay: 2',
  );
  const mineBoth = mine.replace('jevUsdPerDay: 1', 'jevUsdPerDay: 3');
  const analysis = analyseCloneSettings([warden({ mine: mineBoth, theirs })], { 'warden.yaml': BASE_OF_MINE });

  it('names every undecided key', () => {
    let refusal: unknown;
    try {
      planCloneSettings(analysis, { 'warden.yaml': { intervalMinutes: 'take' } });
    } catch (error) {
      refusal = error;
    }
    should(refusal).be.instanceOf(CloneRefusal);
    should((refusal as Error).message).containEql('warden.yaml: caps.jevUsdPerDay');
    should((refusal as Error).message).not.containEql('warden.yaml: intervalMinutes');
    should(() => planCloneSettings(analysis, undefined)).throw(/warden.yaml: caps.jevUsdPerDay/);
  });

  it('applies once each has a choice, either way', () => {
    const plan = planCloneSettings(analysis, {
      'warden.yaml': { intervalMinutes: 'take', 'caps.jevUsdPerDay': 'keep' },
    });
    should(plan.files[0]?.text).containEql('intervalMinutes: 10');
    should(plan.files[0]?.text).containEql('jevUsdPerDay: 3');
  });

  it('refuses a decision about a key or a document the review did not list', () => {
    should(() => planCloneSettings(analysis, { 'warden.yaml': { 'no.such.key': 'take' } })).throw(
      /nothing called no.such.key/,
    );
    should(() => planCloneSettings(analysis, { 'voice.yaml': { x: 'take' } })).throw(/no voice.yaml settings/);
  });
});

describe('clone settings: a document that cannot be copied', () => {
  it('a source file that holds a raw secret is refused, not shown', () => {
    const secret = 'enabled: true\ninvestigation:\n  token: sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n';
    const analysis = analyseCloneSettings([warden({ theirs: secret })], undefined);
    const review = reviewCloneSettings(analysis)[0];
    should(review?.refused).be.a.String();
    should(review?.keys).eql([]);
    should(JSON.stringify(review)).not.containEql('sk-ant');
    should(() => planCloneSettings(analysis, undefined)).throw(CloneRefusal);
  });

  it('a file on THIS machine that holds a raw secret is refused: no row, value, digest or fingerprint input leaves', () => {
    const token = 'sk-ant-api03-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
    const mine = `enabled: true\ninvestigation:\n  token: ${token}\n`;
    const theirs = 'enabled: false\ninvestigation:\n  token: other\n';
    const analysis = analyseCloneSettings([warden({ mine, theirs })], { 'warden.yaml': { enabled: digest(true) } });
    const review = reviewCloneSettings(analysis)[0];
    should(review?.refused).containEql('Your warden.yaml');
    should(review?.keys).eql([]);
    const shown = JSON.stringify({ review, files: analysis.files.map(file => ({ ...file, input: undefined })) });
    should(shown).not.containEql(token);
    should(shown).not.containEql(sha256Hex(token));
    should(shown).not.containEql(sha256Hex(mine));
    should(() => planCloneSettings(analysis, undefined)).throw(/Nothing was changed/);
    // The fingerprint is not a digest of the secret-bearing text: the same refusal with another token is the same review.
    const other = mine.replace(token, 'sk-ant-api03-CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC');
    should(
      analyseCloneSettings([warden({ mine: other, theirs })], { 'warden.yaml': { enabled: digest(true) } }).fingerprint,
    ).equal(analysis.fingerprint);
  });

  it('a source file that holds a raw secret has no digest of it in the fingerprint either', () => {
    const secret = 'enabled: true\ninvestigation:\n  token: sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n';
    const again = secret.replace('AAAAAAAA', 'DDDDDDDD');
    should(analyseCloneSettings([warden({ theirs: secret })], undefined).fingerprint).equal(
      analyseCloneSettings([warden({ theirs: again })], undefined).fingerprint,
    );
  });

  it('a source file that is not YAML is refused', () => {
    const analysis = analyseCloneSettings([warden({ theirs: 'enabled: [unclosed' })], undefined);
    should(reviewCloneSettings(analysis)[0]?.refused).containEql('warden.yaml');
    should(() => planCloneSettings(analysis, undefined)).throw(/Nothing was changed/);
  });

  it('a ${secret:NAME} reference stays a reference in the review', () => {
    const theirs = `${MINE}investigation:\n  token: \${secret:JEV_API_KEY}\n`;
    const text = JSON.stringify(reviewCloneSettings(analyseCloneSettings([warden({ theirs })], undefined)));
    should(text).containEql('${secret:JEV_API_KEY}');
  });

  it('a document sent twice is refused', () => {
    should(() => analyseCloneSettings([warden(), warden()], undefined)).throw(/sent twice/);
  });
});

describe('clone settings: the record keeps digests, never values', () => {
  it('B := theirs for every key of the document, and no value is in it', () => {
    const theirs = `${MINE}investigation:\n  note: private-sounding text\n`;
    const plan = planCloneSettings(analyseCloneSettings([warden({ theirs })], undefined), {
      'warden.yaml': { 'investigation.note': 'keep' },
    });
    const recorded = plan.recorded['warden.yaml'] ?? {};
    should(Object.keys(recorded)).containEql('investigation.note');
    should(recorded['investigation.note']).match(/^[0-9a-f]{64}$/u);
    should(JSON.stringify(plan.recorded)).not.containEql('private-sounding');
  });
});

describe('clone settings: controls are one keyed document', () => {
  const machine = parseAccountModel({ version: 1 }).machine;
  const mine = controlsDocument(machine);
  const controls = (theirs: object, patch: Partial<CloneSettingsInput> = {}): CloneSettingsInput => ({
    path: 'controls',
    theirs: JSON.stringify(theirs),
    mine,
    mineExists: true,
    ...patch,
  });

  it('lists only the fields that differ, with loosening flagged', () => {
    const analysis = analyseCloneSettings(
      [controls({ agentPermissions: 'skip', agentControl: { terminals: true, ferretrySettings: true, files: false } })],
      undefined,
    );
    const rows = Object.fromEntries(
      (reviewCloneSettings(analysis)[0]?.keys ?? []).map(row => [row.key, [row.outcome, row.loosens === true]]),
    );
    should(rows).eql({
      agentPermissions: ['both', true],
      'agentControl.ferretrySettings': ['both', true],
      'agentControl.files': ['both', false],
    });
  });

  it('taking some fields is a smaller change with only those fields', () => {
    const analysis = analyseCloneSettings(
      [controls({ agentPermissions: 'skip', agentControl: { files: false, ferretrySettings: true } })],
      undefined,
    );
    const plan = planCloneSettings(analysis, {
      controls: { agentPermissions: 'keep', 'agentControl.files': 'take', 'agentControl.ferretrySettings': 'keep' },
    });
    should(plan.files).eql([]);
    should(plan.controls?.taken).eql({ agentControl: { files: false } });
    should(plan.controls?.widensAgentControl).equal(false);
    const next = applyControls(machine, plan.controls?.taken ?? {});
    should(next.agentControl.files).equal(false);
    should(next.agentControl.terminals).equal(machine.agentControl.terminals);
    should(next.agentPermissions).equal(machine.agentPermissions);
  });

  it('widening what agents may control is reported on the plan', () => {
    const analysis = analyseCloneSettings([controls({ agentControl: { pageScripts: true } })], undefined);
    const plan = planCloneSettings(analysis, { controls: { 'agentControl.pageScripts': 'take' } });
    should(plan.controls?.widensAgentControl).equal(true);
  });

  it('the default runtime is a key: taken, or unset when the source has none', () => {
    const withDefault = { ...machine, defaultRuntime: 'claude-default' };
    const analysis = analyseCloneSettings(
      [controls({ defaultRuntime: 'claude-work' }, { mine: controlsDocument(withDefault) })],
      undefined,
    );
    const plan = planCloneSettings(analysis, { controls: { defaultRuntime: 'take' } });
    should(plan.controls?.taken).eql({ defaultRuntime: 'claude-work' });
    should(applyControls(withDefault, plan.controls?.taken ?? {}).defaultRuntime).equal('claude-work');
    should(applyControls(withDefault, { defaultRuntime: null }).defaultRuntime).be.undefined();
  });

  it('a source that says nothing about a control does not drop it', () => {
    const analysis = analyseCloneSettings([controls({})], {
      controls: base({ agentPermissions: 'auto', 'agentControl.terminals': true }),
    });
    should(reviewCloneSettings(analysis)[0]?.keys).eql([]);
  });

  it('refuses controls that are not controls', () => {
    const analysis = analyseCloneSettings(
      [{ path: 'controls', theirs: '{"agentPermissions":"yolo"}', mine, mineExists: true }],
      undefined,
    );
    should(reviewCloneSettings(analysis)[0]?.refused).containEql('controls');
  });
});
