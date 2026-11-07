import type { StateFileDef, StatePort } from '@ferretry/kernel/contract';
import { type Pin, PIN_SCHEMA_VERSION, PinSchema, type PinSnapshot } from '../../lib/protocol/pins.ts';
import { normalizedPins, type PinClock, type PinRepository, type PinSessionDirectory } from '../../lib/pins/index.ts';
import { z } from 'zod';

/** The body of one ferret's `<ferret>/pins.json`; the kernel store stamps and checks its `format`. */
export type FerretPinFile = { readonly pins: readonly Pin[] };

const FerretPinFileSchema = z.object({ pins: z.array(PinSchema) });

/**
 * One ferret's note and message pins in `state/ferrets/<ferret>/pins.json`, through the kernel store. Every change
 * is one read-modify-write on the store's own chain for that file, so two pins landing at once both stay. The file
 * definition is handed in: it is the contract's to declare.
 */
export class StatePinRepository implements PinRepository {
  constructor(
    private readonly state: StatePort,
    private readonly file: StateFileDef<string, FerretPinFile>,
    private readonly clock: PinClock,
  ) {}

  async snapshot(sessionId: string): Promise<PinSnapshot> {
    const read = await this.state.read(this.file, sessionId);
    const pins = read.ok ? this.parse(read.value) : [];
    return { v: PIN_SCHEMA_VERSION, sessionId, pins: [...pins], updatedAt: this.clock.now() } as PinSnapshot;
  }

  async mutate(sessionId: string, transform: (current: readonly Pin[]) => readonly Pin[]): Promise<PinSnapshot> {
    let pins: readonly Pin[] = [];
    const written = await this.state.update(
      this.file,
      (current): FerretPinFile => {
        pins = normalizedPins(transform(this.parse(current)));
        return { pins: [...pins] };
      },
      sessionId,
    );
    if (!written.ok) throw new Error(`the pins of ${sessionId} could not be written`);
    return { v: PIN_SCHEMA_VERSION, sessionId, pins: [...pins], updatedAt: this.clock.now() } as PinSnapshot;
  }

  private parse(value: unknown): readonly Pin[] {
    if (value === undefined) return [];
    const result = FerretPinFileSchema.safeParse(value);
    return result.success ? normalizedPins(result.data.pins) : [];
  }
}

/** Whether a ferret exists, from the registry: a pin is only ever kept for one. */
export class RegistryPinSessionDirectory implements PinSessionDirectory {
  constructor(private readonly exists: (ferret: string) => boolean) {}

  async has(sessionId: string): Promise<boolean> {
    return this.exists(sessionId);
  }
}
