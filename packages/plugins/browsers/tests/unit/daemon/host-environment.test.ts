import { describe, expect, it } from 'bun:test';
import { allowedEnvironment, processHost, READ_ENVIRONMENT_NAMES } from '../../../daemon/adapters/host.ts';
import { openerEnvironment } from '../../../daemon/open-url/launcher.ts';
import { FORWARDED_ENVIRONMENT } from '../../../daemon/worker/client.ts';
import { browserEnvironment } from '../../../daemon/worker/control/policy.ts';

describe('browsers host environment', () => {
  it('reads and passes on only its named variables, never a secret-shaped one', () => {
    const source = {
      GITHUB_TOKEN: 'ghp_secret',
      AWS_SECRET_ACCESS_KEY: 'aws_secret',
      FY_HOME: '/h',
      PATH: '/bin',
      HOME: '/home/x',
      FY_CHROME_BIN: '/chrome',
      FY_BROWSER_WORKER_BIN: '/worker',
    };
    const host = processHost(source);
    expect(host.environment).toEqual({
      FY_HOME: '/h',
      PATH: '/bin',
      HOME: '/home/x',
      FY_CHROME_BIN: '/chrome',
      FY_BROWSER_WORKER_BIN: '/worker',
    });
    expect(Object.keys(host.environment)).not.toContain('GITHUB_TOKEN');
    expect(JSON.stringify(host.environment)).not.toContain('secret');
  });

  it('is not given the whole environment by default', () => {
    process.env.GITHUB_TOKEN = 'ghp_unit_test_secret';
    try {
      expect(processHost().environment.GITHUB_TOKEN).toBeUndefined();
      expect(allowedEnvironment({ GITHUB_TOKEN: 'x' })).toEqual({});
    } finally {
      delete process.env.GITHUB_TOKEN;
    }
  });
});

describe('browsers host environment allow-list', () => {
  it('reads only names a downstream launcher forwards, or this half owns (L7)', () => {
    // The three downstream lists are driven, not copied: a name is forwarded if feeding it in comes back out.
    const owned = new Set(['FY_HOME', 'FY_CHROME_BIN', 'FY_BROWSER_WORKER_SOURCE', 'FY_BROWSER_WORKER_BIN']);
    const downstream = (name: string): boolean => {
      const source = { [name]: 'x' };
      return (
        name in browserEnvironment(undefined, source) ||
        name in openerEnvironment(source) ||
        FORWARDED_ENVIRONMENT.includes(name as never)
      );
    };
    const unexplained = READ_ENVIRONMENT_NAMES.filter(name => !owned.has(name) && !downstream(name));
    expect(unexplained).toEqual([]);
  });

  it('names the thirteen standard POSIX locale variables and nothing that merely starts with LC_ (L1)', () => {
    const locale: string[] = READ_ENVIRONMENT_NAMES.filter(name => name.startsWith('LC_'));
    const standard: string[] = [
      'LC_ADDRESS',
      'LC_ALL',
      'LC_COLLATE',
      'LC_CTYPE',
      'LC_IDENTIFICATION',
      'LC_MEASUREMENT',
      'LC_MESSAGES',
      'LC_MONETARY',
      'LC_NAME',
      'LC_NUMERIC',
      'LC_PAPER',
      'LC_TELEPHONE',
      'LC_TIME',
    ];
    expect(locale.sort()).toEqual(standard.sort());
    expect(allowedEnvironment({ LC_TERMINAL: 'iTerm2', LC_PAPER: 'a4' })).toEqual({ LC_PAPER: 'a4' });
  });
});
