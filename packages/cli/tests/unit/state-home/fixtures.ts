import type { IStateHomeFilePort, StateHomeEntry } from '../../../src/lib/state-home/ports';

/** One write the claim performed, so a test can assert the mode as well as the bytes. */
export interface RecordedWrite {
  readonly path: string;
  readonly contents: string;
  readonly mode: number;
}

/**
 * A state home held in memory.
 *
 * Deliberately distinguishes "no such home" from "empty home": the claim's whole job is telling
 * apart a directory it may create, one it may claim, and one belonging to somebody else, and a fake
 * that collapsed the first two could not exercise the branch that matters.
 */
export class FakeStateHomeFiles implements IStateHomeFilePort {
  readonly writes: RecordedWrite[] = [];
  readonly created: Array<{ path: string; mode: number }> = [];
  /** `undefined` means the home does not exist at all. */
  entries: StateHomeEntry[] | undefined;
  marker: string | undefined;

  constructor(entries?: readonly StateHomeEntry[], marker?: string) {
    this.entries = entries === undefined ? undefined : [...entries];
    this.marker = marker;
  }

  listHome(): Promise<readonly StateHomeEntry[] | undefined> {
    return Promise.resolve(this.entries);
  }

  readMarker(): Promise<string | undefined> {
    return Promise.resolve(this.marker);
  }

  ensureDirectory(path: string, mode: number): Promise<void> {
    this.created.push({ path, mode });
    this.entries ??= [];
    return Promise.resolve();
  }

  writeMarkerAtomic(path: string, contents: string, mode: number): Promise<void> {
    this.writes.push({ path, contents, mode });
    this.marker = contents;
    return Promise.resolve();
  }
}

/** Directory entries by name, the common case where the kind does not matter. */
export function directories(...names: readonly string[]): readonly StateHomeEntry[] {
  return names.map(name => ({ name, directory: true }));
}

/** File entries by name. */
export function files(...names: readonly string[]): readonly StateHomeEntry[] {
  return names.map(name => ({ name, directory: false }));
}

/** Captured terminal output, in the order it was written. */
export class CapturedOutput {
  readonly lines: string[] = [];

  success(message: string): void {
    this.lines.push(message);
  }

  get text(): string {
    return this.lines.join('\n');
  }
}
