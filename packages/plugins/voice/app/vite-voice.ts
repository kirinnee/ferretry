import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

/**
 * What this app half's build needs from the app shell's Vite config: Vosk's Emscripten glue made eval-free, and the
 * resolutions its speech workers import by name. A plugin's `build.ts` is not a thing 5.0 has yet, so the shell's single
 * Vite config spreads {@link voiceBuild} into its own `worker` and `resolve.alias`.
 */

/**
 * `@sherpaw/asr`'s own files the sherpa worker needs and its exports map does not name: the Emscripten loader, which
 * takes the WebAssembly binary as bytes, and the binary itself, emitted under `/assets/` and fetched only by an Install
 * (`lib/stt/sherpa-models.ts`). Both are files of the exact version `package.json` pins; a version bump that renames
 * the loader fails this build. Resolved from THIS package, which owns the dependency.
 */
const SHERPA_DIST = dirname(createRequire(import.meta.url).resolve('@sherpaw/asr'));

/**
 * VOSK'S JAVASCRIPT GLUE, MADE EVAL-FREE AT BUILD TIME — the worker transform behind the Vosk speech
 * worker (`src/worker/vosk-worker.ts`), beside Leaflet's for the same reason: a third-party module
 * that cannot run under the page's policy is fixed in the bundle, never by loosening the policy.
 *
 * `@lichess-org/vosk-browser` ships its Emscripten glue (`LoadVosk`, the module that compiles
 * `vosk.wasm` and binds Kaldi's classes) inside `dist/vosk.worker.js`, a complete worker of its own.
 * Two things in that file cannot run in this app:
 *
 *   1. EMBIND BUILDS FUNCTIONS FROM STRINGS. Its invoker for every bound method
 *      (`craftInvokerFunction`) and its JS-method caller (`__emval_get_method_caller`) are generated
 *      with `new Function(…)`. The page's policy has `'wasm-unsafe-eval'` and NOT `'unsafe-eval'`, and
 *      it requires Trusted Types for scripts, so each of those throws an `EvalError` and the module
 *      never finishes starting. Emscripten has an eval-free form of both (its `DYNAMIC_EXECUTION=0`
 *      build); this transform swaps in closures that do exactly what the generated code does —
 *      convert each argument to its wire type, call the C++ invoker, run the destructors, convert the
 *      result back — so the policy stays as strict as it is.
 *   2. THE FILE IS A WORKER, NOT A LIBRARY. Its tail starts ccoreilly's message protocol
 *      (`new RecognizerWorker()`), which downloads the model itself and keeps it in IndexedDB. Our
 *      worker never downloads and answers its own protocol, so only the glue is kept — the file up to
 *      `var vosk_default = LoadVosk;` — and exported as the module's default.
 *
 * Every anchor must match EXACTLY ONCE or the build fails: a new package version is a conscious
 * re-audit, never a silently half-patched runtime. The installed file is pinned by hash in
 * `tests/unit/app/stt/vosk-glue.test.ts` for the same reason, and
 * `tests/unit/app/stt/vosk-glue-runtime.test.ts` runs the result on the real binary.
 */
const GLUE_END = 'var vosk_default = LoadVosk;';

/** Embind's string-built invoker for every bound function and method… */
const INVOKER_FROM = `      let [args, invokerFnBody] = createJsInvoker(argTypes, isClassMethodFunc, returns, isAsync);
      args.push(invokerFnBody);
      var invokerFn = newFunc(Function, args)(...closureArgs);
      return createNamedFunction(humanName, invokerFn);`;

/** …and the closure that does what `createJsInvoker`'s generated body does, without `new Function`. */
const INVOKER_TO = `      var invokerFn = function(...callArgs) {
        var destructors = needsDestructorStack ? [] : null;
        var thisWired;
        var argsWired = [];
        var wired = [cppTargetFunc];
        if (isClassMethodFunc) {
          thisWired = argTypes[1]["toWireType"](destructors, this);
          wired.push(thisWired);
        }
        for (var i = 0; i < argCount - 2; ++i) {
          argsWired.push(argTypes[i + 2]["toWireType"](destructors, callArgs[i]));
          wired.push(argsWired[i]);
        }
        var rv = cppInvokerFunc(...wired);
        if (needsDestructorStack) {
          runDestructors(destructors);
        } else {
          for (var i = isClassMethodFunc ? 1 : 2; i < argTypes.length; ++i) {
            if (argTypes[i].destructorFunction !== null) argTypes[i].destructorFunction(i === 1 ? thisWired : argsWired[i - 2]);
          }
        }
        if (returns) return argTypes[0]["fromWireType"](rv);
      };
      return createNamedFunction(humanName, invokerFn);`;

