import { isAbsolute, normalize, parse } from 'node:path';

declare const stateHomeBrand: unique symbol;

/** Absolute root of one Ferretry installation. */
export type StateHome = string & { readonly [stateHomeBrand]: true };

class InvalidStateHomeError extends Error {
  constructor(
    readonly value: string,
    readonly reason: string,
  ) {
    super(`invalid state home: ${reason}`);
    this.name = 'InvalidStateHomeError';
  }
}

/** The kernel resolves the home (`FY_HOME` or `~/.<product>`); this only checks a value handed in. */
export function parseAbsoluteHome(value: string, source: string): StateHome {
  if (value.trim().length === 0) throw new InvalidStateHomeError(value, `${source} must not be empty`);
  if (!isAbsolute(value)) throw new InvalidStateHomeError(value, `${source} must be an absolute path`);
  const resolved = normalize(value);
  if (resolved === parse(resolved).root)
    throw new InvalidStateHomeError(value, `${source} must not be a filesystem root`);
  return resolved as StateHome;
}
