import { isAbsolute, join, normalize, parse } from 'node:path';

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

/** Resolve a state home from already-captured environment inputs, without ambient reads. */
export function resolveStateHome(input: StateHomeInput): StateHome {
  if (input.fyHome !== undefined) return parseAbsoluteHome(input.fyHome, 'FY_HOME');
  const homeDirectory = parseAbsoluteHome(input.homeDirectory, 'home directory');
  return parseAbsoluteHome(join(homeDirectory, '.ferretry'), 'default state home');
}