/** The string-built caller C++ uses to call a JavaScript method (`ArchiveHelper`'s callbacks)… */
const CALLER_START = '      var functionBody = `return function (obj, func, destructorsRef, args) {';
const CALLER_END = '      var invokerFunction = newFunc(Function, params)(...args);';

/** …and its closure form: read each argument from the stack, call, hand the result back. */
const CALLER_TO = `      var invokerFunction = function(obj, func, destructorsRef, args) {
        var offset = 0;
        var values = kind === 0 ? [obj] : [];
        for (var i = 0; i < argCount; ++i) {
          values.push(types[i].readValueFromPointer(args + offset));
          offset += types[i].argPackAdvance;
        }
        var rv = kind === 1 ? new func(...values) : func.call(...values);
        if (!retType.isVoid) return emval_returnValue(retType, destructorsRef, rv);
      };`;

/** Anything left that would build code from a string at run time. */
const DYNAMIC_CODE = /new Function\b|newFunc\(\s*Function\b|\beval\(/u;

const fail = (what: string): never => {
  throw new Error(`fy-vosk-glue: ${what}; re-audit @lichess-org/vosk-browser's glue before upgrading it`);
};

/** The index of `anchor` in `text`, which must hold it exactly once. */
const once = (text: string, anchor: string, name: string): number => {
  const at = text.indexOf(anchor);
  if (at < 0) fail(`the ${name} is not in the glue`);
  if (text.includes(anchor, at + anchor.length)) fail(`the ${name} is in the glue more than once`);
  return at;
};

/** The glue alone, eval-free, as an ES module whose default export is `LoadVosk`. Pure. */
export function evalFreeVoskGlue(source: string): string {
  const glue = source.slice(0, once(source, GLUE_END, 'end of the Emscripten module') + GLUE_END.length);
  const invoker = once(glue, INVOKER_FROM, 'string-built invoker');
  const withInvoker = glue.slice(0, invoker) + INVOKER_TO + glue.slice(invoker + INVOKER_FROM.length);
  const callerStart = once(withInvoker, CALLER_START, 'string-built method caller');
  const callerEnd = once(withInvoker, CALLER_END, 'end of the string-built method caller') + CALLER_END.length;
  if (callerEnd < callerStart) fail('the method caller is not where it was');
  const out = withInvoker.slice(0, callerStart) + CALLER_TO + withInvoker.slice(callerEnd);
  if (DYNAMIC_CODE.test(out)) fail('code built from a string is still in the glue');
  return `${out}\nexport default LoadVosk;\n`;
}

/** The module the Vosk worker imports the glue from. */
const VOSK_GLUE_MODULE = /[\\/]@lichess-org[\\/]vosk-browser[\\/]dist[\\/]vosk\.worker\.js(?:\?|$)/u;

export const voskEvalFreeGlue = {
  name: 'fy-vosk-eval-free-glue',
  enforce: 'pre' as const,
  transform(code: string, id: string): string | undefined {
    return VOSK_GLUE_MODULE.test(id) ? evalFreeVoskGlue(code) : undefined;
  },
};

/**
 * WHAT THE SHELL'S VITE CONFIG TAKES FROM VOICE (the part of today's PWA `vite.config.ts` that was about speech):
 *
 *   - `worker`: a MODULE worker, because Parakeet's bundle has a lazy chunk (parakeet.js reaches ONNX Runtime through a
 *     dynamic import) and Vite's default classic-worker format cannot split one. Workers are bundled by a build of
 *     their own, so a transform one of them needs is named HERE: {@link voskEvalFreeGlue}.
 *   - `alias`: `onnxruntime-web` resolves to its WASM-ONLY build. parakeet.js imports the bare package, whose default
 *     build is the WebGPU one — a 12 MB runtime plus a 27 MB asyncify binary, over Cloudflare Pages' 25 MiB per-file
 *     limit (the deploy failed from 2026-10-23 until this alias), and the pinned int8 encoder cannot run on WebGPU
 *     anyway. Whisper's transformers.js imports `onnxruntime-web/webgpu`; that subpath goes to `wasm` too, so the
 *     library and every worker share the one build the workers configure. The sherpa pair names the loader and binary
 *     {@link SHERPA_DIST} holds.
 */
export const voiceBuild = {
  worker: { format: 'es' as const, plugins: () => [voskEvalFreeGlue] },
  alias: [
    { find: /^onnxruntime-web(?:\/webgpu)?$/u, replacement: 'onnxruntime-web/wasm' },
    { find: /^sherpa-glue$/u, replacement: join(SHERPA_DIST, 'asr-B3QtWJoU.js') },
    { find: /^sherpa-runtime-wasm/u, replacement: join(SHERPA_DIST, 'prebuilt', 'asr.wasm') },
  ],
};
