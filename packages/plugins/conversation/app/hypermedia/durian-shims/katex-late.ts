import { katexIfHere, needs } from './lazy-part.ts';

/**
 * KATEX, AS THE PARSER'S MATHS READS IT: a library that arrives when a message first has a formula (`lazy-part.ts`).
 *
 * `parts/math/render.ts` calls `katex.renderToString` at parse time, once per formula, and caches the tree it makes of the markup. This
 * stand-in is its `katex` import (`vite-durian.ts` redirects it). While the library is not here it names it and THROWS, which Durian
 * turns into a problem on that formula and, because the throw is before the tree is cached, never remembers; the worker loads KaTeX and
 * parses the message again (`durian-worker.ts`). It is ~77 KB gzip of the 333 KB the worker was.
 */
interface Katex {
  renderToString(tex: string, options: Readonly<Record<string, unknown>>): string;
}

export default {
  renderToString(tex: string, options: Readonly<Record<string, unknown>>): string {
    const katex = katexIfHere() as Katex | undefined;
    if (katex === undefined) {
      needs('katex');
      throw new Error('KaTeX has not arrived');
    }
    return katex.renderToString(tex, options);
  },
} satisfies Katex;
