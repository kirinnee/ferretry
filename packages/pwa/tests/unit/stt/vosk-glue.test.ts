/**
 * Proves the build-time rewrite of Vosk's Emscripten glue (`voskEvalFreeGlue` in `vite.config.ts`): over the INSTALLED
 * package it keeps the glue alone, leaves nothing that builds code from a string, and exports
 * `LoadVosk`; a glue whose shape moved stops the build rather than shipping half-patched; and the
 * plugin touches the one module it is for. The file it rewrites is pinned by hash, so a package bump
 * is a conscious re-audit. (That the rewritten glue really runs with the `Function` constructor
 * poisoned is `tests/unit/stt/vosk-glue-runtime.test.ts`.)
 */

import { describe, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import should from 'should';
import { evalFreeVoskGlue, voskEvalFreeGlue } from '../../../vite.config.ts';

const PWA_DIR = join(import.meta.dir, '..', '..', '..');
const GLUE_PATH = join(
  dirname(Bun.resolveSync('@lichess-org/vosk-browser/package.json', PWA_DIR)),
  'dist',
  'vosk.worker.js',
);
const source = readFileSync(GLUE_PATH, 'utf8');
/** `@lichess-org/vosk-browser@0.0.3`'s `dist/vosk.worker.js`, audited for this rewrite. */
const AUDITED_GLUE_SHA256 = '24c215a4e2ab2288541596f43c8fd789b4c23c9a1ebe8e09e16da871176a82eb';

const INVOKER = 'var invokerFn = newFunc(Function, args)(...closureArgs);';
const CALLER = 'var invokerFunction = newFunc(Function, params)(...args);';

describe('evalFreeVoskGlue over the installed package', () => {
  const out = evalFreeVoskGlue(source);

  it('rewrites exactly the file it was audited against', () => {
    should(createHash('sha256').update(source).digest('hex')).equal(AUDITED_GLUE_SHA256);
  });

  it('leaves nothing that builds code from a string', () => {
    should(source).containEql(INVOKER);
    should(source).containEql(CALLER);
    should(out).not.containEql('newFunc(Function');
    should(out).not.containEql('new Function');
    should(out).containEql('var invokerFn = function(...callArgs) {');
    should(out).containEql('var invokerFunction = function(obj, func, destructorsRef, args) {');
  });

  it('keeps the Emscripten module alone, exported, without the package’s own worker', () => {
    should(source).containEql('new RecognizerWorker();');
    should(out).not.containEql('RecognizerWorker');
    should(out).not.containEql('downloadAndExtract(fullModelUrl');
    should(out.endsWith('var vosk_default = LoadVosk;\nexport default LoadVosk;\n')).be.true();
  });
});

describe('evalFreeVoskGlue refuses a glue whose shape moved', () => {
  const without = (anchor: string): string => source.replace(anchor, '');

  it('names each missing anchor', () => {
    should(() => evalFreeVoskGlue('var nothing;')).throw(/end of the Emscripten module is not in the glue.*re-audit/u);
    should(() => evalFreeVoskGlue(without('      args.push(invokerFnBody);\n'))).throw(
      /string-built invoker is not in the glue/u,
    );
    should(() =>
      evalFreeVoskGlue(without('      var functionBody = `return function (obj, func, destructorsRef, args) {')),
    ).throw(/string-built method caller is not in the glue/u);
    should(() => evalFreeVoskGlue(without(`      ${CALLER}`))).throw(
      /end of the string-built method caller is not in the glue/u,
    );
  });

  it('refuses an anchor that appears twice', () => {
    const end = 'var vosk_default = LoadVosk;';
    should(() => evalFreeVoskGlue(`${source}\n${end}`)).throw(
      /end of the Emscripten module is in the glue more than once/u,
    );
  });

  it('refuses a method caller whose end comes before its start', () => {
    const start = '      var functionBody = `return function (obj, func, destructorsRef, args) {';
    const end = `      ${CALLER}`;
    const moved = source.replace(end, '').replace(start, `${end}\n${start}`);
    should(() => evalFreeVoskGlue(moved)).throw(/the method caller is not where it was/u);
  });

  it('refuses a glue that would still build code from a string', () => {
    const glueEnd = source.indexOf('var vosk_default = LoadVosk;');
    const extra = `${source.slice(0, glueEnd)}var sneaky = new Function("return 1");\n${source.slice(glueEnd)}`;
    should(() => evalFreeVoskGlue(extra)).throw(/code built from a string is still in the glue/u);
  });
});

describe('the fy-vosk-eval-free-glue plugin', () => {
  it('rewrites the package’s glue, whatever the query, and leaves every other module alone', () => {
    should(voskEvalFreeGlue.enforce).equal('pre');
    const out = voskEvalFreeGlue.transform(source, GLUE_PATH);
    should(out).equal(evalFreeVoskGlue(source));
    should(voskEvalFreeGlue.transform(source, `${GLUE_PATH}?v=1`)).equal(out);
    should(voskEvalFreeGlue.transform(source, '/repo/src/other.js')).be.undefined();
    should(
      voskEvalFreeGlue.transform(source, '/repo/node_modules/@lichess-org/vosk-browser/dist/vosk.wasm.js'),
    ).be.undefined();
  });
});
