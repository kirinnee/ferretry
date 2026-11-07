/** The qpdf engine is imported as a FILE, so a compiled binary embeds it and the path is one inside the binary. */
declare module '@neslinesli93/qpdf-wasm/dist/qpdf.wasm' {
  const path: string;
  export default path;
}
