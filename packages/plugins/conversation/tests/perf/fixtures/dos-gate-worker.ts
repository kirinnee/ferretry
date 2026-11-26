/**
 * THE GATE'S WORKER (`tests/perf/hypermedia-dos-gate.test.ts`): a real worker thread, so the pinned Durian is measured where the
 * product runs it, off the thread that waits. It reads each message two ways and reports what each took:
 *
 *  - `durian`: Durian's own `parse` with the caps and the policy the chat reads every message with, and NOTHING held: a chart is
 *    evaluated and an animation laid out by Durian itself, with the repository's bounded YAML reader under it. This is what the
 *    product will ask of Durian the day a hold is lifted, so it is what the gate measures.
 *  - `app`: the worker's own job (`answer`), the message exactly as the page asks for it, holds and limits included.
 *
 * It never throws: a throw is reported as one. The request is `{ id, text }`, the answer one object per request.
 */
import { readConfigText } from '@ferretry/std/yaml';
import { parse, setYamlParser, UNTRUSTED_LIMITS } from 'durian-markdown';
import { answer } from '../../../app/hypermedia/durian-answer.ts';
import { PARSER_LIMITS } from '../../../app/hypermedia/limits.ts';
import { hypermediaUrlPolicy } from '../../../app/hypermedia/url-policy.ts';

/** How many times each read is timed: the best is the answer (one sample measures the collector that falls in it). */
const RUNS = 3;

interface Timed {
  readonly ms: number;
  readonly grewMb: number;
  readonly threw: boolean;
  /** What came of it, for the report: block types and the first words of each error. */
  readonly outcome: readonly string[];
}

const useBoundedYaml = (): void =>
  setYamlParser(text => {
    const read = readConfigText(text);
    if (!read.ok) throw new Error(read.errors[0]?.message ?? 'the YAML could not be read');
    return read.read.value;
  });

function timed(run: () => readonly string[]): Timed {
  const rss = process.memoryUsage().rss;
  let best = Number.POSITIVE_INFINITY;
  let grew = 0;
  let outcome: readonly string[] = [];
  try {
    for (let at = 0; at < RUNS; at++) {
      const started = performance.now();
      outcome = run();
      best = Math.min(best, performance.now() - started);
      if (at === 0) grew = (process.memoryUsage().rss - rss) / 2 ** 20;
    }
    return { ms: best, grewMb: grew, threw: false, outcome };
  } catch (error) {
    return { ms: best, grewMb: grew, threw: true, outcome: [String(error)] };
  }
}

const durianRead = (text: string): readonly string[] => {
  useBoundedYaml();
  const doc = parse(text, {
    frontMatter: false,
    idPrefix: 'gate-',
    limits: { ...UNTRUSTED_LIMITS, ...PARSER_LIMITS },
    urlPolicy: hypermediaUrlPolicy,
  });
  return doc.blocks.map(block => (block.type === 'error' ? `error: ${block.message.slice(0, 60)}` : block.type));
};

const appRead = (text: string): readonly string[] => {
  const message = answer({ kind: 'read', id: 1, source: text, idPrefix: 'gate-', arriving: false });
  return [message.kind];
};

// One small read of each kind first, so what is timed is the work and not the engine starting.
timed(() => durianRead('# warm\n\n```chart\nkind: line\nseries:\n  - name: s\n    data: [1, 2]\n```'));
timed(() => appRead('# warm'));

const scope = self as unknown as {
  onmessage: ((event: { readonly data: unknown }) => void) | null;
  postMessage(message: unknown): void;
};
scope.onmessage = event => {
  const { id, text } = event.data as { readonly id: number; readonly text: string };
  scope.postMessage({ id, durian: timed(() => durianRead(text)), app: timed(() => appRead(text)) });
};
scope.postMessage({ ready: true });
