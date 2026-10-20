/**
 * The browser half of `relay-terminal-bench.ts`: the PWA's own stream client, painting into xterm.js.
 *
 * Bundled by the orchestrator and loaded into a real Chrome. It mints a device key the way the app
 * does, opens ONE §14 terminal stream over the carrier it is told to use, and times each keystroke
 * from the moment it is handed to the session to the animation frame after xterm has parsed the
 * redraw that shows it. Every instant is `performance.timeOrigin + performance.now()`, the clock the
 * orchestrator and the rendezvous stamp their own events with.
 */

import { type ConnectionMethod, toBase64Url } from '@ferretry/relay';
import { WebCryptoRelayCrypto } from '@ferretry/relay/adapters';
import { Terminal } from '@xterm/xterm';
import { daemonConnection } from '../src/lib/daemon-connection.ts';
import { browserRelayDial, openRelaySession } from '../src/lib/relay-carrier.ts';
import type { RelayStreamFrame, SessionDeviceClaim } from '../src/lib/relay-session.ts';

export interface BenchRunConfig {
  readonly daemonId: string;
  readonly deviceId: string;
  readonly method: ConnectionMethod;
  readonly path: string;
  readonly cols: number;
  readonly rows: number;
  /** The shell's prompt, exactly, so an echo can be told apart from anything else on screen. */
  readonly prompt: string;
  readonly keys: number;
  /** When set, `seq 1 <n>` is run after the keystrokes and timed until its last line is painted. */
  readonly throughputLines?: number;
  /** Keep the stream and the painted terminal on the page after the run, for a screenshot. */
  readonly hold?: boolean;
}

export interface BenchKey {
  readonly sentAt: number;
  /** When the frame that showed the echo arrived from the session. */
  readonly receivedAt: number;
  readonly parsedAt: number;
  readonly paintedAt: number;
}

export interface BenchPageResult {
  readonly keys: readonly BenchKey[];
  readonly throughput?: { readonly ms: number; readonly bytes: number; readonly frames: number };
  /** Why the run stopped short — a terminal that never painted is a RESULT here, not a crash. */
  readonly error?: string;
  /** Everything the stream delivered, whether or not the run finished. */
  readonly received: { readonly bytes: number; readonly frames: number };
}

const now = (): number => performance.timeOrigin + performance.now();
const crypto = new WebCryptoRelayCrypto();
let claim: SessionDeviceClaim | undefined;

async function device(deviceId: string): Promise<string> {
  const minted = await crypto.generateDeviceKey();
  claim = {
    deviceId,
    key: crypto.deviceKeyHandle(minted.privateKey),
    appSession: toBase64Url(crypto.randomBytes(16)),
  };
  return toBase64Url(minted.publicKeySpki);
}

interface Waiter {
  readonly test: () => boolean;
  readonly settle: (key: Omit<BenchKey, 'sentAt'>) => void;
}

