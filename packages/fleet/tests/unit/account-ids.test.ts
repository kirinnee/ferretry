import { describe, it } from 'bun:test';
import should from 'should';
import {
  assignRuntimeIds,
  EMPTY_RUNTIME_IDS,
  parseRuntimeIds,
  RuntimeIdExhaustedError,
  type RuntimeIds,
  renameRuntimeId,
  resolveRuntimeReference,
  runtimeIdsPath,
  serializeRuntimeIds,
} from '../../src/lib/account/ids.ts';

const ID_A = '00000000-0000-4000-8000-00000000000a';
const ID_B = '00000000-0000-4000-8000-00000000000b';
const ID_C = '00000000-0000-4000-8000-00000000000c';

const minter = (...ids: string[]) => {
  const queue = [...ids];
  return () => queue.shift() ?? 'not-a-uuid';
};

const IDS: RuntimeIds = {
  version: 1,
  runtimes: {
    'claude-default': { id: ID_A, formerNames: ['claude-auto-default'], home: 'claude-auto-default' },
    'codex-default': { id: ID_B, formerNames: [] },
  },
};

describe('runtime ids', () => {
  it('should live directly under the fleet directory', () => {
    should(runtimeIdsPath('/fy/fleet')).equal('/fy/fleet/ids.json');
  });

  it('should read a document, defaulting what an older writer left out', () => {
    // Act
    const parsed = parseRuntimeIds({ version: 1, runtimes: { 'claude-default': { id: ID_A } } });

    // Assert
    should(parsed).eql({ version: 1, runtimes: { 'claude-default': { id: ID_A, formerNames: [] } } });
    should(parseRuntimeIds({ version: 1 })).eql(EMPTY_RUNTIME_IDS);
  });

  it('should refuse two runtimes claiming one id or one former name', () => {
    // Act / Assert
    should(() => parseRuntimeIds({ version: 1, runtimes: { a: { id: ID_A }, b: { id: ID_A } } })).throw(
      /both claim the id/,
    );
    should(() =>
      parseRuntimeIds({
        version: 1,
        runtimes: { a: { id: ID_A, formerNames: ['old'] }, b: { id: ID_B, formerNames: ['old'] } },
      }),
    ).throw(/both claim the former name/);
  });

  it('should serialise with sorted runtime names, so an unchanged file is byte-identical', () => {
    // Arrange
    const unsorted: RuntimeIds = {
      version: 1,
      runtimes: { zed: { id: ID_B, formerNames: [] }, abe: { id: ID_A, formerNames: [] } },
    };

    // Act
    const text = serializeRuntimeIds(unsorted);

    // Assert
    should(Object.keys(JSON.parse(text).runtimes)).eql(['abe', 'zed']);
    should(text.endsWith('}\n')).be.true();
  });

  it('should keep existing ids, mint new ones and drop runtimes no longer configured', () => {
    // Act
    const assigned = assignRuntimeIds(['claude-default', 'new-one'], IDS, minter(ID_C));

    // Assert
    should(assigned).eql({
      version: 1,
      runtimes: {
        'claude-default': IDS.runtimes['claude-default'],
        'new-one': { id: ID_C, formerNames: [] },
      },
    });
  });

  it('should mint again past an id that is taken or not a UUID', () => {
    // Act
    const assigned = assignRuntimeIds(['new-one'], IDS, minter(ID_A, 'nope', ID_C));

    // Assert
    should(assigned.runtimes['new-one']?.id).equal(ID_C);
  });

  it('should give up after repeated unusable ids', () => {
    // Act / Assert
    should(() => assignRuntimeIds(['new-one'], IDS, () => ID_A)).throw(RuntimeIdExhaustedError);
    should(() => assignRuntimeIds(['new-one'], IDS, () => ID_A)).throw(
      'could not mint an unused id for runtime "new-one"',
    );
  });

  it('should resolve a reference by name, then former name, then id', () => {
    // Act / Assert
    should(resolveRuntimeReference(IDS, 'codex-default')).match({ name: 'codex-default', matched: 'name' });
    should(resolveRuntimeReference(IDS, 'claude-auto-default')).match({
      name: 'claude-default',
      matched: 'former-name',
    });
    should(resolveRuntimeReference(IDS, ID_B)).match({ name: 'codex-default', matched: 'id' });
    should(resolveRuntimeReference(IDS, 'nobody')).be.undefined();
  });

  it('should move a renamed runtime’s entry to its new name and keep the old one resolving', () => {
    // Act
    const renamed = renameRuntimeId(IDS, 'claude-default', 'claude-main');

    // Assert
    should(renamed.runtimes['claude-default']).be.undefined();
    should(renamed.runtimes['claude-main']).eql({
      id: ID_A,
      formerNames: ['claude-auto-default', 'claude-default'],
      home: 'claude-auto-default',
    });
    should(resolveRuntimeReference(renamed, 'claude-default')).match({ name: 'claude-main', matched: 'former-name' });
    should(resolveRuntimeReference(renamed, 'claude-auto-default')).match({ name: 'claude-main' });
  });

  it('should take a name back out of the former names when a runtime is renamed back to it', () => {
    // Act
    const renamed = renameRuntimeId(IDS, 'claude-default', 'claude-auto-default');

    // Assert
    should(renamed.runtimes['claude-auto-default']).match({ id: ID_A, formerNames: ['claude-default'] });
  });

  it('should leave the ids as they are for a runtime never published, or a rename to the same name', () => {
    // Act / Assert
    should(renameRuntimeId(IDS, 'unpublished', 'other')).equal(IDS);
    should(renameRuntimeId(IDS, 'codex-default', 'codex-default')).equal(IDS);
  });
});
