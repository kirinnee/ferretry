/**
 * The settings half of the clone review and of `clone.import`'s update mode (design §5, §8b): which documents a copy
 * merges, what a decision may say, and what a review row carries.
 */
import { describe, it } from 'bun:test';
import should from 'should';
import { CONFIG_FILE_MAX_BYTES } from '../../src/lib/config-files.ts';
import { FleetAccountChangeSchema } from '../../src/lib/fleet-catalog.ts';
import {
  CLONE_SETTINGS_DOCS,
  CloneReviewSettingsSchema,
  CloneSettingsDecisionsSchema,
  FleetCloneReviewRequestSchema,
} from '../../src/lib/fleet-clone-diff.ts';

const BUNDLE = { format: 'ferretry-clone' };

describe('the settings documents a copy merges', () => {
  it('should be the three configuration files and the controls, and nothing else', () => {
    should([...CLONE_SETTINGS_DOCS]).eql(['warden.yaml', 'learning.yaml', 'voice.yaml', 'controls']);
  });

  it('should be what a review request and a clone.import may carry', () => {
    const settings = CLONE_SETTINGS_DOCS.map(path => ({ path, text: 'x' }));
    should(FleetCloneReviewRequestSchema.safeParse({ bundle: BUNDLE, settings }).success).equal(true);
    should(
      FleetAccountChangeSchema.safeParse({ kind: 'clone.import', mode: 'update', bundle: BUNDLE, settings }).success,
    ).equal(true);
  });

  it.each([
    ['machine.yaml (whose advanced block names this machine’s own paths)', [{ path: 'machine.yaml', text: '' }]],
    ['a path that climbs out', [{ path: '../warden.yaml', text: '' }]],
    ['a field the schema does not know', [{ path: 'warden.yaml', text: '', extra: 1 }]],
    [
      'a file over the configuration size limit',
      [{ path: 'warden.yaml', text: 'x'.repeat(CONFIG_FILE_MAX_BYTES + 1) }],
    ],
    ['more documents than there are', [...CLONE_SETTINGS_DOCS, 'warden.yaml'].map(path => ({ path, text: '' }))],
  ])('should refuse %s', (_name, settings) => {
    should(FleetCloneReviewRequestSchema.safeParse({ bundle: BUNDLE, settings }).success).equal(false);
    should(
      FleetAccountChangeSchema.safeParse({ kind: 'clone.import', mode: 'update', bundle: BUNDLE, settings }).success,
    ).equal(false);
  });
});

describe('per-key decisions', () => {
  it('should be take or keep, per key, per document', () => {
    const decisions = {
      'warden.yaml': { 'layers.jev': 'keep', intervalMinutes: 'take' },
      controls: { defaultRuntime: 'take' },
    };
    should(CloneSettingsDecisionsSchema.parse(decisions)).eql(decisions);
    should(
      FleetAccountChangeSchema.safeParse({
        kind: 'clone.import',
        mode: 'update',
        bundle: BUNDLE,
        settingsDecisions: decisions,
      }).success,
    ).equal(true);
  });

  it.each([
    ['remove', { 'warden.yaml': { a: 'remove' } }],
    ['skip', { 'warden.yaml': { a: 'skip' } }],
    ['a document that is not merged', { 'machine.yaml': { a: 'take' } }],
    ['an empty key', { 'warden.yaml': { '': 'take' } }],
  ])('should refuse %s', (_name, decisions) => {
    should(CloneSettingsDecisionsSchema.safeParse(decisions).success).equal(false);
  });
});

describe('a settings row of the review', () => {
  it('should carry the key, its outcome, the default choice, both values as text and the loosening flag', () => {
    const row = {
      path: 'warden.yaml',
      keys: [
        { key: 'caps.jevUsdPerDay', outcome: 'theirs', choice: 'take', mine: '1', theirs: '5', loosens: true },
        { key: 'intervalMinutes', outcome: 'both', mine: '5', theirs: '10' },
      ],
    };
    should(CloneReviewSettingsSchema.parse(row)).eql(row);
  });

  it('should say a document is new here, or why it was refused', () => {
    should(CloneReviewSettingsSchema.parse({ path: 'voice.yaml', isNew: true, keys: [] }).isNew).equal(true);
    should(
      CloneReviewSettingsSchema.parse({
        path: 'warden.yaml',
        refused: 'this device may not change warden.yaml',
        keys: [],
      }).refused,
    ).containEql('warden.yaml');
  });

  it('should refuse a choice that is not take or keep, and a field it does not know', () => {
    should(
      CloneReviewSettingsSchema.safeParse({
        path: 'warden.yaml',
        keys: [{ key: 'a', outcome: 'both', choice: 'remove' }],
      }).success,
    ).equal(false);
    should(
      CloneReviewSettingsSchema.safeParse({ path: 'warden.yaml', keys: [{ key: 'a', outcome: 'both', secret: 'x' }] })
        .success,
    ).equal(false);
  });
});
