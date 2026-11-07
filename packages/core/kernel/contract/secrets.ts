/**
 * A plugin's OWN secret, resolved for its own daemon-side use (lead decision J: today's Browsers proxy credentials
 * into the Chrome launch). The kernel resolves one only when (1) the name is in the plugin's manifest
 * `permissions.secrets`, (2) the plugin's OWN configuration, as the owner wrote it and as it is in effect, names it as
 * a `${secret:NAME}` reference, and (3) the Vault knows it. The value never leaves through a log, a JSON body or a
 * string conversion: each of those shows `[secret:NAME]`; only {@link OwnSecret.reveal} gives the value.
 */

/** The `${secret:NAME}` grammar (today's `SECRET_REFERENCE_SOURCE`). */
export const SECRET_REFERENCE_SOURCE = '\\$\\{secret:([A-Z][A-Z0-9_]{0,63})\\}';

/** Why a resolve answered no value. */
export type OwnSecretRefusal = 'not_declared' | 'not_configured' | 'unknown';

const values = new WeakMap<OwnSecret, string>();
const INSPECT = Symbol.for('nodejs.util.inspect.custom');

/** An opaque secret value: masked in every printed or serialised form, revealed only on purpose. */
export class OwnSecret {
  readonly name: string;

  /** The kernel's to mint (`kernel.secrets.resolve`); a value built here by a plugin is only ever its own. */
  constructor(name: string, value: string) {
    this.name = name;
    values.set(this, value);
    Object.freeze(this);
  }

  /** The value, for the one place it is used (a launch argument, a header). Never log or return it. */
  reveal(): string {
    return values.get(this) ?? '';
  }

  toString(): string {
    return `[secret:${this.name}]`;
  }

  toJSON(): string {
    return this.toString();
  }

  [Symbol.toPrimitive](): string {
    return this.toString();
  }

  [INSPECT](): string {
    return this.toString();
  }
}

/** `kernel.secrets`: daemon halves only. */
export interface SecretsPort {
  resolve(name: string): Promise<OwnSecret | { readonly refused: OwnSecretRefusal }>;
}
