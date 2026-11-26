import { setYamlParser } from 'durian-markdown';

/**
 * DURIAN'S ONE HOST SETTING: no YAML is read in a message (r12 H8 fix, lead decision on size).
 *
 * Durian reads YAML through a parser the host gives it (`durian-markdown/src/host/yaml.ts`: the browser has no `Bun.YAML`,
 * and Durian ships none). Measured on the pinned release, the only things in a message that reach it are a leading front
 * matter block (this app reads none: `frontMatter: false`) and a ```chart fence's data, and every chart fence is held as code
 * before Durian reads it (`held-fences.tsx`). The alignment, tier list, animation, terminal, file tree, editor, tabs, accordion
 * and mermaid parts have readers of their own. So no part we draw needs a YAML parser, and the repository's bounded reader
 * (`@ferretry/std/yaml`: a size cap, an alias budget, no YAML 1.1 tags) was ~29 KB gzip of every first load for a call nothing
 * makes.
 *
 * The parser Durian is given REFUSES, which is the stricter form of the same lock: if an upstream release (or an author) ever
 * reaches it, the throw becomes a problem on that part, which is not drawn from it. A part that truly needs YAML brings its
 * reader with it, lazily, in the PR that draws that part.
 *
 * Call it once before the first `parse`; calling it again is harmless.
 */
export function configureDurian(): void {
  setYamlParser(() => {
    throw new Error('YAML is not read in a message');
  });
}
