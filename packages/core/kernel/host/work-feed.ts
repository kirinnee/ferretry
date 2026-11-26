import { basename } from 'node:path';
import type { ApiRequest, ApiResponse } from '../contract/http.ts';
import type { SpawnPort, WorkObserver } from '../contract/ports.ts';
import type { HostFs } from './adapters/node-fs.ts';

/**
 * WHAT THE KERNEL SEES, HANDED TO WHOEVER LISTENS (`kernel.loop.observeWork`): routes served, children run, host filesystem
 * calls. Each instrument asks {@link WorkFeed.recording} before it reads a clock, so a daemon with nobody listening pays one
 * boolean per call. What is reported is a name, a count and a duration and never an argument, a path, a body or a value.
 */
export class WorkFeed {
  readonly #observers = new Set<WorkObserver>();

  get recording(): boolean {
    return this.#observers.size > 0;
  }

  observe(observer: WorkObserver): () => void {
    this.#observers.add(observer);
    return () => this.#observers.delete(observer);
  }

  emit(call: (observer: WorkObserver) => unknown): void {
    for (const observer of this.#observers) {
      try {
        const result = call(observer);
        // an observer that answers with a promise is contained too: its rejection is not the watched work's
        if (typeof (result as PromiseLike<unknown> | undefined)?.then === 'function')
          (result as PromiseLike<unknown>).then(undefined, () => undefined);
      } catch {
        // an observer's failure never reaches the work it watches
      }
    }
  }
}

/** What every call that matched no declared route is reported as: the caller's method and path never become a key. */
const UNROUTED = 'unrouted';

/** What a program Ferretry does not launch itself (a configured MCP command, say) is reported as. */
const OTHER_PROGRAM = 'other';

/** The programs Ferretry itself launches, by name. */
const KNOWN_PROGRAMS: ReadonlySet<string> = new Set([
  'git',
  'gh',
  'bun',
  'node',
  'sh',
  'bash',
  'nix',
  'tmux',
  'ps',
  'lsof',
  'kill',
  'which',
  'mkdir',
  'claude',
  'codex',
]);

const programLabel = (program: string): string => {
  const name = basename(program);
  return KNOWN_PROGRAMS.has(name) ? name : OTHER_PROGRAM;
};

/** The route a request was served as: the declared `METHOD template` it matched, or `unrouted`; never anything the caller chose. */
export async function timedRoute(
  feed: WorkFeed,
  request: ApiRequest,
  serve: (request: ApiRequest) => Promise<ApiResponse>,
  now: () => number = () => performance.now(),
): Promise<ApiResponse> {
  if (!feed.recording) return await serve(request);
  const started = now();
  let template: string | undefined;
  const response = await serve({
    ...request,
    onRoute: found => {
      template = found;
      request.onRoute?.(found);
    },
  });
  const bytes = response.bytes?.byteLength ?? Buffer.byteLength(response.body);
  const route = template ?? UNROUTED;
  feed.emit(observer => observer.route(route, now() - started, response.status, bytes));
  return response;
}

/** A spawn adapter that tells the feed which program started and how long it ran, by the program's own name alone. */
export function tapSpawn(inner: SpawnPort, feed: WorkFeed, now: () => number = () => performance.now()): SpawnPort {
  const run = async <T>(program: string, call: () => Promise<T>): Promise<T> => {
    if (!feed.recording) return await call();
    const name = programLabel(program);
    const started = now();
    feed.emit(observer => observer.childStarted(name));
    try {
      return await call();
    } finally {
      feed.emit(observer => observer.childExited(name, now() - started));
    }
  };
  return {
    run: (program, args, options) => run(program, () => inner.run(program, args, options)),
    runBytes: (program, args, options) => run(program, () => inner.runBytes(program, args, options)),
    start: (program, args, options) => {
      const child = inner.start(program, args, options);
      if (!feed.recording) return child;
      const name = programLabel(program);
      const started = now();
      feed.emit(observer => observer.childStarted(name));
      // A detached child's `exited` is null at once and the kernel never waits on it: it has a start and no exit.
      if (options?.detached !== true)
        void child.exited.then(
          () => feed.emit(observer => observer.childExited(name, now() - started)),
          () => feed.emit(observer => observer.childExited(name, now() - started)),
        );
      return child;
    },
  };
}

/** The host filesystem seam, each call timed under its method's name; the path it was given is never looked at. */
export function tapFs(inner: HostFs, feed: WorkFeed, now: () => number = () => performance.now()): HostFs {
  const wrapped: Record<string, unknown> = {};
  for (const [name, member] of Object.entries(inner)) {
    if (typeof member !== 'function') {
      wrapped[name] = member;
      continue;
    }
    wrapped[name] = (...args: unknown[]): unknown => {
      if (!feed.recording) return member.apply(inner, args);
      const started = now();
      const done = (): void => feed.emit(observer => observer.file(name, now() - started));
      let result: unknown;
      try {
        result = member.apply(inner, args);
      } catch (error) {
        done();
        throw error;
      }
      if (!(result instanceof Promise)) {
        done();
        return result;
      }
      return result.finally(done);
    };
  }
  return wrapped as unknown as HostFs;
}
