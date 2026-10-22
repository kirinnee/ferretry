// The Vosk glue as the Vosk worker imports it: `voskEvalFreeGlue` in `vite.config.ts` rewrites the package's
// `dist/vosk.worker.js` at build time into an ES module whose default export is Emscripten's
// `LoadVosk` factory. The package declares no types for that file, so its one export is named here.

declare module '@lichess-org/vosk-browser/dist/vosk.worker.js' {
  /** Starts one Vosk runtime. `wasmBinary` is the compiled binary's bytes, so nothing is fetched. */
  export default function LoadVosk(options: {
    readonly wasmBinary: Uint8Array;
    readonly print?: (message: string) => void;
    readonly printErr?: (message: string) => void;
  }): Promise<unknown>;
}
