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

  constructor(private readonly log: Log) {}

  subscribe(plugin: string, event: EventDef, fn: (payload: unknown) => void | Promise<void>): void {
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
          .then(() => subscriber.fn(value))
          .catch(() => this.log.warn('a subscriber failed', { event: event.name, plugin: subscriber.plugin }));
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
