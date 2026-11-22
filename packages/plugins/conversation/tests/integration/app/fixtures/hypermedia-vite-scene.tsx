/**
 * The parts scene (`hypermedia-parts-scene.tsx`) for a build by the app shell's own Vite (`tests/support/vite-scene.ts`), with the
 * stylesheet import the Conversation surfaces make beside every `HypermediaProse`. It is the REAL one: the same module and the
 * same package `sideEffects` entry that keep Durian's CSS in the app's build, so a scene built from this has the CSS a page is
 * given, not a copy of it injected beside the bundle.
 */
import '../../../../app/hypermedia/dh-styles.ts';
import './hypermedia-parts-scene.tsx';
