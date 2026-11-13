/**
 * remark plugin: stamp every body cell of a GFM table with `data-label`, the text
 * of its column's header.
 *
 * WHY THIS EXISTS. On a phone a 4-5 column markdown table cannot show its header
 * row and its cells side by side without squashing every column into an unreadable
 * sliver. The mobile layout breaks each row into a stacked card, and each cell
 * then needs to name its own column — otherwise a bare value ("3",
 * "/etc/hosts") is meaningless once the header row is out of sight.
 * `content: attr(data-label)` in the stacked layout prints that name (see
 * `src/styles/index.css`, the `.md table` mobile block).
 *
 * The label is derived here, at parse time, from the header row itself, so it
 * always matches the real header text (including when a header is renamed) and the
 * sighted-user label can never drift from the screen-reader header. It is applied
 * via `data.hProperties`, the mdast→hast contract `mdast-util-to-hast` honours, so
 * the attribute lands on the rendered `<td>` with no DOM walking.
 *
 * Header association for assistive tech does NOT depend on this attribute — that
 * is carried by the real `<th scope="col">` plus the explicit ARIA roles the
 * Markdown renderer sets, which survive the `display:block` the stacked layout
 * applies. `data-label` is the VISUAL echo for sighted phone users only.
 *
 * Ported from kteam's `src/lib/remark-table-labels.ts`, unchanged in behaviour:
 * it reads only mdast and knows nothing about daemons.
 */

// Minimal structural types — we read only what a GFM table node exposes and never
// import the full mdast typings (they are transitive here, not a direct
// dependency).
interface MdNode {
  type: string;
  value?: string;
  children?: MdNode[];
  data?: { hProperties?: Record<string, unknown> };
}

/**
 * Concatenate the visible text of an inline subtree (text and inlineCode carry a
 * `value`; everything else is a wrapper we recurse through).
 */
export const cellText = (node: MdNode): string =>
  typeof node.value === 'string' ? node.value : (node.children ?? []).map(cellText).join('');

/** Whitespace collapses so a wrapped header still yields a single clean label. */
const normalize = (value: string): string => value.replace(/\s+/gu, ' ').trim();

/**
 * Depth-first walk collecting every `table` node. Tables never nest, but they can
 * sit at any depth (inside a list item, a blockquote), so a full walk is the
 * honest way to find them all.
 */
const collectTables = (node: MdNode, out: MdNode[]): void => {
  if (node.type === 'table') out.push(node);
  for (const child of node.children ?? []) collectTables(child, out);
};

/**
 * The plugin. The first `tableRow` is the header; every later row's cells inherit
 * the header text at their column index as `data-label`.
 */
export const remarkTableLabels =
  () =>
  (tree: MdNode): void => {
    const tables: MdNode[] = [];
    collectTables(tree, tables);
    for (const table of tables) {
      const [header, ...body] = table.children ?? [];
      if (!header) continue;
      const labels = (header.children ?? []).map(cell => normalize(cellText(cell)));
      for (const row of body) {
        (row.children ?? []).forEach((cell, column) => {
          const label = labels[column];
          if (!label) return;
          cell.data ??= {};
          cell.data.hProperties ??= {};
          // Never clobber an author-set attribute; markdown cannot set one today,
          // but the guard keeps this composable.
          cell.data.hProperties['data-label'] ??= label;
        });
      }
    }
  };
