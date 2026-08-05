import { isAbsolute, join, normalize, parse } from 'node:path';
import { productName } from './version.ts';

declare const stateHomeBrand: unique symbol;

/** Absolute root of one Ferretry installation. */
export type StateHome = string & { readonly [stateHomeBrand]: true };

export interface StateHomeInput {
  readonly fyHome: string | undefined;
  readonly homeDirectory: string;
}
export class InvalidStateHomeError extends Error {
  constructor(
    readonly value: string,
    readonly reason: string,
  ) {
    super(`invalid state home: ${reason}`);
    this.name = 'InvalidStateHomeError';
  }
}

function parseAbsoluteHome(value: string, source: string): StateHome {
  if (value.trim().length === 0) throw new InvalidStateHomeError(value, `${source} must not be empty`);
  if (!isAbsolute(value)) throw new InvalidStateHomeError(value, `${source} must be an absolute path`);
  const resolved = normalize(value);
  if (resolved === parse(resolved).root)
    throw new InvalidStateHomeError(value, `${source} must not be a filesystem root`);
  return resolved as StateHome;
}

/**
 * Resolve a state home from already-captured environment inputs, without ambient reads.
 *
 * The default is `~/.<product>`, derived from this package's own scope rather than written out. Three
 * functions derive this same default — this one and the client's two — and two of them used to spell
 * the product as a literal. They agreed only by coincidence: `scripts/local/rename.sh --product`
 * rewrites package scopes and manifests but not a literal inside a `.ts` file, so a rename would have
 * left this daemon serving `~/.ferretry` while its client provisioned `~/.newname`, with nothing on
 * either side reporting the split. See `resolveDaemonStateHome` in the client for the other half.
 */
export function resolveStateHome(input: StateHomeInput): StateHome {
  if (input.fyHome !== undefined) return parseAbsoluteHome(input.fyHome, 'FY_HOME');
  const homeDirectory = parseAbsoluteHome(input.homeDirectory, 'home directory');
  return parseAbsoluteHome(join(homeDirectory, `.${productName}`), 'default state home');
}
