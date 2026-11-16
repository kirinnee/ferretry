/**
 * Runs the daemon entry named by `HEAP_DAEMON_ENTRY` and samples this process's memory (see README.md in this folder).
 *
 *   HEAP_DAEMON_ENTRY=<repo>/packages/core/kernel/host/fyd.ts HEAP_OUT=<dir> FY_HOME=<home> \
 *     bun profile-daemon.ts --port <port>
 *
 * Every `HEAP_EVERY_MS` (default 3000) it appends a row to `<HEAP_OUT>/timeline.tsv`: seconds since start, RSS, the
 * anonymous part of it, the kernel's high-water mark (`VmHWM`, the PEAK, which an idle daemon's RSS hides) and the JS
 * object count. No forced collection, so a spike shows. It never exits by itself: stop it with a signal.
 */
import { heapStats } from 'bun:jsc';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const out = process.env.HEAP_OUT;
const entry = process.env.HEAP_DAEMON_ENTRY;
if (out === undefined || entry === undefined) throw new Error('HEAP_OUT and HEAP_DAEMON_ENTRY are required');
const every = Number(process.env.HEAP_EVERY_MS ?? 3000);

const kilobytes = (field: string): number => {
  const match = new RegExp(`${field}:\\s+(\\d+)`, 'u').exec(readFileSync('/proc/self/status', 'utf8'));
  return Math.round(Number(match?.[1] ?? 0) / 1024);
};

const started = Date.now();
writeFileSync(`${out}/timeline.tsv`, 'sec\trssMB\tanonMB\thwmMB\tobjects\n');
setInterval(() => {
  const seconds = Math.round((Date.now() - started) / 1000);
  const row = [seconds, kilobytes('VmRSS'), kilobytes('RssAnon'), kilobytes('VmHWM'), heapStats().objectCount];
  appendFileSync(`${out}/timeline.tsv`, `${row.join('\t')}\n`);
}, every);

// A variable specifier: this file names no daemon module, so it adds no edge to the import graph.
await import(pathToFileURL(entry).href);
