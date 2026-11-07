/**
 * The page half of `stt-speed-bench.ts`: runs the shared benchmark runner (`speed-bench/runner.ts`) inside
 * the served app's real policy and hands back timings. Bundled by the driver; never part of the app.
 */
import { runBench } from '../speed-bench/runner.ts';
import { parseSpeedBenchReport } from '../../../../app/lib/stt/speed-bench-report.ts';

interface BenchWindow {
  __bench?: (options: Record<string, unknown>) => Promise<unknown>;
  __violations?: string[];
  __progress?: string[];
}

const page = globalThis as unknown as BenchWindow;
const violations: string[] = [];
const progress: string[] = [];
page.__violations = violations;
page.__progress = progress;
document.addEventListener('securitypolicyviolation', event =>
  violations.push(`${event.violatedDirective} ${event.blockedURI} ${event.sourceFile}:${event.lineNumber}`),
);

const assets = JSON.parse(document.getElementById('assets')?.textContent ?? 'null');

page.__bench = async (options: Record<string, unknown>) => {
  const report = await runBench(globalThis as never, assets, {
    ...(options as unknown as Parameters<typeof runBench>[2]),
    clipUrl: '/clip-5s.wav',
    progress: line => progress.push(line),
  });
  return parseSpeedBenchReport(report) ?? { error: 'the result did not match the timings-only schema' };
};
