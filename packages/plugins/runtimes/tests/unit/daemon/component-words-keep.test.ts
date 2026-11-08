/**
 * Keeping a hidden launch flag or MCP argument through an edit (R-0294, ruling #39). The detail shows a word that
 * carries a credential as `{ shown, hidden: true }` (`component-detail-words.test.ts`), so the edit form never holds
 * its value: it sends `{ keep: true, at }` — the word's position in the list as read — with the list's etag, exactly as
 * an environment value the catalogue hid is kept with `{ keep: true }`.
 *
 * Every secret here is an obviously fake one.
 */
import { describe, it } from 'bun:test';
import should from 'should';
import type { ComponentView } from '../../../contract/index.ts';
import { componentChange, draftFromComponent } from '../../../app/features/fleet/components/component-model.ts';
import { type CatalogFacts, componentCatalog } from '../../../daemon/lib/service/catalog.ts';
import { type AccountModel, parseAccountModel } from '../../../daemon/lib/account/schema.ts';
import { deriveAccountChange, FleetMutationRefusal } from '../../../daemon/lib/service/mutations.ts';

const FAKE_SECRET = 'not-a-real-secret-0000';
const FAKE_TOKEN = 'sk-not-a-real-key-0000';
const FLAGS = ['--verbose', '--token', FAKE_SECRET, `--header=Authorization: Bearer ${FAKE_SECRET}`];
const ARGS = ['-y', 'gh-mcp', `--api-key=${FAKE_TOKEN}`, `https://person:${FAKE_SECRET}@h.example.invalid`];

const FACTS: CatalogFacts = {
  format: 'present',
  machineName: 'box',
  tools: { claude: '/usr/bin/claude', codex: undefined },
  runningSessions: 0,
  userHome: '/home/person',
  acceptsAutoPermissionMode: true,
};

const modelOf = (flags: readonly string[] = FLAGS, args: readonly string[] = ARGS): AccountModel =>
  parseAccountModel({
    version: 1,
    components: {
      settings: { base: { harness: 'claude', file: 'components/settings/base.json', flags: [...flags] } },
      mcp: { gh: { command: 'npx', args: [...args] } },
    },
    profiles: { p: { layers: ['settings/base', 'mcp/gh'] } },
  });

/** The catalogue's view of one component, as the edit form reads it. */
function viewOf(model: AccountModel, reference: string): ComponentView {
  const found = componentCatalog(model, FACTS)
    .kinds.flatMap(group => group.components)
    .find(component => component.reference === reference);
  if (found === undefined) throw new Error(`no ${reference}`);
  return found;
}

const etagOf = (model: AccountModel, reference: string): string => {
  const { detail } = viewOf(model, reference);
  if (detail.kind === 'settings') return detail.flagsEtag as string;
  if (detail.kind === 'mcp') return detail.argsEtag as string;
  throw new Error('no words');
};

const derive = (model: AccountModel, change: object) =>
  deriveAccountChange(model, change as Parameters<typeof deriveAccountChange>[1], {
    machineName: 'box',
    runningSessions: 0,
  });

const putFlags = (flags: readonly unknown[], flagsEtag?: string) => ({
  kind: 'component.put',
  name: 'base',
  create: false,
  component: { kind: 'settings', harness: 'claude-code', flags, ...(flagsEtag === undefined ? {} : { flagsEtag }) },
});

const putArgs = (args: readonly unknown[], argsEtag?: string) => ({
  kind: 'component.put',
  name: 'gh',
  create: false,
  component: { kind: 'mcp', command: 'npx', args, ...(argsEtag === undefined ? {} : { argsEtag }) },
});

const refusalOf = (model: AccountModel, change: object): string => {
  try {
    derive(model, change);
  } catch (error) {
    should(error).be.instanceOf(FleetMutationRefusal);
    return (error as Error).message;
  }
  throw new Error('expected a refusal');
};

