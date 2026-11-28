/**
 * E-276 0a: the data words every harness is known by (group G) and the refusal of a third harness key: the stored-word table, the
 * display names, instruction file names, package names, asset destinations, fast-mode rule, and what each surface says for a key
 * Runtimes has no behaviour for. Every later move must leave these answers as they are, including the sentence a missing harness
 * behaviour fails closed with.
 */
import { describe, it } from 'bun:test';
import { REAL_KITS } from '../../support/real-kits.ts';
import { ASSET_FIELDS, HARNESS_ASSETS, harnessAsset, ownedSkillEntriesOf } from '../../../daemon/lib/assets.ts';
import { parseAccountModel } from '../../../daemon/lib/account/schema.ts';
import {
  displayNameOf,
  harnessKeyOfKind,
  harnessKindOfKey,
  HarnessKindSchema,
  isSupportedKind,
  supportedKindOfKey,
  supportedKinds,
  unsupportedHarnessSentence,
} from '../../../daemon/lib/harness-kind.ts';
import { claudeFastSupport } from '../../../daemon/lib/service/foreign.ts';
import {
  harnessName,
  harnessWords,
  isSupportedHarnessKey,
  supportedHarnessKeys,
} from '../../../contract/harness-words.ts';
import {
  harnessWord,
  modelDisplayName,
  profileDisplayName,
  terminalSignInWords,
} from '../../../contract/display-name.ts';
import { expectGolden } from './support/golden.ts';
import { outcome, THIRD_KEY } from './support/thrown.ts';

const WORDS = ['claude', 'codex', 'claude-code', THIRD_KEY, '', 'Claude'];

describe('harness word goldens', () => {
  it('should keep the tables of stored words exactly as the base has them', () => {
    expectGolden('words/tables', {
      supportedKinds: supportedKinds(),
      keyOfKind: Object.fromEntries(supportedKinds().map(kind => [kind, harnessKeyOfKind(kind)])),
      displayNames: Object.fromEntries(supportedKinds().map(kind => [kind, displayNameOf(kind)])),
      instructionsNames: Object.fromEntries(
        [...REAL_KITS].map(([kind, kit]) => [kind, kit.importSetup?.instructionsName]),
      ),
      packages: Object.fromEntries(
        [...REAL_KITS].map(([kind, kit]) => [
          kind,
          { npm: kit.install?.npm, cask: kit.install?.cask, nixpkgs: kit.install?.nixpkgs },
        ]),
      ),
      ownedSkillEntries: Object.fromEntries([...REAL_KITS].map(([kind, kit]) => [kind, ownedSkillEntriesOf(kit)])),
      assets: Object.fromEntries(
        supportedKinds().map(kind => [
          kind,
          Object.fromEntries(ASSET_FIELDS.map(field => [field, harnessAsset(HARNESS_ASSETS, kind, field) ?? null])),
        ]),
      ),
      ownedEntry: {
        '.system': ownedSkillEntriesOf(REAL_KITS.get('codex')).includes('.system'),
        claudeSystem: ownedSkillEntriesOf(REAL_KITS.get('claude')).includes('.system'),
        mine: ownedSkillEntriesOf(REAL_KITS.get('codex')).includes('mine'),
      },
      fastMode: Object.fromEntries(
        ['claude-opus-5-5', 'claude-opus-4-8', 'Claude-OPUS-5', 'claude-sonnet-5-5', 'gpt-6'].map(id => [
          id,
          claudeFastSupport(id),
        ]),
      ),
    });
  });

  it('should answer every word the way the base does, a third key included', () => {
    expectGolden('words/lookups', {
      words: Object.fromEntries(
        WORDS.map(word => [
          word,
          {
            isSupportedKind: isSupportedKind(word),
            supportedKindOfKey: supportedKindOfKey(word) ?? null,
            kindOfKey: outcome(() => harnessKindOfKey(word as never)),
            schema: HarnessKindSchema.safeParse(word).success
              ? 'accepted'
              : (HarnessKindSchema.safeParse(word).error?.issues.map(issue => issue.message) ?? []),
            surfaceWords: harnessWords(word) ?? null,
            surfaceName: harnessName(word),
            surfaceSupported: isSupportedHarnessKey(word),
            surfaceWord: harnessWord(word as never),
          },
        ]),
      ),
      sentence: unsupportedHarnessSentence(THIRD_KEY),
      surfaceKeys: supportedHarnessKeys(),
    });
  });

  it("should say a stored login on a third harness is refused, in the loader's own words", () => {
    const model = (harness: string) =>
      outcome(() =>
        parseAccountModel({
          version: 1,
          credentials: { golden: { harness, store: 'host' } },
          components: {},
          profiles: { default: { layers: [] } },
          runtimes: { 'golden-runtime': { credential: 'golden', profile: 'default' } },
        }),
      );
    expectGolden('words/loader-refusal', {
      third: model(THIRD_KEY),
      parsed: [model('claude'), model('codex')].map(result => ('threw' in result ? result : 'parsed')),
    });
  });

  it('should name profiles, models and sign-ins the way the base does', () => {
    expectGolden('words/display', {
      profiles: Object.fromEntries(
        [
          'claude-default',
          'codex-starter',
          'claude-default-2',
          'ferretry-codex',
          'ferretry-claude-code',
          'ferretry-claude-pinned-opus-4',
          'mine',
        ].map(name => [name, profileDisplayName(name)]),
      ),
      models: [
        modelDisplayName('golden', [{ id: 'golden', label: 'Golden 1' }]),
        modelDisplayName('other', [{ id: 'golden', label: 'Golden 1' }]),
      ],
      terminal: [
        terminalSignInWords('host', 'ready') ?? null,
        terminalSignInWords('ferretry', 'ready') ?? null,
        terminalSignInWords('host', 'refresh_due') ?? null,
      ],
    });
  });
});
