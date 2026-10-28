import { isAbsolute } from 'node:path';
import { TERMINAL_OWNER_OPTION } from '../../lib/terminal/runtime-policy.ts';
import type { TmuxCommandPort, TmuxCommandResult, TmuxEventFilter, TmuxEventSource } from '../../lib/tmux/contracts.ts';
import {
  type ControlReply,
  controlCommandLine,
  controlNonceLine,
  controlReplyProgress,
  controlSubscriptionLine,
  isControlAttachable,
  parseControlGuard,
  parseControlNotification,
  type TmuxControlNotification,
} from '../../lib/tmux/control-protocol.ts';
import { BunTmuxProcess } from './bun-tmux-process.ts';

/** The parts of a child process a control client uses: its pipes, a way to end it, and its exit. */
export interface ControlChild {
  readonly stdin: { write(text: string): unknown; flush(): unknown };
  readonly stdout: AsyncIterable<Uint8Array>;
  /** Settles once the process has exited, whatever it exited with. */
  readonly exited: Promise<unknown>;
  /** SIGTERM when no signal is named. */
  kill(signal?: 'SIGKILL'): void;
}

export interface ControlModeOptions {
  /** A fresh unguessable nonce per command. */
  readonly nonce?: () => string;
  /** A command with no answer this long ends the connection; its caller is answered on the spawn path. */
  readonly replyTimeoutMs?: number;
  /** After a connection could not be made, how long every command keeps its own process. */
  readonly retryAfterMs?: number;
  readonly nowMs?: () => number;
  /** Starts the long-lived client. Bun's spawn, unreferenced, unless a test substitutes a child. */
  readonly spawn?: (argv: readonly string[]) => ControlChild;
  /**
   * The ONE session this client attaches to, and how. Absent, it attaches to the first session that is
   * not a terminal, `ignore-size,no-output` — the daemon's shared query client. A session worker names
   * its own session and attaches `read-only` as well.
   */
  readonly attach?: { readonly target: string; readonly flags: string };
  /**
   * What a command that is not an allowlisted read does: `spawn` gives it its own child (the shared
   * client); `refuse` answers it as a failure without running anything — a session worker observes and
   * must never type into the agent it watches. tmux's `read-only` flag does NOT stop an in-band
   * `send-keys` (it guards keyboard input, not control commands), so this is the guard.
   */
  readonly mutations?: 'spawn' | 'refuse';
}

/** The options with every default filled in; `attach` stays optional because absent is a mode. */
type ResolvedControlModeOptions = Required<Omit<ControlModeOptions, 'attach'>> & Pick<ControlModeOptions, 'attach'>;

interface Pending {
  readonly nonce: string;
  readonly collected: string[];
  readonly settle: (reply: ControlReply | undefined) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

type Phase =
  | { readonly kind: 'idle' }
  /** A block tmux ran for itself (the attach), skipped up to its own terminator. */
  | { readonly kind: 'foreign'; readonly key: string }
  | { readonly kind: 'reply' }
  /** The nonce's block, whose `%end` is the last line of a reply. */
  | { readonly kind: 'closing'; readonly key: string };

const randomNonce = (): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');

function spawnControlChild(argv: readonly string[]): ControlChild {
  const child = Bun.spawn([...argv], { stdin: 'pipe', stdout: 'pipe', stderr: 'ignore' });
  // The client must never be what keeps a daemon — or a test runner — from exiting. Its stdin closing
  // when this process goes makes tmux drop it — but only AFTER the process has gone, which is why a
  // daemon that is stopping ends its client with `stop` and does not leave this to the exit.
  child.unref();
  return child;
}

/**
 * ONE connected control-mode client: `tmux -C attach-session`, kept for as long as tmux keeps it.
 *
 * It answers reads in-band and hands every notification to `notify`. It never retries anything itself:
 * a reply it cannot vouch for — the client exited, the stream broke its framing, an answer never came —
 * is answered `undefined`, and the caller asks again on the spawn path.
 */
class ControlConnection {
  private readonly pending: Pending[] = [];
  private phase: Phase = { kind: 'idle' };
  private ended = false;
  /** Whether this client ever answered: one that exits before its first answer is not worth redialling. */
  private answered = false;

  constructor(
    private readonly child: ControlChild,
    private readonly notify: (notification: TmuxControlNotification) => void,
    private readonly onEnd: (answered: boolean) => void,
    private readonly nonce: () => string,
    private readonly replyTimeoutMs: number,
  ) {
    void this.read();
  }

  get open(): boolean {
    return !this.ended;
  }