describe('component.put — keeping a hidden flag or argument (R-0294, ruling #39)', () => {
  it('R-0294 should keep the stored value through an untouched edit round-trip of the edit form, flags and arguments', () => {
    // Arrange
    const model = modelOf();

    // Act — the app's own form, from the catalogue's view, saved untouched.
    const settings = derive(model, componentChange(draftFromComponent(viewOf(model, 'settings/base')), false));
    const mcp = derive(model, componentChange(draftFromComponent(viewOf(model, 'mcp/gh')), false));

    // Assert
    should(settings.model.components.settings.base?.flags).deepEqual(FLAGS);
    should(mcp.model.components.mcp.gh?.args).deepEqual(ARGS);
  });

  it('R-0294 should never let the edit form hold or send a hidden value: what it sends has no secret byte', () => {
    // Arrange
    const model = modelOf();

    // Act
    const sent = [
      componentChange(draftFromComponent(viewOf(model, 'settings/base')), false),
      componentChange(draftFromComponent(viewOf(model, 'mcp/gh')), false),
    ];

    // Assert
    for (const change of sent) {
      should(JSON.stringify(change)).not.containEql(FAKE_SECRET);
      should(JSON.stringify(change)).not.containEql(FAKE_TOKEN);
    }
    should(sent[0]).containDeep({
      component: { flags: ['--verbose', '--token', { keep: true, at: 2 }, { keep: true, at: 3 }] },
    });
  });

  it('R-0294 should keep a value by its position as read, so moving words moves no value', () => {
    // Arrange
    const model = modelOf();
    const etag = etagOf(model, 'settings/base');

    // Act — the words reordered, and one typed new.
    const edit = derive(model, putFlags([{ keep: true, at: 3 }, '--token', { keep: true, at: 2 }, '--model=x'], etag));

    // Assert
    should(edit.model.components.settings.base?.flags).deepEqual([
      `--header=Authorization: Bearer ${FAKE_SECRET}`,
      '--token',
      FAKE_SECRET,
      '--model=x',
    ]);
  });

  it('R-0294 should keep an MCP argument by its position too, judged with the command it was read with', () => {
    // Arrange
    const model = modelOf();
    const etag = etagOf(model, 'mcp/gh');

    // Act
    const edit = derive(model, putArgs(['gh-mcp', { keep: true, at: 3 }, { keep: true, at: 2 }], etag));

    // Assert
    should(edit.model.components.mcp.gh?.args).deepEqual([
      'gh-mcp',
      `https://person:${FAKE_SECRET}@h.example.invalid`,
      `--api-key=${FAKE_TOKEN}`,
    ]);
  });

  it("R-0294 should refuse a keep read against a list that has changed since (a stale etag), in the environment's words", () => {
    // Arrange — read, then somebody else inserts a word before the hidden one.
    const read = modelOf();
    const etag = etagOf(read, 'settings/base');
    const changed = modelOf(['--print', ...FLAGS]);

    // Act
    const refusal = refusalOf(changed, putFlags(['--verbose', '--token', { keep: true, at: 2 }], etag));

    // Assert
    should(refusal).equal('settings base has no value for flag 3 to keep; type one');
    should(refusalOf(modelOf(FLAGS, ['--x', ...ARGS]), putArgs([{ keep: true, at: 2 }], etagOf(read, 'mcp/gh')))).equal(
      'MCP server gh has no value for argument 3 to keep; type one',
    );
  });

  it('R-0294 should refuse a keep with no etag, past the end of the list, or on a new component', () => {
    // Arrange
    const model = modelOf();
    const etag = etagOf(model, 'settings/base');

    // Assert
    should(refusalOf(model, putFlags([{ keep: true, at: 2 }]))).equal(
      'settings base has no value for flag 3 to keep; type one',
    );
    should(refusalOf(model, putFlags([{ keep: true, at: 9 }], etag))).equal(
      'settings base has no value for flag 10 to keep; type one',
    );
    should(refusalOf(model, { ...putFlags([{ keep: true, at: 0 }], etag), name: 'fresh', create: true })).equal(
      'settings fresh has no value for flag 1 to keep; type one',
    );
  });

  it('R-0294 should take typed words as typed, with or without an etag, and a stale etag with no keep (control)', () => {
    // Arrange
    const model = modelOf();

    // Act
    const typed = derive(model, putFlags(['--verbose', '--model=x'], 'stale'));
    const none = derive(model, putArgs(['a', 'b']));

    // Assert
    should(typed.model.components.settings.base?.flags).deepEqual(['--verbose', '--model=x']);
    should(none.model.components.mcp.gh?.args).deepEqual(['a', 'b']);
  });
});
