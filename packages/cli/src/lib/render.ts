/** Plain-text layout helpers. No colour: output is read by people, scripts and agents alike. Pure. */

/** Left-aligned columns separated by two spaces; the last column is not padded. */
export function renderTable(header: readonly string[], rows: readonly (readonly string[])[]): string {
  const all = [header, ...rows];
  const widths = header.map((_, column) => Math.max(...all.map(row => (row[column] ?? '').length)));
  return all
    .map(row =>
      row
        .map((cell, column) => (column === row.length - 1 ? cell : cell.padEnd(widths[column] ?? 0)))
        .join('  ')
        .trimEnd(),
    )
    .join('\n');
}

