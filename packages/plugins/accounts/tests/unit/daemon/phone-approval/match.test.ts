import { describe, it } from 'bun:test';
import type { TerminalFacts } from '@ferretry/core-vault/contract';
import should from 'should';
import type { Place } from '../../../../contract/routes/index.ts';
import { approvalFacts, matchSignIn, terminalMatchKey } from '../../../../daemon/lib/phone-approval/match.ts';
import { CountingSealed, daemonOver, MemoryLoginIndex } from '../support.ts';

/** Which sign-in an approval is for: decided from what the daemon observed, never from the ferret's words. */

const site = (...domains: string[]): Place => ({ kind: 'site', domains, match: domains });
const terminal = (tool: string, host: string, dest?: string): Place =>
  ({ kind: 'terminal', tool, host, ...(dest === undefined ? {} : { dest }) }) as Place;

const facts = (program: string | undefined, argv: string, canonical = true): TerminalFacts =>
  ({
    kind: 'terminal',
    foreground: { pid: 2, pgid: 2, comm: program ?? 'x', argv },
    program,
    canonical,
  }) as never;

describe('the terminal key an approval matches on', () => {
  it('should key an ssh-family program by the destination host it names, whatever options come first', () => {
    should(terminalMatchKey(facts('ssh', 'ssh build.example.com'), 'kirin-box.local')).equal('ssh@build.example.com');
    should(terminalMatchKey(facts('ssh', 'ssh -p 22 -i key kirin@Build.Example.com'), 'kirin-box')).equal(
      'ssh@build.example.com',
    );
    should(terminalMatchKey(facts('ssh', 'ssh -o StrictHostKeyChecking=no -- deploy@ci.example.com:22'), 'x')).equal(
      'ssh@ci.example.com',
    );
    should(terminalMatchKey(facts('sftp', 'sftp sftp://me@files.example.com'), 'x')).equal('sftp@files.example.com');
  });

  it('should key any other program by this machine’s short name, in line mode only', () => {
    should(terminalMatchKey(facts('sudo', 'sudo -v'), 'Kirin-Box.local')).equal('sudo@kirin-box');
    should(terminalMatchKey(facts('sudo', 'sudo -v', false), 'kirin-box')).be.undefined();
    should(terminalMatchKey(facts(undefined, ''), 'kirin-box')).be.undefined();
    should(terminalMatchKey(facts('  ', ''), 'kirin-box')).be.undefined();
  });

  it('should key nothing when the destination or this machine’s name cannot be read', () => {
    should(terminalMatchKey(facts('ssh', 'ssh'), 'kirin-box')).be.undefined();
    should(terminalMatchKey(facts('ssh', 'ssh --'), 'kirin-box')).be.undefined();
    should(terminalMatchKey(facts('ssh', 'ssh -p'), 'kirin-box')).be.undefined();
    should(terminalMatchKey(facts('ssh', 'ssh @'), 'kirin-box')).be.undefined();
    should(terminalMatchKey(facts('sudo', 'sudo'), '')).be.undefined();
    should(terminalMatchKey(facts('sudo', 'sudo'), '.local')).be.undefined();
  });
});

async function accounts() {
  const w = daemonOver(new MemoryLoginIndex(), new CountingSealed());
  await w.directory.putAccount('OKTA', { label: 'Okta', username: 'me@company.test' });
  await w.directory.putAccount('CLICKUP', { label: 'ClickUp', username: 'me@clickup.test' });
  await w.directory.putAccount('GOOGLE', { label: 'Google' });
  const okta = await w.directory.addSignIn('OKTA', { place: site('login.company.test') });
  const google = await w.directory.addSignIn('GOOGLE', { place: site('accounts.google.com') });
  const clickup = await w.directory.addSignIn('CLICKUP', {
    place: site('app.clickup.com'),
    method: { kind: 'google', via: 'OKTA' },
  });
  const shell = await w.directory.addSignIn('OKTA', { place: terminal('ssh', 'kirin-box', 'build.example.com') });
  await w.directory.addFactor('OKTA', { kind: 'push', label: 'Okta Verify', app: 'okta-verify' });
  return { ...w, okta, google, clickup, shell, listing: async () => await w.directory.list() };
}

