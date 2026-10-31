import { describe, it } from 'bun:test';
import should from 'should';
import {
  BrowserFirewallFailureSchema,
  BrowserStateViewSchema,
  LoopbackFirewallStateSchema,
} from '../../src/lib/index.ts';

describe('loopback firewall state', () => {
  it('should carry the firewall state on the browser state view, and leave it optional for an older daemon', () => {
    // Arrange
    const firewall = { state: 'stale', detail: 'the loopback firewall is stale: ask the host admin' };

    // Act + Assert
    should(LoopbackFirewallStateSchema.parse(firewall)).eql(firewall);
    should(BrowserStateViewSchema.parse({ state: 'stopped', firewall }).firewall).eql(firewall);
    should(BrowserStateViewSchema.parse({ state: 'stopped' }).firewall).equal(undefined);
  });

  it('should know the failed and unverified states', () => {
    // Act + Assert
    for (const state of ['applied', 'missing', 'stale', 'unverified', 'failed']) {
      should(LoopbackFirewallStateSchema.safeParse({ state, detail: 'x' }).success).equal(true);
    }
  });

  it('should accept the warn and refuse failure policies and nothing else', () => {
    // Act + Assert
    should(BrowserFirewallFailureSchema.parse('warn')).equal('warn');
    should(BrowserFirewallFailureSchema.parse('refuse')).equal('refuse');
    should(BrowserFirewallFailureSchema.safeParse('ignore').success).equal(false);
  });

  it('should refuse a state it does not know and an extra key', () => {
    // Act + Assert
    should(LoopbackFirewallStateSchema.safeParse({ state: 'open', detail: 'x' }).success).equal(false);
    should(LoopbackFirewallStateSchema.safeParse({ state: 'applied', detail: 'x', secret: 1 }).success).equal(false);
  });
});
