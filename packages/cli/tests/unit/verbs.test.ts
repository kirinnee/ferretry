import { describe, it } from 'bun:test';
import { definePlugin, verb } from '@ferretry/kernel/manifest';
import should from 'should';
import { renderRootHelp } from '../../src/lib/help.ts';
import { buildVerbTable, expandAlias, resolveVerb, verbWords } from '../../src/lib/verbs.ts';
import { boardEntry, entry, registryOf, skeletonEntry } from './fakes.ts';

describe('verb table', () => {
  it('should keep only the typed words of a declared line', () => {
    should(verbWords('card move <id> [--to lane]')).deepEqual(['card', 'move']);
  });

  it('should resolve the longest run of leading words, leaving the rest as arguments', () => {
    const table = buildVerbTable(registryOf(boardEntry()));
    const moved = resolveVerb(table, ['card', 'move', 'c1', '--to', 'done']);
    should(moved.kind === 'verb' && moved.entry.line).equal('card move');
    should(moved.kind === 'verb' && moved.rest).deepEqual(['c1', '--to', 'done']);
    const board = resolveVerb(table, ['board', '--all']);
    should(board.kind === 'verb' && board.entry.owner).equal('board');
  });

  it('should name the verbs under the same first word when the second is mistyped', () => {
    const table = buildVerbTable(registryOf(boardEntry()));
    const unknown = resolveVerb(table, ['card', 'nope']);
    should(unknown.kind).equal('unknown');
    should(unknown.kind === 'unknown' && unknown.nearby.map(near => near.line)).deepEqual(['card show', 'card move']);
  });

  it('should keep the shell’s own verb lines and leave out a plugin line that repeats one', () => {
    const clash = definePlugin({
      id: 'clash',
      title: 'Clash',
      version: '5.0.0',
      api: 5,
      core: false,
      kinds: ['command'],
      actions: { cli: [verb('doctor'), verb('daemon config')] },
    });
    const table = buildVerbTable(registryOf(skeletonEntry(clash)));
    should(table.conflicts).deepEqual([{ line: 'doctor', owner: 'clash', keptFrom: 'shell' }]);
    // A plugin may add a verb under a shell-owned first word.
    should(resolveVerb(table, ['daemon', 'config']).kind).equal('verb');
  });

  it('should expand a data plugin alias into the verb line it runs, carrying the arguments', () => {
    const aliasPlugin = definePlugin({
      id: 'quick',
      title: 'Quick',
      version: '5.0.0',
      api: 5,
      core: false,
      kinds: ['command'],
      actions: { cli: [verb('done', { alias: 'card move --to done' })] },
    });
    const table = buildVerbTable(registryOf(skeletonEntry(aliasPlugin)));
    const done = resolveVerb(table, ['done', 'c9']);
    should(done.kind === 'verb' && expandAlias(done.entry, done.rest)).deepEqual([
      'card',
      'move',
      '--to',
      'done',
      'c9',
    ]);
  });

  it('should list every owner’s verbs in help, under its title', () => {
    const table = buildVerbTable(registryOf(boardEntry()));
    const help = renderRootHelp('fy', table, { board: 'Board' });
    should(help).containEql('Usage: fy <verb>');
    should(help).containEql('Board\n  card show');
    should(help).containEql('The shell\n  plugin list');
  });

  it('should skip a declaration that has no typed words', () => {
    const odd = definePlugin({
      id: 'odd',
      title: 'Odd',
      version: '5.0.0',
      api: 5,
      core: false,
      kinds: ['command'],
      actions: { cli: [verb('<id>')] },
    });
    should(
      buildVerbTable(
        registryOf(
          entry(odd, 'h', async () => {
            throw new Error('unused');
          }),
        ),
      ).entries.some(e => e.owner === 'odd'),
    ).be.false();
  });
});