describe('which sign-in an approval is for', () => {
  it('should match the sign-in that signs in at the key, with its account, username and the one push factor', async () => {
    const w = await accounts();

    const matched = matchSignIn('login.company.test', await w.listing(), {});

    should(matched.signIn).equal(w.okta.id);
    should(matched.account).eql({ id: 'OKTA', label: 'Okta' });
    should(matched.username).equal('me@company.test');
    should(matched.via).be.undefined();
    should(matched.factor?.label).equal('Okta Verify');
    should(matched.factor?.app).equal('okta-verify');
    should([...matched.domains]).eql(['login.company.test']);
    should([...matched.providerDomains]).eql([]);
  });

  it('should name the provider and allow its domains when the hint’s sign-in goes via the provider whose page this is', async () => {
    const w = await accounts();

    const matched = matchSignIn('login.company.test', await w.listing(), { secretHint: 'CLICKUP' as never });
    const bySignIn = matchSignIn('login.company.test', await w.listing(), { secretHint: w.clickup.id as never });

    for (const each of [matched, bySignIn]) {
      should(each.signIn).equal(w.clickup.id);
      should(each.account).eql({ id: 'CLICKUP', label: 'ClickUp' });
      should(each.via).eql({ id: 'OKTA', label: 'Okta' });
      should([...each.domains].sort()).eql(['app.clickup.com', 'login.company.test']);
      should([...each.providerDomains]).eql(['login.company.test']);
    }
  });

  it('should ignore a hint that reaches nothing here, and match nothing when nothing signs in at the key', async () => {
    const w = await accounts();

    const stray = matchSignIn('login.company.test', await w.listing(), { secretHint: 'GOOGLE' as never });
    const unknown = matchSignIn('unknown.example', await w.listing(), { secretHint: 'CLICKUP' as never });
    const keyless = matchSignIn(undefined, await w.listing(), {});

    should(stray.signIn).equal(w.okta.id);
    should(unknown.signIn).be.undefined();
    should(unknown.domains.size).equal(0);
    should(keyless.signIn).be.undefined();
  });

  it('should pick the push factor the ferret named, and none when several could be meant', async () => {
    const w = await accounts();
    const second = await w.directory.addFactor('OKTA', { kind: 'push', label: 'Duo', app: 'duo' });

    const several = matchSignIn('login.company.test', await w.listing(), {});
    const named = matchSignIn('login.company.test', await w.listing(), { factor: second.id });

    should(several.factor).be.undefined();
    should(named.factor?.label).equal('Duo');
  });

  it('should match nothing when the provider the chain reaches has no account in the listing', async () => {
    const w = await accounts();
    const listing = await w.listing();
    const withoutOkta = { ...listing, accounts: listing.accounts.filter(each => each.id !== 'OKTA') };

    const matched = matchSignIn('login.company.test', withoutOkta, { secretHint: 'CLICKUP' as never });

    should(matched.signIn).be.undefined();
    should(matched.via).be.undefined();
    should(matched.domains.size).equal(0);
  });

  it('should stop following a via chain that never reaches the key, even when it loops back on itself', async () => {
    const w = await accounts();
    const listing = await w.listing();
    // Okta now goes via ClickUp, and ClickUp via Okta: a loop that never signs in at the key.
    const looping = {
      ...listing,
      signIns: listing.signIns.map(each =>
        each.id === w.okta.id ? { ...each, via: { account: { id: 'CLICKUP', label: 'ClickUp' } } } : each,
      ),
    } as typeof listing;

    const matched = matchSignIn('somewhere.else.test', looping, { secretHint: 'CLICKUP' as never });

    should(matched.signIn).be.undefined();
    should(matched.via).be.undefined();
  });

  it('should match a terminal sign-in without any login domains', async () => {
    const w = await accounts();

    const matched = matchSignIn('ssh@build.example.com', await w.listing(), {});

    should(matched.signIn).equal(w.shell.id);
    should(matched.domains.size).equal(0);
  });
});

describe('the facts an approval card takes from a match', () => {
  it('should carry only what the daemon matched: sign-in, account, username, provider and factor', async () => {
    const w = await accounts();

    const facts = approvalFacts(
      matchSignIn('login.company.test', await w.listing(), { secretHint: 'CLICKUP' as never }),
    );

    should(facts.signIn).equal(w.clickup.id);
    should(facts.account).eql({ id: 'CLICKUP', label: 'ClickUp' });
    should(facts.username).equal('me@clickup.test');
    should(facts.via).eql({ id: 'OKTA', label: 'Okta' });
    should(facts.factor).be.undefined();
  });

  it('should include the push factor when one was matched, and nothing at all for an empty match', async () => {
    const w = await accounts();

    const factorFacts = approvalFacts(matchSignIn('login.company.test', await w.listing(), {}));
    const empty = approvalFacts(matchSignIn(undefined, await w.listing(), {}));

    should(factorFacts.factor).match({ label: 'Okta Verify', app: 'okta-verify' });
    should(factorFacts.via).be.undefined();
    should(empty).eql({});
  });
});
