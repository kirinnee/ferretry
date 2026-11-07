import { z } from 'zod';
import type { Count, UpdateActivity, UpdatePhase } from './activity.ts';

/** `nix --log-format internal-json` activity types this tracker reads (`libutil/logging.hh`). */
const ACTIVITY = {
  copyPath: 100,
  fileTransfer: 101,
  build: 105,
  copyPaths: 103,
  substitute: 108,
  fetchTree: 112,
} as const;

/** Result types it reads. */
const RESULT = { buildLogLine: 101, progress: 105, setExpected: 106 } as const;

const Fields = z.array(z.union([z.number(), z.string()])).default([]);

const NixEvent = z.discriminatedUnion('action', [
  z.object({ action: z.literal('start'), id: z.number(), type: z.number(), text: z.string().default('') }),
  z.object({ action: z.literal('stop'), id: z.number() }),
  z.object({ action: z.literal('result'), id: z.number(), type: z.number(), fields: Fields }),
  z.object({ action: z.literal('msg'), level: z.number(), msg: z.string() }),
]);
type NixEvent = z.infer<typeof NixEvent>;

const PREFIX = '@nix ';

/** One line of `nix --log-format internal-json`, or `undefined` for a line that is not one (plain text, bad JSON). */
export function parseNixLine(line: string): NixEvent | undefined {
  if (!line.startsWith(PREFIX)) return undefined;
  let json: unknown;
  try {
    json = JSON.parse(line.slice(PREFIX.length));
  } catch {
    return undefined;
  }
  const parsed = NixEvent.safeParse(json);
  return parsed.success ? parsed.data : undefined;
}

const number = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

/** Messages at `notice` (2) or above are the ones a person is shown when nix fails. */
const SHOWN_LEVEL = 2;

/**
 * Folds nix's activity stream into "what is it doing and how far along": a phase, a package count and
 * a byte count. Total: a line it does not understand changes nothing, so a newer nix with an event it
 * has never heard of degrades to a less detailed line rather than a failed update.
 *
 * It also keeps the human-readable lines — the messages and anything nix printed that was not an
 * event — because the structured stream replaces stderr and an error has to be said in words.
 */
export class NixProgressTracker {
  readonly #types = new Map<number, number>();
  readonly #progress = new Map<number, Count>();
  readonly #human: string[] = [];
  #finishedBytes = 0;
  #expectedBytes = 0;
  #packages: Count | undefined;
  #sawWork = false;
  #line: string | undefined;
  #last: string | undefined;

  /** Take one line of output; answer the new activity when it changed, otherwise `undefined`. */
  feed(line: string): UpdateActivity | undefined {
    const event = parseNixLine(line);
    if (event === undefined) {
      const text = line.trim();
      if (text !== '' && !line.startsWith(PREFIX)) this.#human.push(text);
      return undefined;
    }
    this.#apply(event);
    const activity = this.activity();
    const key = JSON.stringify(activity);
    if (key === this.#last) return undefined;
    this.#last = key;
    return activity;
  }

  /** The words nix said, oldest first: its messages and any line that was not an event. */
  get messages(): readonly string[] {
    return this.#human;
  }

  activity(): UpdateActivity {
    const bytes = this.#bytes();
    return {
      phase: this.#phase(),
      ...(this.#packages === undefined ? {} : { packages: this.#packages }),
      ...(bytes === undefined ? {} : { bytes }),
      ...(this.#line === undefined ? {} : { line: this.#line }),
    };
  }

  #apply(event: NixEvent): void {
    switch (event.action) {
      case 'start':
        this.#types.set(event.id, event.type);
        if (isWork(event.type)) this.#sawWork = true;
        return;
      case 'stop': {
        const type = this.#types.get(event.id);
        const last = this.#progress.get(event.id);
        if (type === ACTIVITY.copyPath && last !== undefined) this.#finishedBytes += last.done;
        this.#types.delete(event.id);
        this.#progress.delete(event.id);
        return;
      }
      case 'result':
        this.#result(event.id, event.type, event.fields);
        return;
      case 'msg':
        if (event.level <= SHOWN_LEVEL && event.msg.trim() !== '') this.#human.push(event.msg.trim());
        return;
    }
  }

  #result(id: number, type: number, fields: readonly (number | string)[]): void {
    const activity = this.#types.get(id);
    if (type === RESULT.progress) {
      const count = { done: number(fields[0]), expected: number(fields[1]) };
      if (activity === ACTIVITY.copyPaths) this.#packages = count;
      else if (activity === ACTIVITY.copyPath) this.#progress.set(id, count);
      return;
    }
    if (type === RESULT.setExpected) {
      if (activity === ACTIVITY.copyPaths && number(fields[0]) === ACTIVITY.copyPath) {
        this.#expectedBytes = number(fields[1]);
      }
      return;
    }
    if (type === RESULT.buildLogLine && typeof fields[0] === 'string' && fields[0].trim() !== '') {
      this.#line = fields[0];
    }
  }

  #bytes(): Count | undefined {
    let live = 0;
    let liveExpected = 0;
    for (const count of this.#progress.values()) {
      live += count.done;
      liveExpected += count.expected;
    }
    const done = this.#finishedBytes + live;
    const expected = Math.max(this.#expectedBytes, this.#finishedBytes + liveExpected);
    return expected > 0 ? { done: Math.min(done, expected), expected } : undefined;
  }

  #phase(): UpdatePhase {
    const active = new Set(this.#types.values());
    if (active.has(ACTIVITY.build)) return 'building';
    if (active.has(ACTIVITY.copyPath) || active.has(ACTIVITY.fileTransfer) || active.has(ACTIVITY.substitute)) {
      return 'downloading';
    }
    if (this.#sawWork && this.#packages !== undefined && this.#packages.done >= this.#packages.expected) {
      return 'switching';
    }
    return this.#sawWork && !active.has(ACTIVITY.copyPaths) ? 'switching' : 'preparing';
  }
}

function isWork(type: number): boolean {
  return (
    type === ACTIVITY.copyPath ||
    type === ACTIVITY.copyPaths ||
    type === ACTIVITY.fileTransfer ||
    type === ACTIVITY.substitute ||
    type === ACTIVITY.build
  );
}
