import { describe, expect, it } from 'bun:test';
import { allowedEnvironment, processHost } from '../../../daemon/adapters/host.ts';

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
