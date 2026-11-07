/**
 * The shell's font files arrive as built URLs (`CODE_FACE_URLS` and the theme faces from `@ferretry/app`); the
 * shell's bundler resolves the `.woff2` imports behind them, and a TypeScript program has no bundler types to say so.
 */
declare module '*.woff2' {
  const url: string;
  export default url;
}