  async ask(line: string): Promise<ControlReply | undefined> {
    // Ended between being handed out and being asked: nothing would ever answer, not even the timer.
    if (this.ended) return undefined;
    const nonce = this.nonce();
    return await new Promise<ControlReply | undefined>(resolve => {
      const timer = setTimeout(() => this.end(), this.replyTimeoutMs);
      this.pending.push({ nonce, collected: [], settle: resolve, timer });
      try {
        this.child.stdin.write(`${line}\n${controlNonceLine(nonce)}\n`);
        this.child.stdin.flush();
      } catch {
        this.end();
      }
    });
  }

  /** Close the client: every unanswered command is answered `undefined`, once. */
  end(): void {
    if (this.ended) return;
    this.ended = true;
    for (const waiting of this.pending.splice(0)) {
      clearTimeout(waiting.timer);
      waiting.settle(undefined);
    }
    try {
      this.child.kill();
    } catch {
      // Already gone: the stream ending is usually what brought us here.
    }
    this.onEnd(this.answered);
  }

  private async read(): Promise<void> {
    const decoder = new TextDecoder();
    let partial = '';
    try {
      for await (const chunk of this.child.stdout) {
        const lines = (partial + decoder.decode(chunk, { stream: true })).split('\n');
        partial = lines.pop() as string;
        for (const line of lines) if (!this.ended) this.line(line);
      }
    } catch {
      // A broken pipe is the same end as a closed one.
    }
    this.end();
  }

  private line(line: string): void {
    const phase = this.phase;
    const guard = parseControlGuard(line);
    if (phase.kind === 'foreign') {
      if (guard !== undefined && guard.edge !== 'begin' && guard.key === phase.key) this.phase = { kind: 'idle' };
      return;
    }
    if (phase.kind === 'closing') {
      if (guard?.edge === 'end' && guard.key === phase.key) this.phase = { kind: 'idle' };
      else this.end();
      return;
    }
    if (phase.kind === 'reply') {
      this.collect(line);
      return;
    }
    if (guard?.edge === 'begin' && guard.flags === '0') {
      this.phase = { kind: 'foreign', key: guard.key };
      return;
    }
    // A reply nobody asked for, or text outside a block: not what tmux writes, so nothing here trusts it.
    if (guard?.edge === 'begin' && this.pending.length > 0) {
      this.phase = { kind: 'reply' };
      this.collect(line);
      return;
    }
    const notification = guard === undefined ? parseControlNotification(line) : undefined;
    if (notification === undefined) this.end();
    else this.notify(notification);
  }

  private collect(line: string): void {
    const head = this.pending[0] as Pending;
    head.collected.push(line);
    const progress = controlReplyProgress(head.collected, head.nonce);
    if (progress.kind === 'pending') return;
    if (progress.kind === 'violation') {
      this.end();
      return;
    }
    this.pending.shift();
    clearTimeout(head.timer);
    this.phase = { kind: 'closing', key: progress.closing };
    this.answered = true;
    head.settle(progress.reply);
  }
}

/**
 * tmux over ONE long-lived control-mode client, with a process per command only where one is needed.
 *
 * READS GO IN-BAND. `has-session`, `display-message -p`, `capture-pane -p` and the listings are written
 * to the client and answered from its stdout — no fork, no exec, no library load per question. What a
 * caller gets back is what a spawned tmux would have printed: stdout, stderr and exit code, measured
 * byte-identical (see `lib/tmux/control-protocol.ts` for the framing that keeps that true when a pane
 * prints control lines of its own).
 *
 * EVERYTHING ELSE KEEPS ITS OWN PROCESS, and so does every read whenever the client is not there: a
 * command with stdin (`load-buffer -`), anything that changes the server, a server that is not running,
 * a connection that dropped mid-answer. Those go to {@link BunTmuxProcess} exactly as before, so the
 * fallback is not a second implementation — it is the old one.
 *
 * WHICH SESSION IT ATTACHES TO. A control client must be attached to a session, and attaching stamps
 * that session's `session_activity`. A terminal's idle reap reads that stamp, so the client attaches only
 * to a session WITHOUT the terminal owner option — `ignore-size`, so it never resizes a pane, and
 * `no-output`, so no pane's bytes are streamed to it. When that session ends tmux detaches the client,
 * and the next read connects again.
 *
 * IT NEVER STARTS A SERVER (`-N`). `attach-session` is a command tmux starts a server for, so a client
 * dialling a socket nobody serves would bring up an empty one of its own — and a reader has nothing to
 * read on a server it made. Nor is that server harmless: tmux writes a control client's answers into the
 * client's own stdout and keeps the client until they are written, so a client whose reader is already
 * gone — spawned as the daemon stops, by a session worker still loading — is never let go, and the server
 * it started never empties. Both outlived the daemon for good (measured on 3.6a); CI's tmux sweep found
 * the pair on a socket whose test never launched a pane. With `-N` such a client just fails to connect.
 *
 * NOTIFICATIONS go to {@link subscribe}rs, filtered by pane or session id, so a watcher can react to a
 * session or window closing instead of asking about it. tmux scopes `%output` and `refresh-client -B`
 * subscriptions to the ATTACHED session — measured on 3.6a — so this one client sees the server-wide
 * events (`%sessions-changed`, `%unlinked-window-close`, `%exit`) and only its own session's panes.
 */
export class ControlModeTmuxProcess implements TmuxCommandPort, TmuxEventSource {
  private connection: ControlConnection | undefined;
  private connecting: Promise<ControlConnection | undefined> | undefined;
  private retryAtMs = 0;
  private closed = false;
  private readonly listeners = new Set<{
    readonly filter: TmuxEventFilter;
    readonly listener: (notification: TmuxControlNotification) => void;
  }>();
  private readonly options: ResolvedControlModeOptions;
  /** The subscriptions this client renews on every connection, by name. */
  private readonly watches = new Map<string, string>();
  /** Every client this transport started that has not exited yet — an ended connection's included. */
  private readonly children = new Set<ControlChild>();

