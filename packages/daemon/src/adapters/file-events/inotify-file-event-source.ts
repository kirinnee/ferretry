import { dlopen, FFIType, type Pointer, read, suffix } from 'bun:ffi';
import type { DirectoryWatchOpen, FileEventSource, FileStamp } from '../../lib/file-events/ports.ts';
import {
  describeError,
  directoryIdentity,
  nodeStampPrimitives,
  type StampPrimitives,
  stampAt,
  unavailableFor,
} from './node-stamps.ts';

/**
 * The four inotify calls, plus a stream of the instance's events. A call that fails answers `-errno`.
 *
 * Integers in, integers out, and one fixed struct to decode — `struct inotify_event` is the same on
 * every Linux architecture — so it is the same narrow FFI surface `directory-syscalls.ts` holds itself to.
 */
export interface InotifySyscalls {
  init(): number;
  addWatch(fd: number, path: string, mask: number): number;
  removeWatch(fd: number, wd: number): void;
  close(fd: number): void;
  /** The instance's raw event bytes. Bun reads a DUPLICATE of `fd` and closes only that on cancel. */
  events(fd: number): ReadableStream<Uint8Array>;
}

const IN_NONBLOCK = 0o4000;
const IN_CLOEXEC = 0o2000000;
const IN_MODIFY = 0x2;
const IN_ATTRIB = 0x4;
const IN_MOVED_FROM = 0x40;
const IN_MOVED_TO = 0x80;
const IN_CREATE = 0x100;
const IN_DELETE = 0x200;
const IN_DELETE_SELF = 0x400;
const IN_MOVE_SELF = 0x800;
const IN_Q_OVERFLOW = 0x4000;
const IN_IGNORED = 0x8000;
const IN_ONLYDIR = 0x1000000;
const IN_EXCL_UNLINK = 0x4000000;

/** Everything that changes an entry's stamp or the directory itself; never reads or closes. */
export const INOTIFY_MASK =
  IN_MODIFY |
  IN_ATTRIB |
  IN_MOVED_FROM |
  IN_MOVED_TO |
  IN_CREATE |
  IN_DELETE |
  IN_DELETE_SELF |
  IN_MOVE_SELF |
  IN_ONLYDIR |
  IN_EXCL_UNLINK;

/** `struct inotify_event`: wd, mask, cookie, len — then `len` bytes of name. */
const EVENT_HEADER_BYTES = 16;

const ERRNO_NAMES: Readonly<Record<number, string>> = {
  2: 'ENOENT',
  12: 'ENOMEM',
  13: 'EACCES',
  20: 'ENOTDIR',
  23: 'ENFILE',
  24: 'EMFILE',
  28: 'ENOSPC',
  38: 'ENOSYS',
};

const errnoName = (errno: number): string => ERRNO_NAMES[errno] ?? `errno ${String(errno)}`;

/** Loads the calls from the C library, or throws where there is no inotify. */
export function loadInotifySyscalls(): InotifySyscalls {
  const { symbols } = dlopen(`libc.${suffix}.6`, {
    inotify_init1: { args: [FFIType.i32], returns: FFIType.i32 },
    inotify_add_watch: { args: [FFIType.i32, FFIType.cstring, FFIType.u32], returns: FFIType.i32 },
    inotify_rm_watch: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    close: { args: [FFIType.i32], returns: FFIType.i32 },
    __errno_location: { args: [], returns: FFIType.ptr },
  });
  const failed = (result: number): number => (result >= 0 ? result : -read.i32(symbols.__errno_location() as Pointer));
  return {
    init: () => failed(symbols.inotify_init1(IN_NONBLOCK | IN_CLOEXEC)),
    addWatch: (fd, path, mask) => failed(symbols.inotify_add_watch(fd, Buffer.from(`${path}\0`), mask)),
    removeWatch: (fd, wd) => {
      symbols.inotify_rm_watch(fd, wd);
    },
    close: fd => {
      symbols.close(fd);
    },
    events: fd => Bun.file(fd).stream(),
  };
}

interface Handler {
  readonly onEvent: () => void;
  readonly onError: (detail: string) => void;
}

/** One kernel watch descriptor and everyone watching it (two paths to one directory share a wd). */
interface Registration {
  readonly wd: number;
  readonly handlers: Set<Handler>;
}

/** What the pump needs of the event stream's reader. */
interface EventReader {
  read(): Promise<
    { readonly done: true; readonly value?: unknown } | { readonly done: false; readonly value: Uint8Array }
  >;
  cancel(): Promise<void>;
}

interface Instance {
  readonly fd: number;
  readonly reader: EventReader;
  readonly watches: Map<number, Registration>;
}

/**
 * The file-event hub's platform on Linux: ONE inotify instance for the daemon, ONE watch descriptor per
 * directory, read through a non-blocking descriptor on the event loop — no thread, no timer, no poll.
 *
 * WHY NOT `fs.watch`. Bun 1.3.13's directory watch on Linux opens a descriptor and adds an inotify watch
 * for EVERY file in the directory (measured: 2,001 of each for a 2,000-file directory), keeps them after
 * `close()` — so a deleted 200 MB transcript's disk space stays held — collapses a burst of events into
 * one, and dies with ENXIO on a directory that holds a socket. This costs one descriptor in total.
 *
 * Every event is "the directory may have changed": the hub re-stats what it cares about. The directory
 * itself going (deleted, moved, unmounted — the kernel then drops the watch) is reported the same way,
 * and the hub's re-stat finds it gone. A queue overflow, which loses events for every watch, tells
 * every directory. The instance is opened with the first watch and closed with the last.
 */
