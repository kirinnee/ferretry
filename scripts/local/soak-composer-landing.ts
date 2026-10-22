/**
 * Sends N messages into a REAL Claude Code pane through the daemon's own delivery path
 * (`TmuxPaneDelivery.deliver` over the control-mode transport the daemon uses), while the harness
 * process is throttled, and reports how many landed, how many failed and how many reached the
 * transcript twice.
 *
 * It exists because "the turn did not land in the composer" only shows up on a slow host, and a slow
 * host is something a unit test can only describe. Two throttles, combinable:
 *
 *   --stop-ms/--run-ms  SIGSTOP the pane's process tree for stop-ms, SIGCONT it for run-ms, forever —
 *                       a crude cpulimit, and the shape of a Mac that naps a background process.
 *   --hogs N            pin the pane's process tree and N busy loops to ONE cpu with taskset.
 *   --capture-delay-ms  answer every capture and cursor read this much later, uniformly 0.4–1.2× of it:
 *                       the owner's Mac, where one pane capture takes 0.2–0.6 s.
 *
 * The transcript is the referee: every message carries a unique tag, and once the run is over each tag
 * is counted among the transcript's user records. 0 is a lost message, 2+ a duplicate. Sends are paced
 * the way a person sends them: the next one goes once the last is in the transcript (or 60 s passed).
 *
 * Manual only. Linux, tmux and a logged-in Claude Code config dir. Costs one small model turn per
 * message, so it defaults to Haiku with a system prompt asking for a one-word reply.
 *
 *   bun scripts/local/soak-composer-landing.ts --config-dir <CLAUDE_CONFIG_DIR> [--count 200]
 *     [--stop-ms 0] [--run-ms 100] [--hogs 0] [--long-every 0] [--width 100] [--height 40]
 *     [--model claude-haiku-4-5-20251001] [--work /tmp/fy-composer-soak] [--record frames.json]
 *
 * `--record` keeps every frame the first SLOW send's fill and submit read — one whose echo took over a
 * second — with screen, cursor, and the milliseconds since it was first typed: how the sequences under
 * `packages/daemon/tests/fixtures/composer/` were captured.
 */
import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { BunTmuxProcess } from '../../packages/daemon/src/adapters/tmux/bun-tmux-process.ts';
import { ControlModeTmuxProcess } from '../../packages/daemon/src/adapters/tmux/control-tmux-process.ts';
import { TmuxPaneDelivery } from '../../packages/daemon/src/adapters/tmux/pane-delivery.ts';
import type { TmuxCommandPort, TmuxCommandResult } from '../../packages/daemon/src/lib/tmux/contracts.ts';
import { readComposer } from '../../packages/daemon/src/lib/tmux/composer-screen.ts';
import { TmuxController } from '../../packages/daemon/src/lib/tmux/controller.ts';

const { values } = parseArgs({
  options: {
    'config-dir': { type: 'string' },
    count: { type: 'string', default: '200' },
    'stop-ms': { type: 'string', default: '0' },
    'run-ms': { type: 'string', default: '100' },
    hogs: { type: 'string', default: '0' },
    'long-every': { type: 'string', default: '0' },
    width: { type: 'string', default: '100' },
    height: { type: 'string', default: '40' },
    model: { type: 'string', default: 'claude-haiku-4-5-20251001' },
    work: { type: 'string', default: '/tmp/fy-composer-soak' },
    record: { type: 'string' },
    'capture-delay-ms': { type: 'string', default: '0' },
  },
});
const configDir = values['config-dir'] ?? process.env.CLAUDE_CONFIG_DIR;
if (configDir === undefined) throw new Error('--config-dir (or CLAUDE_CONFIG_DIR) names a logged-in Claude config');
const count = Number(values.count);
const stopMs = Number(values['stop-ms']);
const runMs = Number(values['run-ms']);
const hogs = Number(values.hogs);
const longEvery = Number(values['long-every']);
const captureDelayMs = Number(values['capture-delay-ms']);
const work = values.work;
const cwd = join(work, 'cwd');
const socket = join(work, 'tmux.sock');
const session = 'fy-soak';
const executable = Bun.which('tmux');
if (executable === null) throw new Error('tmux is not on PATH');

