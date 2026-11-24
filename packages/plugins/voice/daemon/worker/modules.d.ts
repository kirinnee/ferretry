declare module 'onnxruntime-web/ort-wasm-simd-threaded.mjs' {
  /** The loader's file: a path in a source checkout, a path inside the binary once compiled. */
  const path: string;
  export default path;
}
declare module 'sherpa-onnx/sherpa-onnx-wasm-nodejs.js' {
  /** The Emscripten loader: resolves with the module once its WebAssembly is instantiated. */
  const init: (options: {
    wasmBinary: Uint8Array;
    locateFile(file: string): string;
    print(text: string): void;
    printErr(text: string): void;
  }) => Promise<unknown>;
  export default init;
}
declare module 'sherpa-onnx/sherpa-onnx-tts.js' {
  export interface Generated {
    readonly samples: Float32Array;
    readonly sampleRate: number;
  }
  export interface OfflineTts {
    readonly sampleRate: number;
    generate(request: { text: string; sid: number; speed: number }): Generated;
    free(): void;
  }
  export function createOfflineTts(module: unknown, config: unknown): OfflineTts;
}
