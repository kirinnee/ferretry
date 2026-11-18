import type { Plugin } from 'vite';

/**
 * PREFETCH EVERY PLUGIN VIEW CHUNK, so no navigation waits on a download. A plugin's views are code-split
 * (`import('./views/…')`, loaded the first time a view is drawn), which is right for the first paint but made every first
 * visit to a screen wait for its chunk. They ship with the app anyway, so the built page asks the browser to fetch them
 * at idle once the page has loaded (`public/prefetch-views.js` adds the `<link rel="prefetch">` tags: after the first
 * paint, never before it, never competing with it), into the HTTP cache the later `import()` reads from. The tags are
 * made at runtime so a reader who asked to save data (Save-Data, a 2g-class connection, `prefers-reduced-data`) gets none.
 *
 * Which chunks: the dynamic entries of the app page that come from a plugin or core app half, plus the shared chunks
 * those import and the page does not already load. NOT the heavy optional ones (on-device speech, diagram and map
 * libraries, workers): those stay on demand, over `HEAVY`. A bundle with no such chunk (a dev server) gets no links.
 */
const HEAVY = /(voice|vosk|onnx|mermaid|lottie|leaflet|worker|fy-render|speech|model)/iu;
/** Past this a chunk is not "a view"; it is a library that happens to be split. */
const MAX_CHUNK_BYTES = 400_000;

export function prefetchViewChunks(): Plugin {
  return {
    name: 'fy-prefetch-view-chunks',
    transformIndexHtml: {
      order: 'post',
      handler(html, ctx) {
        const bundle = ctx.bundle;
        if (bundle === undefined || !/app[\\/]index\.html$/u.test(ctx.filename)) return html;
        const chunks = Object.values(bundle).filter(item => item.type === 'chunk');
        const byFile = new Map(chunks.map(chunk => [chunk.fileName, chunk]));
        // What the page loads up front: its entry chunk and everything that one imports statically.
        const eager = new Set<string>();
        const walkEager = (file: string): void => {
          if (eager.has(file)) return;
          eager.add(file);
          for (const next of byFile.get(file)?.imports ?? []) walkEager(next);
        };
        for (const chunk of chunks)
          if (chunk.isEntry && ctx.chunk?.fileName === chunk.fileName) walkEager(chunk.fileName);
        const wanted = new Set<string>();
        const want = (file: string): void => {
          const chunk = byFile.get(file);
          if (chunk === undefined || eager.has(file) || wanted.has(file)) return;
          if (HEAVY.test(file) || HEAVY.test(chunk.facadeModuleId ?? '') || chunk.code.length > MAX_CHUNK_BYTES) return;
          wanted.add(file);
          for (const next of chunk.imports) want(next);
        };
        for (const chunk of chunks) {
          const from = (chunk.facadeModuleId ?? '').replaceAll('\\', '/');
          if (chunk.isDynamicEntry && /\/packages\/(plugins|core)\/[^/]+\/app\//u.test(from)) want(chunk.fileName);
        }
        if (wanted.size === 0) return html;
        const chunkList = [...wanted].sort().join(',');
        return html.replace(
          '</head>',
          `    <script defer src="/prefetch-views.js" data-chunks="${chunkList}"></script>\n  </head>`,
        );
      },
    },
  };
}