async function run(config: BenchRunConfig): Promise<BenchPageResult> {
  if (claim === undefined) throw new Error('no device: call device() first');
  const host = document.createElement('div');
  document.body.append(host);
  const term = new Terminal({ cols: config.cols, rows: config.rows, scrollback: 5_000, theme: themeFor(dark()) });
  term.open(host);
  const waiters = new Set<Waiter>();
  let bytes = 0;
  let frames = 0;
  const onData = (frame: RelayStreamFrame): void => {
    if (frame.kind !== 'bytes') return;
    const receivedAt = now();
    bytes += frame.bytes.byteLength;
    frames += 1;
    term.write(frame.bytes, () => {
      const parsedAt = now();
      for (const waiter of [...waiters]) {
        if (!waiter.test()) continue;
        waiters.delete(waiter);
        requestAnimationFrame(() => waiter.settle({ receivedAt, parsedAt, paintedAt: now() }));
      }
    });
  };
  const until = async (test: () => boolean, timeoutMs: number, what: string): Promise<Omit<BenchKey, 'sentAt'>> =>
    await new Promise((settle, fail) => {
      const timer = setTimeout(() => {
        waiters.delete(waiter);
        fail(new Error(`timed out waiting for ${what}; cursor line is ${JSON.stringify(cursorLine())}`));
      }, timeoutMs);
      const waiter: Waiter = {
        test,
        settle: key => {
          clearTimeout(timer);
          settle(key);
        },
      };
      waiters.add(waiter);
    });
  const line = (offset: number): string => {
    const buffer = term.buffer.active;
    return buffer.getLine(buffer.baseY + buffer.cursorY + offset)?.translateToString(true) ?? '';
  };
  const cursorLine = (): string => line(0);

  const daemon = daemonConnection({
    daemonId: config.daemonId,
    baseUrl: config.method.kind === 'direct' ? config.method.daemonUrl : 'http://127.0.0.1:9',
    deviceId: config.deviceId,
    carriers: [config.method],
  });
  /** xterm trims a line's trailing blanks, so an empty prompt reads without its last space. */
  const bare = config.prompt.trimEnd();
  const ready = until(() => cursorLine() === bare, 15_000, 'the first prompt');
  const session = await openRelaySession({
    crypto,
    dial: browserRelayDial,
    daemon,
    method: config.method,
    mode: { kind: 'stream', device: claim, path: config.path },
    onData,
  });
  let ended: string | undefined;
  session.onStreamClosed(closed => {
    ended = `the stream closed ${String(closed.code)} ${closed.reason}`;
  });
  // The resize a viewer sends as soon as it is attached, exactly as the terminal deck does.
  session.sendStream({ kind: 'text', text: JSON.stringify({ type: 'resize', cols: config.cols, rows: config.rows }) });
  const send = (text: string): void => session.sendStream({ kind: 'bytes', bytes: new TextEncoder().encode(text) });
  const keys: BenchKey[] = [];
  try {
    await ready;
    // Let the attach's complete redraw finish painting first, so no keystroke is timed behind it.
    await new Promise<void>(settle => term.write('', () => settle()));
    await new Promise(settle => setTimeout(settle, 250));
    let typed = '';
    for (let index = 0; index < config.keys; index += 1) {
      const character = 'abcdefghijklmnopqrstuvwxyz'[index % 26] ?? 'x';
      typed += character;
      const expected = `${config.prompt}${typed}`;
      const echoed = until(() => cursorLine() === expected, 10_000, `the echo of ${JSON.stringify(typed)}`);
      const sentAt = now();
      send(character);
      keys.push({ sentAt, ...(await echoed) });
      // A typist's gap, so each keystroke is timed on its own rather than queued behind the last.
      await new Promise(settle => setTimeout(settle, 40));
    }
    // A held run keeps what was typed on its prompt, so the picture shows the echoes it timed.
    if (config.hold !== true) {
      const cleared = until(() => cursorLine() === bare, 10_000, 'the cleared line');
      send('\u0015');
      await cleared;
    }
    let throughput: BenchPageResult['throughput'];
    if (config.throughputLines !== undefined) {
      const last = String(config.throughputLines);
      const done = until(() => cursorLine() === bare && line(-1) === last, 120_000, `seq to reach ${last}`);
      const before = { bytes, frames };
      const startedAt = now();
      send(`seq 1 ${last}\r`);
      const finished = await done;
      throughput = { ms: finished.paintedAt - startedAt, bytes: bytes - before.bytes, frames: frames - before.frames };
    }
    return { keys, received: { bytes, frames }, ...(throughput === undefined ? {} : { throughput }) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { keys, received: { bytes, frames }, error: ended === undefined ? message : `${message} (${ended})` };
  } finally {
    const release = (): void => {
      session.closeStream(1000, 'benchmark finished');
      term.dispose();
      host.remove();
    };
    if (config.hold === true) held = { release, term };
    else release();
  }
}

/** The run a screenshot is waiting on, released by the orchestrator once it has its pictures. */
let held: { readonly release: () => void; readonly term: Terminal } | undefined;

const dark = (): boolean => matchMedia('(prefers-color-scheme: dark)').matches;

/** The two schemes a screenshot is taken in: the page follows the media query, the emulator this. */
function themeFor(isDark: boolean): { background: string; foreground: string; cursor: string } {
  return isDark
    ? { background: '#0d1117', foreground: '#e6edf3', cursor: '#e6edf3' }
    : { background: '#ffffff', foreground: '#1f2328', cursor: '#1f2328' };
}

function theme(): void {
  if (held !== undefined) held.term.options.theme = themeFor(dark());
  document.body.style.background = dark() ? '#0d1117' : '#ffffff';
}

function release(): void {
  held?.release();
  held = undefined;
}

(globalThis as unknown as { __bench: unknown }).__bench = { device, run, theme, release };
