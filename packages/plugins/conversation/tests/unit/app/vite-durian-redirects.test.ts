/**
 * r12 H8 fix — THE DURIAN IMPORTS THE BUILD REDIRECTS. The parser's chart reader (`./chart`, `./chart-llm`) and its scene
 * compiler (`./scene`, `./core/scene`) are resolved to our stand-ins (`app/hypermedia/durian-shims/`), and nothing else is. The
 * second half reads the INSTALLED source: the pin-bump checklist (`app/vite-durian.ts`) is only as good as a test that fails when
 * a new Durian moves one of these imports, which would put the evaluator and the compiler back into every first load unseen.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { redirectedImport } from '../../../app/vite-durian.ts';

const root = dirname(
  createRequire(join(import.meta.dir, '../../../package.json')).resolve('durian-markdown/package.json'),
);
const source = (path: string): string => readFileSync(join(root, 'src', path), 'utf8');
const shim = (name: string): string => join(import.meta.dir, '../../../app/hypermedia/durian-shims', name);

describe('redirectedImport', () => {
  it('sends the parser’s chart reader to the held stand-in', () => {
    expect(redirectedImport('./chart', join(root, 'src/core/dh-lib.ts'), root)).toBe(shim('chart-held.ts'));
    expect(redirectedImport('./chart-llm', join(root, 'src/core/dh-lib.ts'), root)).toBe(shim('chart-held.ts'));
  });

  it('sends the parser’s scene compiler to the door that opens when the animation arrives', () => {
    expect(redirectedImport('./scene', join(root, 'src/core/dh-lib.ts'), root)).toBe(shim('scene-late.ts'));
    expect(redirectedImport('./core/scene', join(root, 'src/document.ts'), root)).toBe(shim('scene-late.ts'));
  });

  it('sends the chip widths’ one import of the compiler (`textW`) to the stand-in, so the alignment grid does not pull the compiler', () => {
    expect(redirectedImport('./scene', join(root, 'src/core/chipw.ts'), root)).toBe(shim('text-width.ts'));
    expect(redirectedImport('./other', join(root, 'src/core/chipw.ts'), root)).toBeNull();
  });

  it('0.7.0: sends every parser-side chart reader import in core/ (dh-lib, chart11, pagecharts, doccheck) to the held stand-in', () => {
    for (const importer of ['dh-lib', 'chart11', 'pagecharts', 'doccheck'])
      expect(redirectedImport('./chart', join(root, `src/core/${importer}.ts`), root)).toBe(shim('chart-held.ts'));
    expect(redirectedImport('./chart11', join(root, 'src/core/doccheck.ts'), root)).toBe(shim('chart-held.ts'));
  });

  it('0.7.0: sends the composed-stage compiler (document, dh-lib, doccheck) to the held stand-in, and `inlineText` to its one-function copy', () => {
    expect(redirectedImport('./core/stage', join(root, 'src/document.ts'), root)).toBe(shim('stage-held.ts'));
    expect(redirectedImport('./core/stage-part', join(root, 'src/document.ts'), root)).toBe(shim('stage-held.ts'));
    expect(redirectedImport('./stage-part', join(root, 'src/core/dh-lib.ts'), root)).toBe(shim('stage-held.ts'));
    expect(redirectedImport('./stage-part', join(root, 'src/core/doccheck.ts'), root)).toBe(shim('stage-held.ts'));
    expect(redirectedImport('../markdown', join(root, 'src/react/markdown.tsx'), root)).toBe(shim('inline-text.ts'));
    expect(redirectedImport('../markdown', join(root, 'src/react/document.tsx'), root)).toBeNull();
  });

  it('leaves the renderer’s own imports alone: the compiler lives in the animation chunk, the chart renderer is unused', () => {
    expect(redirectedImport('../core/scene', join(root, 'src/ui/anim.tsx'), root)).toBeNull();
    expect(redirectedImport('../core/chart', join(root, 'src/ui/chart.tsx'), root)).toBeNull();
    expect(redirectedImport('./chart', undefined, root)).toBeNull();
    // Outside `core/` a `./chart` is not the parser's: the renderer's own `ui/` files keep theirs.
    expect(redirectedImport('./chart', join(root, 'src/ui/chart-axes.tsx'), root)).toBeNull();
    expect(redirectedImport('./stage', join(root, 'src/core/stage-part.ts'), root)).toBeNull();
  });
});

describe('the installed Durian still makes the imports that are redirected', () => {
  it('dh-lib imports its chart reader, chart table and scene compiler by these specifiers', () => {
    const text = source('core/dh-lib.ts');
    expect(text).toContain('from "./chart"');
    expect(text).toContain('from "./chart-llm"');
    expect(text).toContain('from "./scene"');
  });

  it('document imports the scene compiler by this specifier', () => {
    expect(source('document.ts')).toContain('from "./core/scene"');
  });

  it('the chip widths import `textW` from the compiler, and nothing else from it', () => {
    expect(source('core/chipw.ts')).toMatch(/^import \{ textW \} from "\.\/scene";$/mu);
  });

  it('the scene compiler exports what the door binds', () => {
    const text = source('core/scene.ts');
    for (const name of ['compileScene', 'sceneLlm', 'KINDS'])
      expect(text).toMatch(new RegExp(`export (function|const) ${name}\\b`, 'u'));
  });
});
