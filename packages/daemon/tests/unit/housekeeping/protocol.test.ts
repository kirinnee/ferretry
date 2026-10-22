/**
 * THE HOUSEKEEPING PROTOCOL CANNOT CARRY CREDENTIAL MATERIAL (docs/design/housekeeping-worker.md §2.4
 * rule 3).
 *
 * Checked by the type checker, not at run time: every field name reachable from anything the worker can
 * post back — every answer, every metric, every failure — is collected, and none may be a name a token
 * or a blob would travel under. A field added to a fact type that could hold material turns this file
 * red in `typecheck`, before any test runs.
 */
import { describe, it } from 'bun:test';
import should from 'should';
import type {
  HousekeepingRequest,
  HousekeepingResponse,
  HousekeepingValue,
} from '../../../src/lib/housekeeping/protocol.ts';

/** The field names a credential's material, or a token taken from it, would be found under. */
type MaterialField =
  | 'blob'
  | 'token'
  | 'accessToken'
  | 'refreshToken'
  | 'access_token'
  | 'refresh_token'
  | 'id_token'
  | 'idToken'
  | 'bearer'
  | 'authorization'
  | 'secret';

/** Every key reachable from `T`, through objects, arrays and unions. */
type DeepKeys<T, Depth extends unknown[] = []> = Depth['length'] extends 8
  ? never
  : T extends readonly (infer Item)[]
    ? DeepKeys<Item, [...Depth, unknown]>
    : T extends object
      ? { [K in keyof T]-?: K | DeepKeys<T[K], [...Depth, unknown]> }[keyof T]
      : never;

/** `true` exactly when no key reachable from `T` is a material field. */
type CarriesNoMaterial<T> = [Extract<DeepKeys<T>, MaterialField>] extends [never] ? true : false;

const answers: CarriesNoMaterial<HousekeepingValue> = true;
const responses: CarriesNoMaterial<HousekeepingResponse> = true;
const requests: CarriesNoMaterial<HousekeepingRequest> = true;
// The check itself must be able to fail, or it proves nothing.
const canary: CarriesNoMaterial<{ readonly facts: { readonly accessToken: string } }> = false;

describe('the housekeeping protocol', () => {
  it('should have no field, in either direction, that credential material could travel in', () => {
    // Assert — the verdicts above were decided by the type checker; these only keep them referenced.
    should([answers, responses, requests, canary]).deepEqual([true, true, true, false]);
  });
});