await rm(work, { recursive: true, force: true });
await mkdir(cwd, { recursive: true });

/** Every send-keys / paste stamped, so the first frame showing a payload can be timed against it. */
const typedAt = new Map<string, number>();
const shownAt = new Map<string, number>();
let current: string | undefined;
let typings = 0;
/** The first send's frames, for `--record`: what each capture showed, and when relative to the typing. */
const recorded: { atMs: number; command: string; stdout: string; key?: string }[] = [];
let recording = values.record !== undefined;
let recordStart = 0;

/** The daemon's transport, watched: counts typings and times the echo without changing a byte. */
class Observed implements TmuxCommandPort {
  constructor(private readonly inner: TmuxCommandPort) {}
  async execute(arguments_: readonly string[], stdin?: string): Promise<TmuxCommandResult> {
    const result = await this.inner.execute(arguments_, stdin);
    const [command] = arguments_;
    if (captureDelayMs > 0 && (command === 'capture-pane' || command === 'display-message'))
      await Bun.sleep(captureDelayMs * (0.4 + Math.random() * 0.8));
    if (recording && current !== undefined && command !== undefined) {
      const typed = typedAt.get(current);
      if (typed === undefined && recordStart === 0) recordStart = performance.now();
      const atMs = Math.round(performance.now() - (typed ?? recordStart));
      if (command === 'capture-pane' || command === 'display-message')
        recorded.push({ atMs: typed === undefined ? -1 : atMs, command, stdout: result.stdout });
      else if (command === 'send-keys' || command === 'paste-buffer')
        recorded.push({ atMs, command, stdout: '', key: String(arguments_.at(-1)) });
    }
    if (
      current !== undefined &&
      (command === 'paste-buffer' || (command === 'send-keys' && arguments_.includes('-l')))
    ) {
      typings++;
      if (!typedAt.has(current)) typedAt.set(current, performance.now());
    }
    if (current !== undefined && command === 'capture-pane' && !shownAt.has(current) && typedAt.has(current))
      if (result.stdout.replace(/\s+/gu, '').includes(current)) shownAt.set(current, performance.now());
    return result;
  }
}

const spawned = new BunTmuxProcess(executable, socket);
const created = await spawned.execute([
  'new-session',
  '-d',
  '-s',
  session,
  '-x',
  values.width,
  '-y',
  values.height,
  '-c',
  cwd,
  '-e',
  `CLAUDE_CONFIG_DIR=${configDir}`,
  // A shell between tmux and Claude, deliberately not exec'd: tmux SIGCONTs a pane process the moment
  // it stops, so the throttle stops Claude, the shell's child, where tmux never sees it.
  'sh',
  '-c',
  'claude "$@"; exit $?',
  'sh',
  '--model',
  values.model,
  '--append-system-prompt',
  'Whatever the user writes, reply with exactly the single word: ok. Never use tools.',
]);
if (created.code !== 0) throw new Error(`tmux new-session failed: ${created.stderr}`);
await spawned.execute(['set-option', '-t', session, 'remain-on-exit', 'on']);
const control = new ControlModeTmuxProcess(executable, socket, spawned);
const tmux = new TmuxController(new Observed(control));
const delivery = new TmuxPaneDelivery(tmux, milliseconds => Bun.sleep(milliseconds));

const panePid = Number((await spawned.execute(['display-message', '-p', '-t', session, '#{pane_pid}'])).stdout.trim());

async function processTree(root: number): Promise<number[]> {
  const out = await Bun.$`pgrep -P ${root}`.nothrow().quiet().text();
  const children = out.split('\n').filter(Boolean).map(Number);
  return [root, ...(await Promise.all(children.map(processTree))).flat()];
}

/** A process in the tree may exit between listing and signalling it. */
function signal(pid: number, name: 'SIGSTOP' | 'SIGCONT'): void {
  try {
    process.kill(pid, name);
  } catch {
    // Gone already.
  }
}

