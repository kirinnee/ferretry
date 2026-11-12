import { describe, it } from 'bun:test';
import should from 'should';
import { allowedCallHeaders } from '../../../manifest/call-headers.ts';
import type { PluginCallHeaders } from '../../../manifest/implement.ts';

describe('the headers a plugin half may set', () => {
  it('should keep the request id and the agenda channel 2, and nothing else', () => {
    should(allowedCallHeaders({ 'x-fy-request-id': 'req-1', 'x-fy-agenda-channel': '2' })).deepEqual({
      'x-fy-request-id': 'req-1',
      'x-fy-agenda-channel': '2',
    });
    should(allowedCallHeaders({ 'x-fy-request-id': 'req-1' })).deepEqual({ 'x-fy-request-id': 'req-1' });
  });

  it('should drop another header name, so a half cannot set the credential or the contract hash', () => {
    // A variable, not a literal: the type allows only the two names, and this proves the runtime drops the rest too.
    const forged = { 'x-fy-request-id': 'req-2', authorization: 'Bearer forged', 'x-fy-contract': 'h' };
    should(allowedCallHeaders(forged)).deepEqual({ 'x-fy-request-id': 'req-2' });
  });

  it('should drop a channel other than 2, and answer nothing when nothing survives', () => {
    const wrongChannel = { 'x-fy-agenda-channel': '1' } as unknown as PluginCallHeaders;
    should(allowedCallHeaders(wrongChannel)).be.undefined();
    should(allowedCallHeaders({})).be.undefined();
    should(allowedCallHeaders(undefined)).be.undefined();
  });
});
