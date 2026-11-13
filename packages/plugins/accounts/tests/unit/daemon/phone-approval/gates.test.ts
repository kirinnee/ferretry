import { describe, it } from 'bun:test';
import type { PushNumberRead } from '@ferretry/core-vault/contract';
import should from 'should';
import { type GateContext, gatedNumber, httpsHost } from '../../../../daemon/lib/phone-approval/gates.ts';
import { identityProviderOf, numberSourceFits } from '../../../../daemon/lib/phone-approval/providers.ts';
import { oktaRead } from './world.ts';

/** The three gates on their own, with the hosts the service would have matched handed in directly. */

const NOW = Date.parse('2026-11-10T12:00:00.000Z');
const context = (extra: Partial<GateContext> = {}): GateContext => ({
  domains: new Set(['company.okta.com']),
  scripted: false,
  now: NOW,
  ...extra,
});

describe('I200 the gates on the host', () => {
  it('I200 should believe a number only on a host the matched sign-in signs in at or a fixed identity provider is on', () => {
    // Okta's custom-domain widget: the host is named by a provider sign-in's domains but is not this sign-in's own.
    const custom: PushNumberRead = {
      ...oktaRead(),
      origin: 'https://login.company.test',
      number: { value: '42', from: 'okta', frameOrigin: 'https://login.company.test' },
    };
    const providerDomains = new Set(['login.company.test']);

    should(gatedNumber(custom, context({ domains: new Set(), providerDomains }))).eql({ numberMissing: 'origin' });
    should(gatedNumber(custom, context({ domains: new Set(['login.company.test']), providerDomains }))).have.property(
      'number',
    );
    should(gatedNumber(oktaRead(), context({ domains: new Set() }))).have.property('number');
  });

  it('I200 should believe a number only on the host the approval was raised on', () => {
    should(gatedNumber(oktaRead(), context({ pinnedHost: 'other.okta.com' }))).eql({ numberMissing: 'origin' });
    should(gatedNumber(oktaRead(), context({ pinnedHost: 'company.okta.com' }))).have.property('number');
  });

  it('I200 should believe no number once the session ran a page script, however good the page looks', () => {
    should(gatedNumber(oktaRead(), context({ scripted: true }))).eql({ numberMissing: 'scripted' });
  });

  it('I200 should believe only the provider whose challenge view the document is, on a host that provider is on', () => {
    const read = (from: 'okta' | 'microsoft' | 'google' | 'duo', provider?: typeof from): PushNumberRead => ({
      origin: 'https://company.okta.com',
      navigationId: 'd',
      ...(provider === undefined ? {} : { provider }),
      number: { value: '42', from, frameOrigin: 'https://company.okta.com' },
    });

    should(gatedNumber(read('okta'), context())).eql({ numberMissing: 'none-found' });
    should(gatedNumber(read('okta', 'microsoft'), context())).eql({ numberMissing: 'none-found' });
    should(gatedNumber(read('microsoft', 'microsoft'), context())).eql({ numberMissing: 'origin' });
    should(gatedNumber(read('okta', 'okta'), context())).have.property('number');
  });

  it('I200 should read an origin as a host only when it is https with no port, path or credentials', () => {
    should(httpsHost('https://company.okta.com')).equal('company.okta.com');
    for (const origin of [
      'http://company.okta.com',
      'https://company.okta.com:8443',
      'https://company.okta.com/path',
      'https://user@company.okta.com',
      'nonsense',
    ])
      should(httpsHost(origin)).be.undefined();
  });

  it('I200 should name an identity provider from a fixed list and never a look-alike or a bare apex', () => {
    should(identityProviderOf('login.microsoftonline.com')).equal('microsoft');
    should(identityProviderOf('accounts.google.com')).equal('google');
    should(identityProviderOf('company.okta.com')).equal('okta');
    should(identityProviderOf('api-1.duosecurity.com')).equal('duo');
    for (const host of ['okta.com', 'evilokta.com', 'okta.com.evil.example', 'duosecurity.com', 'google.com'])
      should(identityProviderOf(host)).be.undefined();
    should(numberSourceFits('okta', 'login.company.test')).be.false();
    should(numberSourceFits('okta', 'login.company.test', new Set(['login.company.test']))).be.true();
    should(numberSourceFits('google', 'login.microsoftonline.com')).be.false();
  });
});
