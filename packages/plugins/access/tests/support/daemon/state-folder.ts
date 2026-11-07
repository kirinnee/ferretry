import type { StateFileDef, StatePort } from '@ferretry/kernel/contract';
import { MemoryStateFolder as KernelStateFolder, SimulatedCrash } from '@ferretry/kernel/testing';
import { err, ok } from '@ferretry/std';

/** TODO(kernel testing): remove when 5.0 carries the kernel's byte-backed secret/opaque fake. */
export class MemoryStateFolder extends KernelStateFolder {
  readonly bytes = new Map<string, Uint8Array>();

  plantBytes(file: StateFileDef, bytes: Uint8Array, name?: string): void {
    this.bytes.set(pathOf(file, name), new Uint8Array(bytes));
  }

  rawBytes(file: StateFileDef, name?: string): Uint8Array | undefined {
    const stored = this.bytes.get(pathOf(file, name));
    return stored === undefined ? undefined : new Uint8Array(stored);
  }

  override port(declared: readonly StateFileDef[]): StatePort {
    const base = super.port(declared);
    const known = new Set(declared.map(file => file.name));
    const guard = (file: StateFileDef): void => {
      if (this.crashed) throw new SimulatedCrash();
      if (!known.has(file.name)) throw new Error(`state ${file.name} is not declared in the manifest`);
    };
    return {
      ...base,
      read: async (file, name) => {
        if (file.store !== 'secret' && file.store !== 'opaque') return await base.read(file, name);
        guard(file);
        const stored = this.rawBytes(file, name);
        if (stored !== undefined) return ok(stored as never);
        return file.required === true
          ? err({ file: file.path, reason: 'missing', sentence: `${file.path} cannot be used: it is missing.` })
          : ok(undefined);
      },
      write: async (file, value, name) => {
        if (file.store !== 'secret' && file.store !== 'opaque') return await base.write(file, value, name);
        guard(file);
        if (!(value instanceof Uint8Array) && typeof value !== 'string')
          throw new TypeError(`state ${file.name}: a ${file.store} file holds bytes`);
        this.plantBytes(file, typeof value === 'string' ? new TextEncoder().encode(value) : value, name);
        this.landed();
      },
      remove: async (file, name) => {
        guard(file);
        this.bytes.delete(pathOf(file, name));
        await base.remove(file, name);
      },
    };
  }
}

function pathOf(file: StateFileDef, name?: string): string {
  if (!file.path.includes('*')) return file.path;
  if (name === undefined || name.includes('/') || name === '..' || name === '.')
    throw new TypeError(`state ${file.name}: a collection file needs a plain name`);
  return file.path.replace('*', name);
}
