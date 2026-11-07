/** The bundled terminal face ships as a font file; the shell's bundler resolves the import to its built URL. */
declare module '*.woff2' {
  const url: string;
  export default url;
}
