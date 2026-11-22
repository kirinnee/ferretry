/**
 * Durian Hypermedia's stylesheet, scoped under `.dh-doc` by the package's own build (`vite-durian.ts` makes it; the
 * package ships no `dist/`). Loaded with the Conversation surfaces, which draw every `HypermediaProse` in this plugin. A
 * module of its own so that a unit test of the renderer, which has no stylesheet pipeline, never imports it.
 */
import 'durian-hypermedia/styles.css';
// After the package's own sheet, so the theme (`dh-theme.css`) is the later word wherever specificity ties.
import './dh-theme.css';
