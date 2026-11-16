import { expect, test } from 'bun:test';
import manifest from '../../../manifest.ts';

/**
 * `fy start --help` and `fy new --help` list `--compact-at <tokens|auto>` with v4 4.291.9's sentences, word for word
 * (ASCII apostrophes: the codepoints are checked, so a typographic quote cannot slip in).
 */
const declared = (line: string) => manifest.actions?.cli?.find(decl => decl.verb === line);

test.each([
  [
    'start [prompt...]',
    "squeeze this ferret's conversation at this many tokens (e.g. 250k); auto leaves the harness's own trigger",
  ],
  ['new [words...]', 'squeeze its conversation at this many tokens (e.g. 250k); auto leaves the default'],
])('%s lists --compact-at with v4’s sentence', (line, sentence) => {
  const option = declared(line)?.options?.find(each => each.flag === '--compact-at <tokens|auto>');
  expect(option?.help).toBe(sentence);
  expect(option?.help).not.toMatch(/[‘’]/u);
});
