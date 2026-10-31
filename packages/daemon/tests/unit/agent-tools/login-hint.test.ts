import { describe, it } from 'bun:test';
import type { LoginEntrySummary } from '@ferretry/protocol';
import should from 'should';
import type { AgentToolError } from '../../../src/lib/index.ts';
import { agent, agentToolWorld, otherAgent } from './support.ts';

/** `login_hint`: what a ferret may know about signing in to a site, by the non-secret metadata of saved logins. */

const AT = '2026-10-31T09:00:00.000Z';
const ENTRIES: readonly LoginEntrySummary[] = [
  {
    id: 'GOOGLE_KIRIN',
    label: 'Google (kirin@)',
    match: ['accounts.google.com'],
    method: { kind: 'password' },
    domains: ['accounts.google.com'],
    username: 'kirin@example.com',
    fields: { password: true, totp: true },
    totp: { algorithm: 'SHA1', digits: 6, period: 30 },
    createdAt: AT,
    updatedAt: AT,
  },
  {
    id: 'VERCEL',
    label: 'Vercel',
    match: ['vercel.com'],
    method: { kind: 'google', via: 'GOOGLE_KIRIN' },
    domains: ['vercel.com'],
    fields: { password: false, totp: false },
    createdAt: AT,
    updatedAt: AT,
  },
];

const listing = (entries: readonly LoginEntrySummary[] = ENTRIES) => ({ list: async () => entries });

describe('login.hint', () => {
  it('should name the site login, how it signs in and the provider login, by metadata only', async () => {
    const world = agentToolWorld({ logins: listing() });

    const result = await world.service.call(agent, { tool: 'login.hint', site: 'https://vercel.com/login' });

    should(result.logins?.site).equal('vercel.com');
    should(result.logins?.passkeys).equal('off');
    should(result.logins?.hints.map(hint => [hint.id, hint.role])).deepEqual([
      ['VERCEL', 'site'],
      ['GOOGLE_KIRIN', 'provider'],
    ]);
    should(result.summary).containEql("Sign in with Google via 'Google (kirin@)'");
    should(result.summary).containEql('passkeys are off');
    const text = JSON.stringify(result);
    for (const leak of ['"fields"', '"totp"', 'SHA1']) should(text).not.containEql(leak);
  });

  it('should read the site from where the agent’s page IS, not from the agent', async () => {
    const world = agentToolWorld({ logins: listing() });
    await world.service.call(agent, { tool: 'browser.open', name: 'app', url: 'https://accounts.google.com/signin' });

    const result = await world.service.call(agent, { tool: 'login.hint', name: 'app' });

    should(result.logins?.site).equal('accounts.google.com');
    should(result.logins?.hints.map(hint => hint.id)).deepEqual(['GOOGLE_KIRIN']);
  });

  it('should refuse another session’s page', async () => {
    const world = agentToolWorld({ logins: listing() });
    await world.service.call(otherAgent, { tool: 'browser.open', name: 'app', url: 'https://vercel.com/' });

    const error = (await world.service
      .call(agent, { tool: 'login.hint', name: 'app' })
      .catch((caught: unknown) => caught)) as AgentToolError;

    should(error.code).equal('not_found');
  });

  it('should say when nothing is saved, and when this daemon keeps no saved logins', async () => {
    const none = await agentToolWorld({ logins: listing([]) }).service.call(agent, {
      tool: 'login.hint',
      site: 'github.com',
    });
    should(none.logins?.hints).deepEqual([]);
    should(none.summary).containEql('No saved login for github.com');

    const error = (await agentToolWorld()
      .service.call(agent, { tool: 'login.hint', site: 'github.com' })
      .catch((caught: unknown) => caught)) as AgentToolError;
    should(error.code).equal('unavailable');
  });

  it('should be audited by how it was asked, never by what it answered', async () => {
    const world = agentToolWorld({ logins: listing() });
    await world.service.call(agent, { tool: 'login.hint', site: 'vercel.com' });
    const record = world.audit.entries.at(-1);
    should(record?.detail).match({ tool: 'login.hint', from: 'site' });
    should(JSON.stringify(record)).not.containEql('kirin@example.com');
  });
});
