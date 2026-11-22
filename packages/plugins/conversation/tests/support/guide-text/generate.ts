/**
 * Writes `cli/reading/guide-text.ts` from the `## Guide for agents` section of docs/hypermedia.md — the ONE source of
 * what `fy render guide` prints. A compiled binary has no repository beside it, so the text ships as a constant; this
 * script is the only way that constant is made, and `tests/unit/cli/guide-drift.test.ts` fails a commit where the
 * constant and the doc disagree.
 *
 *   bun packages/plugins/conversation/tests/support/guide-text/generate.ts
 *
 * Lives under tests/ because it reads and writes files, which a plugin's runtime halves may not (banned-globals).
 */

const HEADING = '## Guide for agents';

/**
 * The section as the CLI ships it: from its heading line to the `---` that closes it, with a newline before and after.
 * `undefined` when the doc has no such heading or the section is never closed.
 */
export function guideSectionOf(doc: string): string | undefined {
  const lines = doc.split('\n');
  const start = lines.indexOf(HEADING);
  if (start === -1) return undefined;
  const end = lines.indexOf('---', start + 1);
  if (end === -1) return undefined;
  return `\n${lines.slice(start, end + 1).join('\n')}\n`;
}

/** A template-literal body: the backslash, the backtick and `${` escaped, everything else as written. */
const escapeTemplate = (text: string): string =>
  text.replace(/\\/gu, '\\\\').replace(/`/gu, '\\`').replace(/\$\{/gu, '\\${');

const HEADER = `/**
 * The guide \`fy render guide\` prints: the \`## Guide for agents\` section of docs/hypermedia.md, from its heading line to
 * the \`---\` that closes it, GENERATED — never edited here. The doc owns the text; this constant only ships it in the
 * compiled binary, because a release has no repository beside it. Edit the doc, then run
 * \`bun packages/plugins/conversation/tests/support/guide-text/generate.ts\`; \`tests/unit/cli/guide-drift.test.ts\` fails
 * the commit that lets the two disagree.
 *
 * The section carries no example fence of the \`fy-render\` kind on purpose: this file is source, where
 * scripts/validate/no-fy-render-in-docs.sh refuses a fence opener.
 */
`;

/** The whole source of guide-text.ts for one section. */
export const guideTextModule = (section: string): string =>
  `${HEADER}export const RENDER_GUIDE_SECTION = \`${escapeTemplate(section)}\`;\n`;

if (import.meta.main) {
  const root = new URL('../../../../../../', import.meta.url);
  const section = guideSectionOf(await Bun.file(new URL('docs/hypermedia.md', root)).text());
  if (section === undefined) throw new Error('docs/hypermedia.md has no closed "## Guide for agents" section');
  await Bun.write(new URL('packages/plugins/conversation/cli/reading/guide-text.ts', root), guideTextModule(section));
}
