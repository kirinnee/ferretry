import { describe, it } from 'bun:test';
import should from 'should';
import { daemonLocale } from '../../../src/lib/daemon/locale';

describe('daemon locale', () => {
  it('should forward the caller’s locale variables when the one in effect is UTF-8', () => {
    // Act + Assert — a person's language choice reaches their agents.
    should(daemonLocale('linux', { LANG: 'sv_SE.UTF-8' })).deepEqual({ LANG: 'sv_SE.UTF-8' });
    should(daemonLocale('darwin', { LC_ALL: 'en_GB.utf8', LANG: 'C' })).deepEqual({ LC_ALL: 'en_GB.utf8', LANG: 'C' });
    should(daemonLocale('linux', { LC_CTYPE: 'C.UTF-8', LANG: undefined })).deepEqual({ LC_CTYPE: 'C.UTF-8' });
  });

  it('should fall back to a UTF-8 locale that exists on the platform when the caller has none', () => {
    // Act + Assert — macOS ships no C.UTF-8.
    should(daemonLocale('linux', {})).deepEqual({ LANG: 'C.UTF-8' });
    should(daemonLocale('darwin', {})).deepEqual({ LANG: 'en_US.UTF-8' });
    should(daemonLocale('linux', { LANG: '' })).deepEqual({ LANG: 'C.UTF-8' });
  });

  it('should drop a caller locale that is not UTF-8 rather than let it override the fallback', () => {
    // Act + Assert — forwarding LC_ALL=C would override LANG and bring the `_` back.
    should(daemonLocale('linux', { LC_ALL: 'C', LANG: 'en_US.UTF-8' })).deepEqual({ LANG: 'C.UTF-8' });
    should(daemonLocale('darwin', { LANG: 'POSIX' })).deepEqual({ LANG: 'en_US.UTF-8' });
  });
});
