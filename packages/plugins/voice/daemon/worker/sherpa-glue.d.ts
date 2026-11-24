/**
 * `sherpa-glue.js` is a link to the Emscripten loader of `@sherpaw/asr` 0.3.0 (`dist/asr-*.js`), which that package's
 * exports map does not name and which Bun's `imports` refuses to point into `node_modules`. A link inside this folder
 * is a file of this half to the bundler, and the one place a bump of the package changes (its file name carries a hash).
 */
declare const initSherpa: (options: never) => Promise<unknown>;
export default initSherpa;
