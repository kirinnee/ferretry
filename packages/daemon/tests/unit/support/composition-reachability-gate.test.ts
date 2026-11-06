import { describe, it } from 'bun:test';
import should from 'should';
import { moduleFacts } from '../../../../../scripts/validate/composition-reachability.ts';

/**
 * The reachability gate's reading of a `.tsx` module, on the shapes that let a dead module look mounted: what it
 * reads is what `scripts/validate/composition-reachability.sh` follows, so these are its planted violations.
 */

const specifiers = (code: string): readonly string[] => [...moduleFacts('example.tsx', code).specifiers].sort();
const exported = (code: string): readonly string[] => [...moduleFacts('example.tsx', code).localExports].sort();

describe('the reachability gate reading a TSX module', () => {
  it('should follow no import a block comment spells out', () => {
    should(specifiers("/*\nimport { unused } from './unused.ts';\n*/\nexport const root = 1;")).deepEqual([]);
  });

  it('should follow no import a line comment spells out', () => {
    should(
      specifiers("// import('./unused.ts');\n// import { unused } from './unused.ts';\nexport const root = 1;"),
    ).deepEqual([]);
  });

  it('should follow no dynamic import a string, a template or JSX text spells out', () => {
    const code = [
      'export const text = "import(\'./in-string.ts\')";',
      "export const template = `import('./in-template.ts')`;",
      "export const view = <p>import('./in-jsx-text.ts')</p>;",
    ].join('\n');
    should(specifiers(code)).deepEqual([]);
  });

  it('should follow the imports that are real', () => {
    const code = [
      "import { used } from './used.ts';",
      "export * from './star.ts';",
      "export const lazy = () => import('./lazy.ts');",
    ].join('\n');
    should(specifiers(code)).deepEqual(['./lazy.ts', './star.ts', './used.ts']);
  });

  it('should still see the exports that follow an apostrophe in JSX text', () => {
    const code = ["export const view = <p>don't</p>;", 'export const after = 1;', 'export default view;'].join('\n');
    should(exported(code)).deepEqual(['after', 'default', 'view']);
  });

  it('should read a type-only export of an imported name as a re-export of it', () => {
    const code = "import type { Shape } from './shape.ts';\nexport type { Shape };";
    const facts = moduleFacts('example.tsx', code);
    should([...facts.localExports]).deepEqual([]);
    should(facts.namedReexports.map(reexport => [reexport.specifier, [...reexport.names]])).deepEqual([
      ['./shape.ts', [['Shape', 'Shape']]],
    ]);
  });

  it('should read a namespace re-export and a renamed default re-export', () => {
    const facts = moduleFacts(
      'example.tsx',
      "export * as all from './all.ts';\nexport { default as Thing } from './thing.ts';",
    );
    should(facts.namespaceReexports.map(reexport => [reexport.specifier, reexport.alias])).deepEqual([
      ['./all.ts', 'all'],
    ]);
    should(facts.namedReexports.map(reexport => [reexport.specifier, [...reexport.names]])).deepEqual([
      ['./thing.ts', [['Thing', 'default']]],
    ]);
  });
});
