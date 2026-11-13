/**
 * The Mermaid half of the sandbox shell's trusted library bundle.
 *
 * This file exists to be BUNDLED, never to be imported by the application. It
 * is an input to `../build-fy-render-libs.ts`, whose output is inlined into the
 * generated `public/fy-render-sandbox.html` shell. Nothing under `src/` may
 * import `mermaid`: the library is a build-time input to one static asset,
 * which is what keeps it out of the app bundle and out of every surface that is
 * not the opaque sandbox frame.
 *
 * `mermaid` resolves to the ESM build that lazily `import()`s each diagram
 * grammar. The bundler runs WITHOUT code splitting precisely so those dynamic
 * imports are inlined into one file: a chunk left on disk would be a subresource
 * the frame has to fetch, and the frame is not allowed to issue a request at
 * all. `build-fy-render-libs.ts` asserts the built bundle retains no `import(`.
 */
import mermaid from 'mermaid';

(globalThis as unknown as Record<string, unknown>).__fyRenderMermaid = mermaid;
