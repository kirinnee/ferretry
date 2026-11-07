/** A railway result: a value or an error, never a throw for an ordinary failure (docs/standards/functional-practices). */
export type Result<T, E> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

export function isOk<T, E>(result: Result<T, E>): result is { readonly ok: true; readonly value: T } {
  return result.ok;
}

export function mapResult<T, E, U>(result: Result<T, E>, fn: (value: T) => U): Result<U, E> {
  return result.ok ? ok(fn(result.value)) : result;
}

export function mapError<T, E, F>(result: Result<T, E>, fn: (error: E) => F): Result<T, F> {
  return result.ok ? result : err(fn(result.error));
}

export function andThen<T, E, U>(result: Result<T, E>, next: (value: T) => Result<U, E>): Result<U, E> {
  return result.ok ? next(result.value) : result;
}

export function match<T, E, U>(result: Result<T, E>, onOk: (value: T) => U, onErr: (error: E) => U): U {
  return result.ok ? onOk(result.value) : onErr(result.error);
}

export function unwrapOr<T, E>(result: Result<T, E>, fallback: T): T {
  return result.ok ? result.value : fallback;
}
