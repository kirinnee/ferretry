import { describe, it } from 'bun:test';
import type { AccountList } from '@ferretry/protocol';
import should from 'should';
import type { AgentToolError } from '../../../src/lib/index.ts';
import { agent, agentToolWorld, otherAgent } from './support.ts';

/** `account_hint`: what a ferret may know about signing in to a site, one line per sign-in, by non-secret metadata. */

const AT = '2026-10-31T09:00:00.000Z';
const SI_GOOGLE = 'si_00000000000000b1';
const SI_VERCEL = 'si_00000000000000b2';
const LISTING: Pick<AccountList, 'accounts' | 'signIns'> = {
  accounts: [
    {
      id: 'GOOGLE_KIRIN',
      label: 'Google (kirin@)',
      username: 'kirin@example.com',
      fields: { password: true, totp: true },
      totp: { algorithm: 'SHA1', digits: 6, period: 30 },
      factors: [],
      signIns: [SI_GOOGLE],
      createdAt: AT,
      updatedAt: AT,
    },
    {
      id: 'VERCEL',
      label: 'Vercel',
      fields: { password: false, totp: false },
      factors: [],
      signIns: [SI_VERCEL],
      createdAt: AT,
      updatedAt: AT,
    },
  ],
  signIns: [
    {
      id: SI_GOOGLE,
      account: 'GOOGLE_KIRIN',
      place: { kind: 'site', domains: ['accounts.google.com'], match: ['accounts.google.com'] },
      method: { kind: 'password' },
      createdAt: AT,
      updatedAt: AT,
    },
    {
      id: SI_VERCEL,
      account: 'VERCEL',
      place: { kind: 'site', domains: ['vercel.com'], match: ['vercel.com'] },
      method: { kind: 'google', via: 'GOOGLE_KIRIN' },
      via: { account: { id: 'GOOGLE_KIRIN', label: 'Google (kirin@)' }, signIn: SI_GOOGLE },
      createdAt: AT,
      updatedAt: AT,
    },
  ],
};

const listing = (list: Pick<AccountList, 'accounts' | 'signIns'> = LISTING) => ({ list: async () => list });

describe('account.hint', () => {
  it('should name the site sign-in, how it signs in and the provider one, by metadata only', async () => {
    const world = agentToolWorld({ accounts: listing() });

    const result = await world.service.call(agent, { tool: 'account.hint', site: 'https://vercel.com/login' });

    should(result.summary).startWith('Accounts for vercel.com:');
    should(result.summary.indexOf(`[${SI_VERCEL}]`)).be.lessThan(result.summary.indexOf(`[${SI_GOOGLE}]`));
    should(result.summary).containEql('(GOOGLE_KIRIN, provider)');
    should(result.summary).containEql("Sign in with Google via 'Google (kirin@)'");
    should(result.summary).containEql('passkeys are off');
    const text = JSON.stringify(result);
    for (const leak of ['"fields"', '"totp"', 'SHA1']) should(text).not.containEql(leak);
  });

  it('should read the site from where the agent’s page IS, not from the agent', async () => {
    const world = agentToolWorld({ accounts: listing() });
    await world.service.call(agent, { tool: 'browser.open', name: 'app', url: 'https://accounts.google.com/signin' });

    const result = await world.service.call(agent, { tool: 'account.hint', name: 'app' });

    should(result.summary).startWith('Accounts for accounts.google.com:');
    should(result.summary).containEql(`[${SI_GOOGLE}]`).and.not.containEql(`[${SI_VERCEL}]`);
  });

  it('should refuse another session’s page', async () => {
    const world = agentToolWorld({ accounts: listing() });
    await world.service.call(otherAgent, { tool: 'browser.open', name: 'app', url: 'https://vercel.com/' });

    const error = (await world.service
      .call(agent, { tool: 'account.hint', name: 'app' })
      .catch((caught: unknown) => caught)) as AgentToolError;

    should(error.code).equal('not_found');
  });

  it('should say when nothing is saved, and when this daemon keeps no accounts', async () => {
    const none = await agentToolWorld({ accounts: listing({ accounts: [], signIns: [] }) }).service.call(agent, {
      tool: 'account.hint',
      site: 'github.com',
    });
    should(none.summary).containEql('No account for github.com');
    should(none.summary).not.containEql('account_propose');

    const error = (await agentToolWorld()
      .service.call(agent, { tool: 'account.hint', site: 'github.com' })
      .catch((caught: unknown) => caught)) as AgentToolError;
    should(error.code).equal('unavailable');
  });

  it('should refuse a site that is not one, and a page that is not on a site yet', async () => {
    const world = agentToolWorld({ accounts: listing() });
    await world.service.call(agent, { tool: 'browser.open', name: 'app' });
    // A page that has not navigated anywhere yet, as the real browser reports it.
    const status = world.browser.status.bind(world.browser);
    world.browser.status = async sessionId => {
      const seen = await status(sessionId);
      return { ...seen, pages: seen.pages.map(row => ({ ...row, url: 'about:blank' })) } as typeof seen;
    };

    const site = (await world.service
      .call(agent, { tool: 'account.hint', site: 'not a site' })
      .catch((caught: unknown) => caught)) as AgentToolError;
    const page = (await world.service
      .call(agent, { tool: 'account.hint', name: 'app' })
      .catch((caught: unknown) => caught)) as AgentToolError;

    should(site.code).equal('bad_request');
    should(site.message).containEql('Name a site');
    should(page.code).equal('bad_request');
    should(page.message).containEql('not on a site yet');
  });

  it('should say the saved logins cannot be read, never that there are none', async () => {
    const world = agentToolWorld({
      accounts: {
        list: async () => {
          throw new Error('the vault key is gone');
        },
      },
    });

    const error = (await world.service
      .call(agent, { tool: 'account.hint', site: 'github.com' })
      .catch((caught: unknown) => caught)) as AgentToolError;

    should(error.code).equal('unavailable');
    should(error.message).containEql('cannot be read');
  });

  it('should name the page in the audit when the hint was for a page', async () => {
    const world = agentToolWorld({ accounts: listing() });
    await world.service.call(agent, { tool: 'browser.open', name: 'app', url: 'https://vercel.com/' });
    await world.service.call(agent, { tool: 'account.hint', name: 'app' });
    should(world.audit.entries.at(-1)?.detail).match({ tool: 'account.hint', from: 'page', surface: '%browser:app' });
  });

  it('should be audited by how it was asked, never by what it answered', async () => {
    const world = agentToolWorld({ accounts: listing() });
    await world.service.call(agent, { tool: 'account.hint', site: 'vercel.com' });
    const record = world.audit.entries.at(-1);
    should(record?.detail).match({ tool: 'account.hint', from: 'site' });
    should(JSON.stringify(record)).not.containEql('kirin@example.com');
  });
});
