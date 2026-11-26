import type { EventDef } from '../contract/define.ts';
import type { EventsPort, Log } from '../contract/ports.ts';

type Subscriber = { readonly plugin: string; readonly fn: (payload: unknown) => void | Promise<void> };

/**
 * Events are wake-ups, not records (§7.4 rule 3): delivered in-process after the publisher's write, at most once,
 * possibly lost in a crash. A plugin publishes only what it declared and hears only what it subscribed to.
 */
export class EventBus {
  private readonly subscribers = new Map<string, Subscriber[]>();
  private readonly listeners = new Set<(name: string, payload: unknown) => void>();

  /**
   * `busOnly`: events the kernel delivers on `GET /v1/bus` and to {@link onAny} alone. A plugin's subscription to one
   * is never made (it is said once in the log), so what it names reaches no plugin in-process.
   */
  constructor(
    private readonly log: Log,
    private readonly busOnly: ReadonlySet<string> = new Set(),
  ) {}

  subscribe(plugin: string, event: EventDef, fn: (payload: unknown) => void | Promise<void>): void {
    if (this.busOnly.has(event.name)) {
      this.log.warn('a plugin subscribed to an event only the bus carries; it is not delivered to it', {
        event: event.name,
        plugin,
      });
      return;
    }
    const list = this.subscribers.get(event.name) ?? [];
    list.push({ plugin, fn });
    this.subscribers.set(event.name, list);
  }

  /** Every delivered event, for the session layer's event streams and the test host. */
  onAny(listener: (name: string, payload: unknown) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  unsubscribeAll(plugin: string): void {
    for (const [name, list] of this.subscribers)
      this.subscribers.set(
        name,
        list.filter(subscriber => subscriber.plugin !== plugin),
      );
  }

  /** Publishes after the caller's current turn, so a write the caller awaited has landed first. */
  publish(event: EventDef, payload: unknown): void {
    const parsed = event.schema.safeParse(payload);
    if (!parsed.success) throw new TypeError(`event ${event.name}: payload does not match its schema`);
    const value = parsed.data;
    queueMicrotask(() => {
      for (const listener of this.listeners) {
        try {
          listener(event.name, value);
        } catch {
          // a listener's failure never reaches the publisher
        }
      }
      for (const subscriber of this.subscribers.get(event.name) ?? []) {
        void Promise.resolve()
          .then(() => {
            if (this.subscribers.get(event.name)?.includes(subscriber)) return subscriber.fn(value);
          })
          .catch((cause: unknown) =>
            this.log.warn('a subscriber failed', {
              event: event.name,
              plugin: subscriber.plugin,
              reason: reasonOf(cause),
            }),
          );
      }
    });
  }

  portFor(plugin: string, declared: readonly EventDef[]): EventsPort {
    const names = new Set(declared.map(event => event.name));
    return {
      publish: (event, payload) => {
        if (!names.has(event.name))
          throw new TypeError(`${plugin} published ${event.name}, which it did not declare in data.publishes`);
        this.publish(event, payload);
      },
    };
  }
}

/** The error kinds a failure is logged as; the thrown value's own `name` is mutable and is never logged. */
const ERROR_KINDS: readonly (readonly [new (...args: never[]) => Error, string])[] = [
  [TypeError, 'TypeError'],
  [RangeError, 'RangeError'],
  [SyntaxError, 'SyntaxError'],
  [ReferenceError, 'ReferenceError'],
  [URIError, 'URIError'],
  [EvalError, 'EvalError'],
  [Error, 'Error'],
];

/** The system error codes a failure may name; any other code is left out. */
const ERROR_CODES: ReadonlySet<string> = new Set([
  'EACCES',
  'EADDRINUSE',
  'EAGAIN',
  'EBUSY',
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'EEXIST',
  'EHOSTUNREACH',
  'EISDIR',
  'EMFILE',
  'ENOENT',
  'ENOSPC',
  'ENOTDIR',
  'ENOTEMPTY',
  'EPERM',
  'EPIPE',
  'ETIMEDOUT',
]);

/**
 * Why a subscriber failed, for the log: a fixed error kind and a recognised system code (`TypeError`, `Error ECONNRESET`).
 * Never the value's own name, message or stack, which can carry a URL, a path or a value the plugin held; `unknown` when the
 * thrown value cannot be inspected safely.
 */
function reasonOf(cause: unknown): string {
  try {
    const kind = ERROR_KINDS.find(([type]) => cause instanceof type)?.[1];
    if (kind === undefined) return 'a non-error value was thrown';
    const code = (cause as { code?: unknown }).code;
    return typeof code === 'string' && ERROR_CODES.has(code) ? `${kind} ${code}` : kind;
  } catch {
    return 'unknown';
  }
}
