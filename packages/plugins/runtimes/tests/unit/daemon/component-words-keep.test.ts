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

// ── No keep moves a hidden value into sight (R-0294, ruling #39, review r1 F1) ─────────────────────────
//
// Whether a value is hidden can turn on the word before it (`--token`, `v`) or on an MCP server's command, and a keep
// carries the value without that word. So every kept word that was hidden as read must be hidden, and shown the same,
// where the edit puts it; otherwise the next `GET /v1/runtimes/components` would show it to every `fleet.use` caller.

describe('component.put — a keep never lands a hidden value where it would show (R-0294, ruling #39)', () => {
  const NEXT_FLAGS = ['--token', FAKE_SECRET];
  const NEXT_ARGS = ['srv', '--token', FAKE_SECRET];
  const nextModel = (): AccountModel => modelOf(NEXT_FLAGS, NEXT_ARGS);
  const FLAG_REFUSAL = 'settings base has no value for flag 2 to keep; type one';
  const ARG_REFUSAL = 'MCP server gh has no value for argument 3 to keep; type one';

  /** The app's own form for the MCP server, with its command line as a person edited it. */
  const editedLine = (model: AccountModel, edit: (line: string) => string) => {
    const draft = draftFromComponent(viewOf(model, 'mcp/gh'));
    return componentChange({ ...draft, body: edit(draft.body) }, false);
  };

  /** What the components read shows of the settings flags and the MCP arguments after an edit. */
  const shownAfter = (model: AccountModel): string =>
    JSON.stringify([viewOf(model, 'settings/base').detail, viewOf(model, 'mcp/gh').detail]);

  it('R-0294 should refuse a keep moved after a harmless flag, where the next read would show it (P1)', () => {
    // Arrange
    const model = nextModel();

    // Act
    const refusal = refusalOf(model, putFlags(['--model', { keep: true, at: 1 }], etagOf(model, 'settings/base')));

    // Assert
    should(refusal).equal(FLAG_REFUSAL);
  });

  it('R-0294 should refuse a duplicate keep whose copy would show, and take one whose copies all stay hidden (P2)', () => {
    // Arrange
    const model = nextModel();
    const etag = etagOf(model, 'settings/base');

    // Act
    const copied = refusalOf(model, putFlags(['--token', { keep: true, at: 1 }, { keep: true, at: 1 }], etag));
    const twice = derive(model, putFlags(['--token', { keep: true, at: 1 }, '--api-key', { keep: true, at: 1 }], etag));

    // Assert
    should(copied).equal(FLAG_REFUSAL);
    should(twice.model.components.settings.base?.flags).deepEqual(['--token', FAKE_SECRET, '--api-key', FAKE_SECRET]);
    should(shownAfter(twice.model)).not.containEql(FAKE_SECRET);
  });

  it('R-0294 should refuse the edit form deleting or renaming the flag in front of a hidden argument (P3, P4)', () => {
    // Arrange
    const model = nextModel();

    // Act — the app's own model: `npx srv --token ‹hidden›` edited as a person would.
    const deleted = editedLine(model, line => line.replace('--token ', ''));
    const renamed = editedLine(model, line => line.replace('--token', '--model'));

    // Assert — the form keeps the hidden word by position; the daemon refuses where it would land.
    should(deleted).containDeep({ component: { args: ['srv', { keep: true, at: 2 }] } });
    should(refusalOf(model, deleted)).equal(ARG_REFUSAL);
    should(refusalOf(model, renamed)).equal(ARG_REFUSAL);
  });

  it('R-0294 should refuse a word inserted between a secret-named flag and its kept value, flags and arguments', () => {
    // Arrange
    const model = nextModel();

    // Act
    const flag = refusalOf(
      model,
      putFlags(['--token', '--verbose', { keep: true, at: 1 }], etagOf(model, 'settings/base')),
    );
    const arg = refusalOf(
      model,
      editedLine(model, line => line.replace('--token', '--token --verbose')),
    );

    // Assert
    should([flag, arg]).deepEqual([FLAG_REFUSAL, ARG_REFUSAL]);
  });

  it('R-0294 should refuse a first argument kept under a new command, which it was hidden by', () => {
    // Arrange — the first argument is judged with the command before it.
    const model = parseAccountModel({
      version: 1,
      components: { mcp: { gh: { command: '--token', args: [FAKE_SECRET] } } },
      profiles: { p: { layers: ['mcp/gh'] } },
    });
    const etag = etagOf(model, 'mcp/gh');
    const keep = (command: string) => ({
      ...putArgs([]),
      component: { kind: 'mcp', command, args: [{ keep: true, at: 0 }], argsEtag: etag },
    });

    // Act
    const refusal = refusalOf(model, keep('npx'));
    const kept = derive(model, keep('--token'));

    // Assert
    should(refusal).equal('MCP server gh has no value for argument 1 to keep; type one');
    should(kept.model.components.mcp.gh?.args).deepEqual([FAKE_SECRET]);
  });

  it('R-0294 should refuse a keep that would show part of what was hidden whole, even with a cut left in it', () => {
    // Arrange — after `--token` the whole word is hidden; after `--model` only its nested key's value would be.
    const model = modelOf(['--token', `a=1,api_key=${FAKE_SECRET}`]);
    const etag = etagOf(model, 'settings/base');

    // Act
    const refusal = refusalOf(model, putFlags(['--model', { keep: true, at: 1 }], etag));

    // Assert
    should(refusal).equal(FLAG_REFUSAL);
  });

  it('R-0294 should take a self-contained hidden word moved anywhere, and an untouched keep, as before (P5, control)', () => {
    // Arrange
    const model = modelOf([`--token=${FAKE_SECRET}`, '--token', FAKE_SECRET]);
    const etag = etagOf(model, 'settings/base');

    // Act
    const moved = derive(
      model,
      putFlags(['--model', { keep: true, at: 0 }, '--token', { keep: true, at: 2 }, { keep: true, at: 1 }], etag),
    );

    // Assert
    should(moved.model.components.settings.base?.flags).deepEqual([
      '--model',
      `--token=${FAKE_SECRET}`,
      '--token',
      FAKE_SECRET,
      '--token',
    ]);
    should(shownAfter(moved.model)).not.containEql(FAKE_SECRET);
  });
});
