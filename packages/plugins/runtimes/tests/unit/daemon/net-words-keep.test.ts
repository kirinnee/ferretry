/**
 * CFG-LEAK (ii) the Runtimes NET, the parts that are not a corpus: a component's detail withholds a list the write rule
 * (W) still refuses WHOLE (`argsWithheld` / `flagsWithheld`, no list, no etag); an edit that keeps a word of such a list
 * by its position is refused in words ("retype the whole list"); a whole-list replace with plain words still works; the
 * edit form says so in plain words instead of showing a blank; and the one spelling of what stands in for a hidden or a
 * withheld word is the same on both sides of the wire.
 *
 * Every secret here is an obviously fake one.
 */
import { describe, it } from 'bun:test';
import should from 'should';
import { HIDDEN_VALUE_TEXT } from '@ferretry/std/secret-reference';
import { HIDDEN_WORD_TEXT, type ComponentView, WITHHELD_WORDS_TEXT } from '../../../contract/index.ts';
import {
  draftFromComponent,
  draftProblem,
  WITHHELD_ARGS_PROBLEM,
  WITHHELD_FLAGS_PROBLEM,
} from '../../../app/features/fleet/components/component-model.ts';
import { type CatalogFacts, componentCatalog } from '../../../daemon/lib/service/catalog.ts';
import { type AccountModel, parseAccountModel } from '../../../daemon/lib/account/schema.ts';
import { deriveAccountChange, FleetMutationRefusal } from '../../../daemon/lib/service/mutations.ts';
import { WITHHELD } from '../../../../../std/tests/support/command-line-family.ts';

const V = 'Zk3pQ9vXw2LmN7rT';
/** F7: one list item holding blanks, with a pointer and a raw part: the cutter shows it, W refuses it. */
const REFUSED = `srv --token \${secret:X},b=${V}`;

const FACTS: CatalogFacts = {
  format: 'present',
  machineName: 'box',
  tools: { claude: '/usr/bin/claude', codex: undefined },
  runningSessions: 0,
  userHome: '/home/person',
  acceptsAutoPermissionMode: true,
};

const modelOf = (words: readonly string[]): AccountModel =>
  parseAccountModel({
    version: 1,
    components: {
      settings: { base: { harness: 'claude', file: 'components/settings/base.json', flags: [...words] } },
      mcp: { gh: { command: 'npx', args: [...words] } },
    },
    profiles: { p: { layers: ['settings/base', 'mcp/gh'] } },
  });

function viewOf(model: AccountModel, reference: string): ComponentView {
  const found = componentCatalog(model, FACTS)
    .kinds.flatMap(group => group.components)
    .find(component => component.reference === reference);
  if (found === undefined) throw new Error(`no ${reference}`);
  return found;
}

const derive = (model: AccountModel, change: object) =>
  deriveAccountChange(model, change as Parameters<typeof deriveAccountChange>[1], {
    machineName: 'box',
    runningSessions: 0,
  });

const put = (kind: 'settings' | 'mcp', words: readonly unknown[], etag?: string) =>
  kind === 'settings'
    ? {
        kind: 'component.put',
        name: 'base',
        create: false,
        component: { kind, harness: 'claude-code', flags: words, ...(etag === undefined ? {} : { flagsEtag: etag }) },
      }
    : {
        kind: 'component.put',
        name: 'gh',
        create: false,
        component: { kind, command: 'npx', args: words, ...(etag === undefined ? {} : { argsEtag: etag }) },
      };

describe('the Runtimes net: a withheld list in a component’s detail', () => {
  it('should withhold the WHOLE list a word of which W still refuses: no list, no etag, a flag that says so', () => {
    // Arrange
    const model = modelOf(['--verbose', REFUSED]);

    // Act
    const flags = viewOf(model, 'settings/base').detail;
    const args = viewOf(model, 'mcp/gh').detail;

    // Assert
    should(flags).containEql({ flagsWithheld: true });
    should(flags).not.have.property('flags');
    should(flags).not.have.property('flagsEtag');
    should(args).containEql({ argsWithheld: true });
    should(args).not.have.property('args');
    should(args).not.have.property('argsEtag');
    should(JSON.stringify([flags, args])).not.containEql(V);
  });

  it('should show a list W accepts as it always did, with its etag', () => {
    // Arrange / Act
    const flags = viewOf(modelOf(['--verbose', '--model', 'x']), 'settings/base').detail;

    // Assert
    should(flags).containEql({ flags: ['--verbose', '--model', 'x'] });
    should(flags).have.property('flagsEtag');
    should(flags).not.have.property('flagsWithheld');
  });

  it('should refuse an edit that keeps a word of a withheld list, in words: retype the whole list', () => {
    // Arrange
    const model = modelOf(['--verbose', REFUSED]);
    for (const kind of ['settings', 'mcp'] as const) {
      // Act
      let message = '';
      try {
        derive(model, put(kind, [{ keep: true, at: 1 }], 'any-etag'));
      } catch (error) {
        should(error).be.instanceOf(FleetMutationRefusal);
        message = (error as Error).message;
      }

      // Assert
      should(message).containEql('retype the whole list');
    }
  });

  it('should still replace a withheld list with plain words, whole', () => {
    // Arrange
    const model = modelOf(['--verbose', REFUSED]);

    // Act
    const flags = derive(model, put('settings', ['--model=x'])).model.components.settings.base?.flags;
    const args = derive(model, put('mcp', ['-y', 'gh-mcp'])).model.components.mcp.gh?.args;

    // Assert
    should(flags).deepEqual(['--model=x']);
    should(args).deepEqual(['-y', 'gh-mcp']);
  });

  it('should tell the form, which says so in plain words and cannot save what it never held', () => {
    // Arrange
    const model = modelOf(['--verbose', REFUSED]);
    const settings = draftFromComponent(viewOf(model, 'settings/base'));
    const mcp = draftFromComponent(viewOf(model, 'mcp/gh'));

    // Assert
    should(settings.wordsWithheld).be.true();
    should(mcp.wordsWithheld).be.true();
    should(draftProblem(settings, [], 'base')).equal(WITHHELD_FLAGS_PROBLEM);
    // Only the command is in the box: saving it as it is would drop the arguments, so it says to type them again.
    should(draftProblem(mcp, [], 'gh')).equal(WITHHELD_ARGS_PROBLEM);
    // Typing the whole command line again is a whole-list replace.
    should(draftProblem({ ...mcp, body: 'npx -y gh-mcp' }, [], 'gh')).be.undefined();
  });

  it('should spell what stands in for a hidden word once, and what stands in for a withheld one in plain words', () => {
    should(HIDDEN_WORD_TEXT).equal(HIDDEN_VALUE_TEXT);
    should(WITHHELD).equal(WITHHELD_WORDS_TEXT);
    should(WITHHELD_WORDS_TEXT).not.containEql('undefined');
    should(WITHHELD_WORDS_TEXT.length).be.above(20);
  });
});
