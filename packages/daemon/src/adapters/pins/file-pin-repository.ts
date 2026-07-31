import { join } from 'node:path';
import { PIN_SCHEMA_VERSION, PinSnapshotSchema, type Pin, type PinSnapshot } from '@ferretry/protocol';
import type { FileSystemPort, FoundationPaths, SerialExecutor } from '../../lib/index.ts';
import { normalizedPins, type PinClock, type PinRepository, type PinSessionDirectory } from '../../lib/pins/index.ts';

function pinFile(paths: FoundationPaths, sessionId: string): string {
  return join(paths.sessions, sessionId, 'pins.json');
}

export class FilePinRepository implements PinRepository {
  constructor(
    private readonly paths: FoundationPaths,
    private readonly files: FileSystemPort,
    private readonly executor: SerialExecutor,
    private readonly clock: PinClock,
  ) {}

  async snapshot(sessionId: string): Promise<PinSnapshot> {
    const text = await this.files.readText(pinFile(this.paths, sessionId));
    const pins = this.parse(sessionId, text);
    return { v: PIN_SCHEMA_VERSION, sessionId, pins: [...pins], updatedAt: this.clock.now() };
  }

  async mutate(sessionId: string, transform: (current: readonly Pin[]) => readonly Pin[]): Promise<PinSnapshot> {
    return await this.executor.run(sessionId, async () => {
      const current = (await this.snapshot(sessionId)).pins;
      const snapshot: PinSnapshot = {
        v: PIN_SCHEMA_VERSION,
        sessionId,
        pins: [...normalizedPins(transform(current))],
        updatedAt: this.clock.now(),
      };
      await this.files.writeTextAtomic(pinFile(this.paths, sessionId), JSON.stringify(snapshot));
      return snapshot;
    });
  }

  private parse(sessionId: string, text: string | undefined): readonly Pin[] {
    if (text === undefined) return [];
    try {
      const result = PinSnapshotSchema.safeParse(JSON.parse(text));
      if (!result.success || result.data.sessionId !== sessionId) return [];
      return normalizedPins(result.data.pins);
    } catch {
      return [];
    }
  }
}

export class FilePinSessionDirectory implements PinSessionDirectory {
  constructor(
    private readonly paths: FoundationPaths,
    private readonly files: FileSystemPort,
  ) {}

  async has(sessionId: string): Promise<boolean> {
    return (await this.files.information(join(this.paths.sessions, sessionId, 'session-version'))) !== undefined;
  }
}