  constructor(
    private readonly executable: string,
    private readonly socketPath: string,
    private readonly spawned: TmuxCommandPort = new BunTmuxProcess(executable, socketPath),
    options: ControlModeOptions = {},
  ) {
    if (!isAbsolute(executable) || !isAbsolute(socketPath))
      throw new Error('tmux executable and socket path must both be absolute');
    this.options = {
      nonce: options.nonce ?? randomNonce,
      replyTimeoutMs: options.replyTimeoutMs ?? 15_000,
      retryAfterMs: options.retryAfterMs ?? 10_000,
      nowMs: options.nowMs ?? (() => Date.now()),
      spawn: options.spawn ?? spawnControlChild,
      mutations: options.mutations ?? 'spawn',
      ...(options.attach === undefined ? {} : { attach: options.attach }),
    };
    if (options.attach !== undefined && !isControlAttachable(options.attach.target))
      throw new Error(`${JSON.stringify(options.attach.target)} is not a session a control client may attach to`);
  }

  async execute(arguments_: readonly string[], stdin?: string): Promise<TmuxCommandResult> {
    const line =
      stdin === undefined && arguments_[0]?.startsWith('-') === false ? controlCommandLine(arguments_) : undefined;
    if (line === undefined) {
      if (this.options.mutations === 'refuse')
        return {
          code: 1,
          stdout: '',
          stderr: `refused: this client only reads, and ${arguments_[0] ?? 'nothing'} is not a read\n`,
        };
      const result = await this.spawned.execute(arguments_, stdin);
      // A command that changed the server may have started it, or given it a session to attach to.
      if (result.code === 0) this.retryAtMs = 0;
      return result;
    }
    const connection = await this.connect();
    const reply = connection === undefined ? undefined : await connection.ask(line);
    return reply ?? (await this.spawned.execute(arguments_));
  }

  /** Every notification matching `filter`, until the returned function is called. */
  subscribe(listener: (notification: TmuxControlNotification) => void, filter: TmuxEventFilter = {}): () => void {
    const entry = { filter, listener };
    this.listeners.add(entry);
    return () => {
      this.listeners.delete(entry);
    };
  }

  /** Whether a control client is connected right now, so its notifications are arriving. */
  get connected(): boolean {
    return this.connection?.open === true;
  }

  /**
   * Have tmux tell {@link subscribe}rs whenever `format` changes for any pane of the attached session — at
   * most once a second, as `%subscription-changed <name>` — and renew it on every reconnection. Answers
   * whether a connection took it now; one that did not is renewed when the next connection opens.
   */
  async watch(name: string, format: string): Promise<boolean> {
    const line = controlSubscriptionLine(name, format);
    if (line === undefined) throw new Error(`${JSON.stringify(name)} cannot be subscribed to that format`);
    this.watches.set(name, line);
    const connection = await this.connect();
    const reply = connection === undefined ? undefined : await connection.ask(line);
    return reply?.code === 0;
  }

  /** Disconnect for good: from here on every command keeps its own process. */
  close(): void {
    this.closed = true;
    this.connection?.end();
  }

