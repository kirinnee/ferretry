/**
 * The entry the H1 bundle assertion builds (`packages/app/tests/integration/durian-bundle.test.ts`): the pieces of the
 * hypermedia renderer that the seam must keep in order, imported the way the real renderer imports them — the strict
 * React entry (no mermaid, no DOMPurify), the stylesheet, and OUR `chart.js` (lazily, as the chart engine loads it) and `dompurify`, so a second copy of either
 * (Durian pins its own versions) would show up as a second banner in the output. Handing them to a global is what stops the
 * bundler dropping any of it (an app build keeps no entry exports).
 */
import DOMPurify from 'dompurify';
import { parse, setYamlParser, VERSION } from 'durian-hypermedia';
import { DhDocument } from 'durian-hypermedia/react/strict';
import 'durian-hypermedia/styles.css';

Object.assign(globalThis, {
  hypermediaBundle: { chart: () => import('chart.js'), DhDocument, DOMPurify, parse, setYamlParser, VERSION },
});
