import { describe, it } from 'bun:test';
import should from 'should';
import { hasSubscriptionCrash, parseTmuxVersion } from '../../../src/lib/tmux/version.ts';

describe('tmux release', () => {
  it('should read a release as tmux -V and #{version} print it', () => {
    should(parseTmuxVersion('tmux 3.6a\n')).deepEqual({ label: '3.6a', major: 3, minor: 6 });
    should(parseTmuxVersion('3.8')).deepEqual({ label: '3.8', major: 3, minor: 8 });
    should(parseTmuxVersion('tmux next-3.7')).deepEqual({ label: 'next-3.7', major: 3, minor: 7 });
    should(parseTmuxVersion('tmux 3.7-rc2')).deepEqual({ label: '3.7-rc2', major: 3, minor: 7 });
    should(parseTmuxVersion('tmux openbsd-7.5')).deepEqual({ label: 'openbsd-7.5', major: 7, minor: 5 });
  });

  it('should refuse anything it cannot read rather than guess', () => {
    for (const text of ['', 'tmux', 'tmux master', 'no server running on /tmp/x', '3', 'tmux 3.6a extra'])
      should(parseTmuxVersion(text)).be.undefined();
  });

  it('should flag every release before 3.7, and none from it', () => {
    const crash = (text: string): boolean => {
      const version = parseTmuxVersion(text);
      if (version === undefined) throw new Error(`unparsed ${text}`);
      return hasSubscriptionCrash(version);
    };
    should(['2.9', '3.0', '3.3a', '3.6', '3.6a'].map(crash)).deepEqual([true, true, true, true, true]);
    should(['3.7', '3.7b', '3.8', '4.0', 'next-3.7'].map(crash)).deepEqual([false, false, false, false, false]);
  });
});
