/**
 * The card `agenda-ask-screenshot.ts` draws, in the chat (`agenda-page.tsx?headings=1`) and in the Inbox
 * (`inbox-page.tsx?view=open-headings`): a LONG ask, and a Markdown heading of every depth in the segments around it.
 * The ask must read as one short bold line at body size, and no heading may be drawn at a heading's size.
 */

export const HEADING_ASK_ID = 'A110';

const LONG_ASK =
  "What should change in &B131? You said it's working now, but you want more features, you don't want the catalog to be a back sheet or something, and the catalog looks ugly and doesn't tell you which catalog the skills are from (or filter by it)?";

const HEADINGS = (name: string): string =>
  `# ${name} one\nA line under the first level.\n## ${name} two\n- a point under the second\n### ${name} three\n#### ${name} four\n##### ${name} five\n###### ${name} six\nand then plain text`;

/** What an item needs on top of each harness's own base fields. */
export const HEADING_ASK_PATCH = {
  title: 'Catalog look',
  subject: LONG_ASK,
  kind: 'reply',
  ask: { kind: 'open-question' },
  premise: HEADINGS('Premise'),
  context: HEADINGS('Context'),
  decided: HEADINGS('Decided'),
  stillOpen: HEADINGS('Still open'),
  body: HEADINGS('More detail'),
} as const;
