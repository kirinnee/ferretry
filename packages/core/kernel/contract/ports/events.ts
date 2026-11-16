import type { EventDef } from '../define.ts';

export interface EventsPort {
  /** Only types the manifest declared in `data.publishes`. Delivered after the caller's write, at most once. */
  publish<Name extends string, Payload>(event: EventDef<Name, Payload>, payload: Payload): void;
}
