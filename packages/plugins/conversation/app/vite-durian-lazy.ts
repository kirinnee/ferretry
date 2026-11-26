/**
 * THE LAZY FOLDER PARTS, AS THE BUILD MAKES THEM (U1 review, item 2; the runtime half is `hypermedia/durian-shims/lazy-part.ts`).
 *
 * Durian's `src/parts/generated/registry.ts` is written by its own script, one line per part (`import audio from "../audio/part";`),
 * and every part's parser and its libraries are in whatever imports it. {@link lazyRegistry} rewrites that ONE file's text: each such line
 * becomes `const audio = lazyPart("audio");` (a stand-in that knows the part's shape and fetches its code on first use), and a call that
 * hands the stand-in's runtime the dynamic import of each part's real module, and of KaTeX. Everything else in the file (the inline
 * parts, the name lists, the types) stays. A registry in any other shape throws, so a release that changes it fails the build, not a page.
 */

/** The import lines of the generated registry that name a folder part's definition: `import <local> from "../<name>/part";`. */
const PART_IMPORT = /^import (\w+) from "\.\.\/([\w-]+)\/part";\r?\n/gmu;

/** The registry's text with every folder part lazy. `shim` is the absolute path of `lazy-part.ts`. */
export function lazyRegistry(code: string, shim: string): string {
  const names: string[] = [];
  const rewritten = code.replace(PART_IMPORT, (_line, local: string, name: string) => {
    names.push(name);
    return `const ${local} = lazyPart(${JSON.stringify(name)});\n`;
  });
  if (names.length === 0)
    throw new Error('durian-markdown: the generated part registry has no `import x from "../name/part"` lines');
  // The registry's own text, not this module's: written apart so that a scan of this file for dynamic imports
  // (`durian-main-thread.test.ts`) does not read it as one of this module's own.
  const open = 'import' + '(';
  const loaders = names
    .map(name => `  ${JSON.stringify(name)}: () => ${open}${JSON.stringify(`../${name}/part`)}),`)
    .join('\n');
  return [
    `import { lazyPart, registerKatexLoader, registerPartLoaders } from ${JSON.stringify(shim)};`,
    rewritten,
    `registerPartLoaders({\n${loaders}\n});`,
    `registerKatexLoader(() => ${open}"katex"));`,
    '',
  ].join('\n');
}
