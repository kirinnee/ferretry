/**
 * The shell's font files arrive as built URLs (`CODE_FACE_URLS` from `@ferretry/app`); the shell's bundler resolves
 * the `.woff2` imports behind them, and this root program has no bundler types to say so.
 */
declare module '*.woff2' {
  const url: string;
  export default url;
}
