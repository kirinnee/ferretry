import { describe, test } from 'bun:test';
import should from 'should';
import { cellText, remarkTableLabels } from '../../src/lib/remark-table-labels.ts';

/**
 * The plugin reads mdast and nothing else, so the trees here are hand-built: the
 * shapes `remark-gfm` produces for a table, plus the degenerate ones a real
 * document can still contain. The end-to-end pipeline (remark-gfm → this plugin →
 * a rendered `<td data-label>`) is asserted in `markdown.test.tsx`.
 */

interface MdNode {
  type: string;
  value?: string;
  children?: MdNode[];
  data?: { hProperties?: Record<string, unknown> };
}

const cell = (value: string): MdNode => ({ type: 'tableCell', children: [{ type: 'text', value }] });
const row = (...values: string[]): MdNode => ({ type: 'tableRow', children: values.map(cell) });
const table = (...rows: MdNode[]): MdNode => ({ type: 'table', children: rows });
const labelsOf = (node: MdNode): unknown[] =>
  (node.children ?? []).map(child => child.data?.hProperties?.['data-label']);

describe('cellText', () => {
  test('should read plain text', () => {
    // Assert
    should(cellText({ type: 'text', value: 'Path' })).equal('Path');
  });

  test('should flatten formatted header content', () => {
    // Arrange
    const header: MdNode = {
      type: 'tableCell',
      children: [
        { type: 'text', value: 'exit ' },
        { type: 'strong', children: [{ type: 'inlineCode', value: 'code' }] },
      ],
    };

    // Assert
    should(cellText(header)).equal('exit code');
  });

  test('should read an empty cell as an empty string', () => {
    // Assert
    should(cellText({ type: 'tableCell' })).equal('');
  });
});

describe('remarkTableLabels', () => {
  test('should stamp every body cell with its column header', () => {
    // Arrange
    const tree = { type: 'root', children: [table(row('Path', 'Note', 'N'), row('/a/b', 'hi', '3'))] };

    // Act
    remarkTableLabels()(tree);

    // Assert — the header row itself is untouched.
    const built = tree.children[0] as MdNode;
    should(labelsOf((built.children ?? [])[0] as MdNode)).deepEqual([undefined, undefined, undefined]);
    should(labelsOf((built.children ?? [])[1] as MdNode)).deepEqual(['Path', 'Note', 'N']);
  });

  test('should collapse whitespace in a multi-part header', () => {
    // Arrange
    const tree = { type: 'root', children: [table(row('Full   Name', 'X'), row('Ann', '1'))] };

    // Act
    remarkTableLabels()(tree);

    // Assert
    should(labelsOf(((tree.children[0] as MdNode).children ?? [])[1] as MdNode)).deepEqual(['Full Name', 'X']);
  });

  test('should leave a cell with no header at its column index unlabelled', () => {
    // Arrange — a body row wider than the header, which malformed markdown yields.
    const tree = { type: 'root', children: [table(row('Only'), row('a', 'b'))] };

    // Act
    remarkTableLabels()(tree);

    // Assert
    should(labelsOf(((tree.children[0] as MdNode).children ?? [])[1] as MdNode)).deepEqual(['Only', undefined]);
  });

  test('should find a table nested inside other block structure', () => {
    // Arrange
    const tree = {
      type: 'root',
      children: [
        { type: 'blockquote', children: [table(row('A'), row('1'))] },
        { type: 'paragraph', children: [{ type: 'text', value: 'after' }] },
      ],
    };

    // Act
    remarkTableLabels()(tree);

    // Assert
    const nested = ((tree.children[0] as MdNode).children ?? [])[0] as MdNode;
    should(labelsOf((nested.children ?? [])[1] as MdNode)).deepEqual(['A']);
  });

  test('should leave a header-only table alone', () => {
    // Arrange
    const tree = { type: 'root', children: [table(row('A', 'B'))] };

    // Act
    remarkTableLabels()(tree);

    // Assert
    should((tree.children[0] as MdNode).children).have.length(1);
  });

  test('should ignore a table with no rows at all', () => {
    // Arrange
    const tree = { type: 'root', children: [{ type: 'table' }] };

    // Act & Assert
    should(() => remarkTableLabels()(tree)).not.throw();
  });

  test('should leave a document with no table untouched', () => {
    // Arrange
    const tree = { type: 'root', children: [{ type: 'paragraph', children: [{ type: 'text', value: 'prose' }] }] };

    // Act
    remarkTableLabels()(tree);

    // Assert
    should(tree).deepEqual({
      type: 'root',
      children: [{ type: 'paragraph', children: [{ type: 'text', value: 'prose' }] }],
    });
  });

  test('should never clobber an author-set data-label', () => {
    // Arrange
    const tree = { type: 'root', children: [table(row('A'), row('1'))] };
    const target = (((tree.children[0] as MdNode).children ?? [])[1] as MdNode).children?.[0] as MdNode;
    target.data = { hProperties: { 'data-label': 'preset' } };

    // Act
    remarkTableLabels()(tree);

    // Assert
    should(target.data?.hProperties?.['data-label']).equal('preset');
  });

  test('should add its attribute alongside an existing hProperties bag', () => {
    // Arrange
    const tree = { type: 'root', children: [table(row('A'), row('1'))] };
    const target = (((tree.children[0] as MdNode).children ?? [])[1] as MdNode).children?.[0] as MdNode;
    target.data = { hProperties: { className: 'kept' } };

    // Act
    remarkTableLabels()(tree);

    // Assert
    should(target.data?.hProperties).deepEqual({ className: 'kept', 'data-label': 'A' });
  });
});