export class InotifyFileEventSource implements FileEventSource {
  #instance: Instance | undefined;
  #syscalls: InotifySyscalls | string | undefined;

  /** `load` runs once, at the first watch; if it throws, every watch is refused as unsupported, saying why. */
  constructor(
    private readonly load: () => InotifySyscalls,
    private readonly primitives: StampPrimitives = nodeStampPrimitives,
  ) {}

  private get syscalls(): InotifySyscalls | string {
    if (this.#syscalls === undefined) {
      try {
        this.#syscalls = this.load();
      } catch (error) {
        this.#syscalls = `inotify could not be loaded: ${describeError(error)}`;
      }
    }
    return this.#syscalls;
  }

  watch(directory: string, onEvent: () => void, onError: (detail: string) => void): DirectoryWatchOpen {
    const found = directoryIdentity(this.primitives, directory);
    if ('refused' in found) return found.refused;
    const syscalls = this.syscalls;
    if (typeof syscalls === 'string') return { kind: 'unavailable', reason: 'unsupported', detail: syscalls };
    const instance = this.#instance ?? this.#start(syscalls);
    if (typeof instance === 'number') {
      const name = errnoName(-instance);
      return unavailableFor(name, `inotify_init1: ${name}`);
    }
    const wd = syscalls.addWatch(instance.fd, directory, INOTIFY_MASK);
    if (wd < 0) {
      this.#stopIfIdle(syscalls, instance);
      const name = errnoName(-wd);
      return unavailableFor(
        name,
        name === 'ENOSPC'
          ? 'inotify_add_watch: ENOSPC — the inotify watch limit (fs.inotify.max_user_watches) is spent'
          : `inotify_add_watch: ${name}`,
      );
    }
    const handler: Handler = { onEvent, onError };
    const registration = instance.watches.get(wd) ?? { wd, handlers: new Set() };
    registration.handlers.add(handler);
    instance.watches.set(wd, registration);
    let open = true;
    return {
      kind: 'watching',
      identity: found.identity,
      handle: {
        close: () => {
          if (!open) return;
          open = false;
          registration.handlers.delete(handler);
          // The kernel may already have dropped this wd and handed its number to another directory.
          if (registration.handlers.size === 0 && instance.watches.get(wd) === registration) {
            instance.watches.delete(wd);
            syscalls.removeWatch(instance.fd, wd);
          }
          this.#stopIfIdle(syscalls, instance);
        },
      },
    };
  }

  reports(): boolean {
    return true;
  }

  async stamp(path: string): Promise<FileStamp | undefined> {
    return await stampAt(this.primitives, path);
  }

  /** Open the instance and start reading it, or answer `-errno`. */
  #start(syscalls: InotifySyscalls): Instance | number {
    const fd = syscalls.init();
    if (fd < 0) return fd;
    const instance: Instance = { fd, reader: syscalls.events(fd).getReader(), watches: new Map() };
    this.#instance = instance;
    void this.#pump(syscalls, instance);
    return instance;
  }

  #stopIfIdle(syscalls: InotifySyscalls, instance: Instance): void {
    if (instance.watches.size > 0 || this.#instance !== instance) return;
    this.#instance = undefined;
    void instance.reader.cancel().catch(() => {});
    syscalls.close(instance.fd);
  }

  async #pump(syscalls: InotifySyscalls, instance: Instance): Promise<void> {
    let carry: Uint8Array = new Uint8Array(0);
    try {
      for (;;) {
        const chunk = await instance.reader.read();
        if (chunk.done) break;
        const bytes = carry.byteLength === 0 ? chunk.value : Buffer.concat([carry, chunk.value]);
        carry = this.#dispatch(instance, bytes);
      }
      this.#fail(syscalls, instance, 'the inotify event stream ended');
    } catch (error) {
      this.#fail(syscalls, instance, `the inotify event stream failed: ${describeError(error)}`);
    }
  }

  /** Tell each touched directory once per read; answer the bytes of an event not yet complete. */
  #dispatch(instance: Instance, bytes: Uint8Array): Uint8Array {
    // Linux runs little-endian on every architecture this daemon ships for (x64, arm64).
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const touched = new Set<Registration>();
    let offset = 0;
    while (offset + EVENT_HEADER_BYTES <= bytes.byteLength) {
      const length = EVENT_HEADER_BYTES + view.getUint32(offset + 12, true);
      if (offset + length > bytes.byteLength) break;
      const wd = view.getInt32(offset, true);
      const mask = view.getUint32(offset + 4, true);
      offset += length;
      if ((mask & IN_Q_OVERFLOW) !== 0) for (const registration of instance.watches.values()) touched.add(registration);
      const registration = instance.watches.get(wd);
      if (registration === undefined) continue;
      touched.add(registration);
      // The kernel dropped the watch (its directory is gone) and may reuse the number at once.
      if ((mask & IN_IGNORED) !== 0) instance.watches.delete(wd);
    }
    for (const registration of touched) for (const handler of [...registration.handlers]) handler.onEvent();
    return bytes.subarray(offset);
  }

  #fail(syscalls: InotifySyscalls, instance: Instance, detail: string): void {
    if (this.#instance !== instance) return;
    const handlers = [...instance.watches.values()].flatMap(registration => [...registration.handlers]);
    instance.watches.clear();
    this.#stopIfIdle(syscalls, instance);
    for (const handler of handlers) handler.onError(detail);
  }
}
