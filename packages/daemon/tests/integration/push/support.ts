import should from 'should';
import { PushError } from '../../../src/lib/index.ts';

/**
 * The refusal a call raised, as a `PushError`.
 *
 * `rejectedWith(Class, { code })` is not typed by the assertion library, and a message pattern is the
 * wrong contract to assert: the CODE is what a client branches on, so it is what a test should name.
 */
export async function refused(promise: Promise<unknown>): Promise<PushError> {
  const caught = await promise.then(
    () => undefined,
    (error: unknown) => error,
  );
  should(caught).be.instanceof(PushError);
  return caught as PushError;
}