  /**
   * {@link close}, and answer only once every client this transport started has EXITED — SIGTERM, then
   * SIGKILL for any still there after `withinMs`. Answers whether they all went on the SIGTERM.
   *
   * WHAT A STOPPING DAEMON CALLS, because `close` only asks. A client left to notice its daemon's exit
   * is still detaching from its server for a moment after the daemon has gone, and tmux 3.6a, told to
   * `kill-server` in that moment, keeps the server AND the client running for good — each waiting on
   * the other. Measured: a supervised daemon whose teardown ran `kill-server` within a millisecond of
   * the daemon's exit left exactly that pair behind 9 runs in 230, and 0 in 200 once it called this.
   * Ended here first, no client of this daemon is on the server by the time anybody can see it gone.
   */
  async stop(withinMs = 2_000): Promise<boolean> {
    this.close();
    // The client of a connect still on its way is never started: `open` checks `closed` before spawning.
    await this.connecting;
    // Each was sent SIGTERM when its connection ended, and `close` has just ended the last one.
    const children = [...this.children];
    if (await exitedWithin(children, withinMs)) return true;
    for (const child of children)
      try {
        child.kill('SIGKILL');
      } catch {
        // Already gone.
      }
    await exitedWithin(children, withinMs);
    return false;
  }

  private notify(notification: TmuxControlNotification): void {
    for (const { filter, listener } of [...this.listeners]) {
      if (!matches(filter, notification)) continue;
      try {
        listener(notification);
      } catch {
        // A listener's failure is its own; the stream and every other listener carry on.
      }
    }
  }

  private async connect(): Promise<ControlConnection | undefined> {
    if (this.connection !== undefined) return this.connection;
    if (this.closed || this.options.nowMs() < this.retryAtMs) return undefined;
    this.connecting ??= this.open().finally(() => {
      this.connecting = undefined;
    });
    return await this.connecting;
  }

  private async open(): Promise<ControlConnection | undefined> {
    const target = this.options.attach?.target ?? (await this.attachTarget());
    let child: ControlChild | undefined;
    if (target !== undefined && !this.closed)
      try {
        child = this.options.spawn([
          this.executable,
          '-u',
          // Attach to a server that is running, never start one: see the class comment.
          '-N',
          '-S',
          this.socketPath,
          '-C',
          'attach-session',
          '-t',
          `=${target}`,
          '-f',
          this.options.attach?.flags ?? 'ignore-size,no-output',
        ]);
      } catch {
        child = undefined;
      }
    if (child === undefined) {
      this.retryAtMs = this.options.nowMs() + this.options.retryAfterMs;
      return undefined;
    }
    const started = child;
    this.children.add(started);
    const forget = (): void => {
      this.children.delete(started);
    };
    void started.exited.then(forget, forget);
    // Declared first: a client whose stream fails at once ends inside its own constructor.
    let connection: ControlConnection | undefined;
    connection = new ControlConnection(
      child,
      notification => this.notify(notification),
      answered => {
        if (this.connection === connection) this.connection = undefined;
        // A client that never answered — an attach this tmux refuses, a session gone before it attached —
        // would otherwise be redialled on every read: two processes per question instead of one.
        if (!answered) this.retryAtMs = this.options.nowMs() + this.options.retryAfterMs;
      },
      this.options.nonce,
      this.options.replyTimeoutMs,
    );
    if (connection.open) {
      this.connection = connection;
      // A new connection knows none of the old one's subscriptions.
      for (const line of this.watches.values()) void connection.ask(line);
    }
    return connection;
  }

  /** The first session that is not a terminal, asked of tmux on the spawn path: no client exists yet. */
  private async attachTarget(): Promise<string | undefined> {
    const listed = await this.spawned
      .execute(['list-sessions', '-F', `#{session_name}\t#{${TERMINAL_OWNER_OPTION}}`])
      .catch(() => undefined);
    if (listed?.code !== 0) return undefined;
    for (const row of listed.stdout.split('\n')) {
      const [name = '', owner = ''] = row.split('\t');
      if (owner === '' && isControlAttachable(name)) return name;
    }
    return undefined;
  }
}

/** Whether every one of `children` exited within `withinMs`. */
async function exitedWithin(children: readonly ControlChild[], withinMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<false>(resolve => {
    timer = setTimeout(() => resolve(false), withinMs);
  });
  const all = Promise.allSettled(children.map(child => child.exited)).then(() => true as const);
  try {
    return await Promise.race([all, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

function matches(filter: TmuxEventFilter, notification: TmuxControlNotification): boolean {
  const fields = notification as { readonly paneId?: string; readonly sessionId?: string };
  return (
    (filter.paneId === undefined || fields.paneId === filter.paneId) &&
    (filter.sessionId === undefined || fields.sessionId === filter.sessionId)
  );
}
