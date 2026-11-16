import { describe, it } from 'bun:test';
import should from 'should';
import { utf8Bytes, utf8Text } from '../../../../daemon/lib/secrets/clone-binary.ts';

describe('clone transcript text', () => {
  it('should round-trip valid UTF-8 text', () => {
    should(utf8Text(utf8Bytes('héllo ✓'))).equal('héllo ✓');
  });

  it('should answer null for bytes a peer supplied that are not valid UTF-8', () => {
    should(utf8Text(new Uint8Array([0xff, 0xfe, 0x80]))).be.null();
  });
});
