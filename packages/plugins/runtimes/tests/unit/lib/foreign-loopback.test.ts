import { describe, expect, it } from 'bun:test';
import { isLoopbackHost } from '../../../daemon/lib/foreign.ts';

describe('which host spellings name this computer itself', () => {
  it.each(['localhost', 'LOCALHOST', ' localhost ', 'app.localhost', '127.0.0.1', '127.255.0.9'])(
    'accepts %s',
    host => {
      expect(isLoopbackHost(host)).toBe(true);
    },
  );

  it.each(['::1', '[::1]', '0:0:0:0:0:0:0:1', '0::1', '0:0::1', '[0000:0000:0000:0000:0000:0000:0000:0001]'])(
    'accepts the IPv6 spelling %s',
    host => {
      expect(isLoopbackHost(host)).toBe(true);
    },
  );

  it.each([
    'example.com',
    '128.0.0.1',
    '127.0.0.256',
    '10.0.0.1',
    '::2',
    '::',
    '::1::1',
    '1:2:3:4:5:6:7',
    '0:0:0:0:0:0:0:0:1',
    '1:2:3:4:5:6:7::8',
    'zzzz::1',
    '12345::1',
    '1::zz',
  ])('refuses %s', host => {
    expect(isLoopbackHost(host)).toBe(false);
  });

  it('refuses a hex group that is not the loopback address', () => {
    expect(isLoopbackHost('::ffff:7f00:1')).toBe(false);
  });
});
