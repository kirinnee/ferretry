import { readFileSync } from 'node:fs';
import { parse, UNTRUSTED_LIMITS } from 'durian-markdown';

/**
 * DURIAN'S OWN `parse` OF EACH OF THE SAMPLES NAMED ON THE COMMAND LINE, in a process of its own (`lazy-worker.test.ts` reads the answer):
 * the real registry with every part in it, and none of the product's locks (`app/hypermedia/durian.ts` refuses YAML for the rest of a
 * process, and the test process has run it). Prints one JSON object, `{ "<file>": <document> }`.
 */
const documents: Record<string, unknown> = {};
for (const file of Bun.argv.slice(2))
  documents[file] = parse(readFileSync(file, 'utf8'), { frontMatter: false, limits: UNTRUSTED_LIMITS });
process.stdout.write(JSON.stringify(documents));
