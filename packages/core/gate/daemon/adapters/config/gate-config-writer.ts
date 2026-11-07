import type { ConfigFilesWriter, ConfigFileDef } from '@ferretry/kernel/contract';
import type { GateConfig } from '../../../contract/index.ts';

/** `gate.yaml` could not be saved: nothing was applied. The sentence names why, never a value. */
export class GateConfigNotSaved extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GateConfigNotSaved';
  }
}

/**
 * Writes one top-level block of `gate.yaml` through the kernel's ONE config writer (`kernel.configFiles`, Gate's
 * alone): only that key is edited, comments survive, a raw secret is refused and the last good version is kept.
 *
 * `confirmedLoosening` is set because Gate's own routes have ALREADY decided this caller may make this change (today
 * wrote the grants and the security settings straight to their documents, never held): the grant surface refuses any
 * remote widening (G46), and the security settings refuse every remote loosening but a passkey-proved
 * `unlockValidityHours` (G111–G116). Anything else the writer answers is a save that did not happen.
 */
export class GateConfigWriter {
  constructor(
    private readonly writer: () => ConfigFilesWriter | undefined,
    private readonly target: { readonly plugin: string; readonly def: ConfigFileDef<GateConfig> },
  ) {}

  async write<K extends keyof GateConfig>(key: K, value: GateConfig[K]): Promise<void> {
    const writer = this.writer();
    if (writer === undefined)
      throw new GateConfigNotSaved('this daemon has no config writer for gate.yaml, so nothing was saved');
    const outcome = await writer.write(this.target, { patch: { [key]: value } }, { confirmedLoosening: true });
    switch (outcome.kind) {
      case 'written':
        return;
      case 'held':
        throw new GateConfigNotSaved(
          'gate.yaml was saved but waits for the owner to confirm it, so nothing changed yet',
        );
      case 'conflict':
        throw new GateConfigNotSaved('gate.yaml changed while this was being saved; read it again and retry');
      case 'refused':
        throw new GateConfigNotSaved(
          `gate.yaml refused the change (${outcome.reason}${outcome.issues[0] === undefined ? '' : `: ${outcome.issues[0].message}`}), so nothing was saved`,
        );
    }
  }
}
