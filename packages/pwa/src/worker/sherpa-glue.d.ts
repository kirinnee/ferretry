/**
 * The Emscripten loader of `@sherpaw/asr` (`dist/asr-*.js`), aliased in `vite.config.ts`. Only the
 * members `sherpa-worker.ts` uses are declared; the recognizer bindings take the module as given.
 */
declare module 'sherpa-glue' {
  import type { ASRModule } from '@sherpaw/asr';

  interface SherpaModuleOptions {
    readonly wasmBinary: Uint8Array;
    locateFile(file: string): string;
    print(text: string): void;
    printErr(text: string): void;
  }

  export interface SherpaModule extends ASRModule {
    FS_createPath(parent: string, path: string, canRead: boolean, canWrite: boolean): void;
    FS_createDataFile(
      parent: string,
      name: string,
      data: Uint8Array,
      canRead: boolean,
      canWrite: boolean,
      canOwn: boolean,
    ): void;
  }

  const initSherpa: (options: SherpaModuleOptions) => Promise<SherpaModule>;
  export default initSherpa;
}
