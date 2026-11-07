import { describe, it } from 'bun:test';
import type { RuntimeControlRequest } from '@ferretry/protocol';
import should from 'should';
import { runtimeRequestFingerprint } from '../../../../src/lib/session/runtime-control/ledger.ts';

/** The stable payload identity handed to the durable session-effect ledger. */

const print = (request: RuntimeControlRequest) => runtimeRequestFingerprint(request);

describe('the runtime request fingerprint', () => {
  it('should read two serialisations of one control as the same request', () => {
    // A retry may well re-serialize the body, and key order or whitespace is not a different ask.
    // Act
    const actual = [
      print({ action: 'model', model: 'gpt-5.6-codex', effort: 'high' }),
      print({ effort: 'high', model: 'gpt-5.6-codex', action: 'model' } as RuntimeControlRequest),
    ];

    // Assert
    should(actual[0]).equal(actual[1]);
  });

  it('should tell every arm of the union apart, including one that only omits a field', () => {
    // Act
    const prints = [
      print({ action: 'compact' }),
      print({ action: 'effort', effort: 'high' }),
      print({ action: 'model' }),
      print({ action: 'model', model: 'gpt-5.6-codex' }),
      print({ action: 'model', model: 'gpt-5.6-codex', effort: 'high' }),
      print({ action: 'fast', fast: true }),
      print({ action: 'fast', fast: false }),
    ];

    // Assert: seven controls, seven distinct prints.
    should(new Set(prints).size).equal(prints.length);
  });

  it('should leave the print of every pre-existing control exactly as it was', () => {
    // A request begun before fast mode existed and still awaiting its retry must not read as a conflict.
    // Act / Assert
    should(print({ action: 'compact' })).equal('["compact",null,null]');
    should(print({ action: 'effort', effort: 'high' })).equal('["effort","high",null]');
    should(print({ action: 'model', model: 'm', effort: 'e' })).equal('["model","e","m"]');
  });
});
