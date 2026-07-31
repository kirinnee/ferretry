import { describe, it } from 'bun:test';
import should from 'should';
import { defaultBindRetryPolicy, healthEndpoint, shouldRetryBind } from '../../../src/lib/runtime/boot.ts';

describe('daemon boot policy', () => {
  it('should build one health endpoint for either form of base URL', () => {
    // Act + Assert
    should(healthEndpoint('http://127.0.0.1:7337')).equal('http://127.0.0.1:7337/v1/health');
    should(healthEndpoint('http://127.0.0.1:7337/')).equal('http://127.0.0.1:7337/v1/health');
    should(healthEndpoint('http://127.0.0.1:7337//')).equal('http://127.0.0.1:7337/v1/health');
  });

  it('should retry only a bind conflict that can fit before the deadline', () => {
    // Arrange
    const policy = defaultBindRetryPolicy();

    // Act + Assert
    should(shouldRetryBind({ code: 'EADDRINUSE' }, 100, 1_000, 1, policy)).be.true();
    should(shouldRetryBind(new Error('address already in use'), 100, 1_000, 1, policy)).be.true();
    should(shouldRetryBind(new Error('permission denied'), 100, 1_000, 1, policy)).be.false();
    should(shouldRetryBind({ code: 'EADDRINUSE' }, 500, 1_000, 1, policy)).be.true();
    should(shouldRetryBind({ code: 'EADDRINUSE' }, 501, 1_000, 1, policy)).be.false();
    should(shouldRetryBind({ code: 'EADDRINUSE' }, 100, 1_000, policy.maxAttempts, policy)).be.false();
  });
});