let throttling = true;
const hogProcesses: { kill(): void }[] = [];
if (hogs > 0) {
  for (const pid of await processTree(panePid)) await Bun.$`taskset -pc 0 ${pid}`.nothrow().quiet();
  for (let index = 0; index < hogs; index++)
    hogProcesses.push(Bun.spawn(['taskset', '-c', '0', 'sh', '-c', 'while :; do :; done'], { stdout: 'ignore' }));
}
const throttle = (async () => {
  if (stopMs <= 0) return;
  while (throttling) {
    const pids = (await processTree(panePid)).slice(1);
    if (process.env.SOAK_DEBUG) process.stderr.write(`throttle ${panePid} ${pids.join(',')}\n`);
    for (const pid of pids) signal(pid, 'SIGSTOP');
    await Bun.sleep(stopMs);
    for (const pid of pids) signal(pid, 'SIGCONT');
    await Bun.sleep(runMs);
  }
})();

function payload(index: number, tag: string): string {
  const words = 'look thru the emails for the summary of the valkey operator call and what we agreed';
  if (longEvery > 0 && index % longEvery === longEvery - 1)
    return `${tag} ${Array.from({ length: 12 }, (_unused, line) => `line ${line}: ${words}`).join('\n')}`;
  return `${tag} ${words.slice(0, 20 + ((index * 37) % (words.length - 20)))}`;
}

const outcomes: { tag: string; ok: boolean; error?: string; ms: number; echoMs?: number; typings: number }[] = [];
/** Copies of each failed send's tag the composer held once the pane caught up: 2+ is a typed duplicate. */
const stranded = new Map<string, number>();

/**
 * After a failure: let a stalled pane catch up, keep the screen, count the copies of the payload sitting
 * in the composer, then erase them so the next send starts from an empty composer again — one failure
 * must not turn every later send into an "occupied composer" refusal and hide what THEY would have done.
 */
async function strandedAfter(tag: string): Promise<void> {
  await Bun.sleep(Math.max(3_000, stopMs * 2));
  const screen = await tmux.capture(session, false);
  await Bun.write(join(work, `failure-${tag}.txt`), screen);
  const composer = readComposer(screen) ?? { text: '' };
  stranded.set(tag, composer.text.replace(/\s+/gu, '').split(tag).length - 1);
  for (let key = 0; key < 40; key++) {
    const frame = await tmux.state(session, { history: false });
    const reading = readComposer(frame.visible, { x: frame.cursorX, y: frame.cursorY });
    if (reading === undefined || reading.text === '' || reading.placeholder === true) break;
    await tmux.sendKey(session, 'C-u');
    await Bun.sleep(Math.max(250, stopMs + runMs));
  }
}
const runTag = Math.random().toString(36).slice(2, 6);
// Claude 2.1.281's folder-trust screen puts `❯ No, exit` first; answered here so the run starts at a
// composer rather than measuring the daemon's dialog handling.
for (let look = 0; look < 40; look++) {
  const screen = await tmux.capture(session, false);
  if (/❯ Yes, I trust this folder/iu.test(screen)) {
    await tmux.sendKey(session, 'Enter');
    break;
  }
  if (/trust this folder/iu.test(screen)) {
    await Bun.sleep(1_000);
    await tmux.sendKey(session, 'Down');
  }
  if (/^❯ /mu.test(screen)) break;
  await Bun.sleep(250);
}
try {
  await delivery.waitReady(session);
  for (let index = 0; index < count; index++) {
    const tag = `soak${runTag}n${String(index).padStart(3, '0')}x`;
    current = tag;
    typings = 0;
    const started = performance.now();
    try {
      await delivery.deliver(session, payload(index, tag));
      outcomes.push({ tag, ok: true, ms: performance.now() - started, typings, ...echo(tag) });
      await inTranscript(tag, 60_000);
    } catch (error) {
      const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      outcomes.push({ tag, ok: false, error: message, ms: performance.now() - started, typings, ...echo(tag) });
      process.stdout.write(`\n${tag} FAILED ${message}\n`);
      await strandedAfter(tag);
    }
    current = undefined;
    if (recording && values.record !== undefined) {
      const last = outcomes.at(-1);
      if (last !== undefined && (!last.ok || (last.echoMs ?? 0) > 1_000)) {
        recording = false;
        await Bun.write(values.record, `${JSON.stringify(recorded, null, 1)}\n`);
      }
      recorded.length = 0;
      recordStart = 0;
    }
    process.stdout.write(outcomes.at(-1)?.ok === true ? '.' : 'F');
  }
} finally {
  throttling = false;
  await throttle;
  for (const pid of await processTree(panePid).catch(() => [])) signal(pid, 'SIGCONT');
  for (const hog of hogProcesses) hog.kill();
}

