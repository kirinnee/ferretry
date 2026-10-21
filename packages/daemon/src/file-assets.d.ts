/**
 * A file imported `with { type: 'file' }`: a path to read it from — the file in the source tree, or its
 * copy embedded in a compiled binary (`/$bunfs/…`). Never its contents.
 */
declare module '*.wasm' {
  const path: string;
  export default path;
}