/** Every user record's text across this run's transcripts. */
async function transcriptUserTexts(): Promise<string[]> {
  const projects = join(configDir as string, 'projects');
  const texts: string[] = [];
  for (const project of await readdir(projects).catch(() => [] as string[])) {
    if (!project.includes(work.split('/').at(-1) as string)) continue;
    for (const file of await readdir(join(projects, project)).catch(() => [] as string[])) {
      if (!file.endsWith('.jsonl')) continue;
      for (const line of (await readFile(join(projects, project, file), 'utf8')).split('\n')) {
        if (!line.includes(runTag)) continue;
        const record = JSON.parse(line) as { type?: string; message?: { content?: unknown } };
        if (record.type !== 'user') continue;
        const content = record.message?.content;
        texts.push(typeof content === 'string' ? content : JSON.stringify(content));
      }
    }
  }
  return texts;
}

async function inTranscript(tag: string, withinMs: number): Promise<void> {
  for (let waited = 0; waited < withinMs; waited += 500) {
    if ((await transcriptUserTexts()).some(text => text.includes(tag))) return;
    await Bun.sleep(500);
  }
}

function echo(tag: string): { echoMs?: number } {
  const typed = typedAt.get(tag);
  const shown = shownAt.get(tag);
  return typed === undefined || shown === undefined ? {} : { echoMs: shown - typed };
}

// Let the last turn reach the transcript, then count every tag among the user records.
await delivery.waitReady(session).catch(() => undefined);
await Bun.sleep(3_000);
const userTexts = await transcriptUserTexts();
const seen = (tag: string): number => userTexts.filter(text => text.includes(tag)).length;
const lost = outcomes.filter(outcome => seen(outcome.tag) === 0);
const duplicated = outcomes.filter(outcome => seen(outcome.tag) > 1);
const falseFailures = outcomes.filter(outcome => !outcome.ok && seen(outcome.tag) === 1);
const percentile = (values: number[], p: number): number =>
  values.toSorted((a, b) => a - b)[Math.min(values.length - 1, Math.floor((p / 100) * values.length))] ?? Number.NaN;
const echoes = outcomes.flatMap(outcome => (outcome.echoMs === undefined ? [] : [outcome.echoMs]));
const totals = outcomes.map(outcome => outcome.ms);
const summary = {
  sent: outcomes.length,
  succeeded: outcomes.filter(outcome => outcome.ok).length,
  failed: outcomes.filter(outcome => !outcome.ok).length,
  inTranscriptOnce: outcomes.filter(outcome => seen(outcome.tag) === 1).length,
  lost: lost.length,
  duplicated: duplicated.length,
  failedButDelivered: falseFailures.length,
  retyped: outcomes.filter(outcome => outcome.typings > 1).length,
  strandedCopies: Object.fromEntries(stranded),
  echoMs: { p50: percentile(echoes, 50), p95: percentile(echoes, 95), max: Math.max(...echoes) },
  deliverMs: { p50: percentile(totals, 50), p95: percentile(totals, 95), max: Math.max(...totals) },
  throttle: { stopMs, runMs, hogs, captureDelayMs },
  errors: [...new Set(outcomes.flatMap(outcome => (outcome.error === undefined ? [] : [outcome.error])))],
};
process.stdout.write(`\n${JSON.stringify(summary, null, 2)}\n`);
control.close();
await spawned.execute(['kill-server']);
