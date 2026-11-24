import { describe, expect, it } from 'bun:test';
import {
  type RuntimeNameSource,
  harnessWord,
  isMachineMadeRuntimeName,
  runtimeAccounts,
  runtimeAccountsFrom,
  runtimeDisplayName,
} from '../../contract/index.ts';

const source = (overrides: Partial<RuntimeNameSource> & Pick<RuntimeNameSource, 'harness'>): RuntimeNameSource => ({
  name: overrides.harness === 'codex' ? 'codex-you' : 'claude-you',
  credential: { id: overrides.harness === 'codex' ? 'codex-you' : 'claude-you', store: 'host' },
  ...overrides,
});

describe('how a runtime is named for a person (O9-5)', () => {
  it('names every kind of login by where its sign-in comes from', () => {
    const rows: readonly (readonly [string, RuntimeNameSource, string])[] = [
      ['Claude on the terminal sign-in', source({ harness: 'claude-code' }), 'Claude · your terminal sign-in'],
      ['Codex on the terminal sign-in', source({ harness: 'codex' }), 'Codex · your terminal sign-in'],
      [
        'Claude signed in inside Ferretry',
        source({ harness: 'claude-code', credential: { id: 'work', store: 'ferretry' } }),
        'Claude · Claude.ai sign-in',
      ],
      [
        'Codex signed in inside Ferretry',
        source({ harness: 'codex', credential: { id: 'work', store: 'ferretry' } }),
        'Codex · ChatGPT sign-in',
      ],
      [
        'a key with no provider named',
        source({ harness: 'claude-code', credential: { id: 'key', store: 'environment' } }),
        'Claude · API key',
      ],
      [
        'a Codex key with no provider named',
        source({ harness: 'codex', credential: { id: 'key', store: 'environment' } }),
        'Codex · API key',
      ],
      [
        'a key of a named provider',
        source({
          harness: 'claude-code',
          credential: { id: 'glm', store: 'environment' },
          models: { catalog: { label: 'GLM / Z.ai' } },
        }),
        'Claude · GLM / Z.ai',
      ],
    ];
    for (const [, input, expected] of rows) expect(runtimeDisplayName(input)).toBe(expected);
  });

  it('appends the label the owner gave the login', () => {
    expect(
      runtimeDisplayName(
        source({ harness: 'claude-code', credential: { id: 'claude-you', store: 'host', label: 'work' } }),
      ),
    ).toBe('Claude · your terminal sign-in (work)');
    expect(
      runtimeDisplayName(source({ harness: 'codex', credential: { id: 'codex-you', store: 'host', label: '  ' } })),
    ).toBe('Codex · your terminal sign-in');
  });

  it('shows a name the owner chose exactly as typed', () => {
    expect(runtimeDisplayName(source({ harness: 'claude-code', name: 'Atelier' }))).toBe('Atelier');
    expect(runtimeDisplayName(source({ harness: 'codex', name: 'reviewer' }))).toBe('reviewer');
    // The other CLI's word is not this runtime's own machine-made shape.
    expect(runtimeDisplayName(source({ harness: 'claude-code', name: 'codex-fast' }))).toBe('codex-fast');
  });

  it('reads the names the machine makes as machine-made', () => {
    const claude = source({ harness: 'claude-code' });
    for (const name of ['claude-you', 'claude-default', 'claude-default-2', 'claude']) {
      expect(isMachineMadeRuntimeName({ ...claude, name })).toBe(true);
    }
    // A derived runtime is named by its login's id, whatever that id is spelled like.
    expect(isMachineMadeRuntimeName({ ...claude, name: 'work', credential: { id: 'work', store: 'ferretry' } })).toBe(
      true,
    );
    expect(isMachineMadeRuntimeName({ ...claude, name: 'Claude Atelier' })).toBe(false);
  });

  it('tells two runtimes on one login apart by their profile, and by their stored name when that is the same too', () => {
    const first = source({ harness: 'claude-code', name: 'claude-default', profile: 'Default' });
    const second = source({ harness: 'claude-code', name: 'claude-atomi', profile: 'Atomi' });
    const owned = source({ harness: 'claude-code', name: 'Atelier' });
    const other = source({ harness: 'codex' });
    expect(runtimeDisplayName(first, [first, second, owned, other])).toBe(
      'Claude · your terminal sign-in — Default profile',
    );
    expect(runtimeDisplayName(second, [first, second])).toBe('Claude · your terminal sign-in — Atomi profile');
    const same = source({ harness: 'claude-code', name: 'claude-twin', profile: 'Default' });
    expect(runtimeDisplayName(same, [first, same])).toBe('Claude · your terminal sign-in — claude-twin');
    expect(runtimeDisplayName(first, [first, same])).toBe('Claude · your terminal sign-in — claude-default');
    // Alone on its login, a runtime reads plainly; a runtime the owner named never takes the suffix or gives one.
    expect(runtimeDisplayName(first, [first, owned, other])).toBe('Claude · your terminal sign-in');
    expect(runtimeDisplayName(owned, [first, second, owned])).toBe('Atelier');
  });

  it('tells two accounts apart by what their login shows, never by a credential', () => {
    const one = source({ harness: 'claude-code', name: 'claude-you', credential: { id: 'login-a', store: 'host' } });
    const two = source({ harness: 'claude-code', name: 'claude-you-2', credential: { id: 'login-b', store: 'host' } });
    const accounts = runtimeAccounts([
      { id: 'login-a', email: 'kirin@one.example', status: {} },
      { id: 'login-b', email: 'kirin@two.example', status: {} },
    ]);
    expect(runtimeDisplayName(one, [one, two], accounts)).toBe('Claude · your terminal sign-in — kirin@one.example');
    expect(runtimeDisplayName(two, [one, two], accounts)).toBe('Claude · your terminal sign-in — kirin@two.example');
    // Without the account words the stored names are the only thing left, as before.
    expect(runtimeDisplayName(one, [one, two])).toBe('Claude · your terminal sign-in — claude-you');
    // A login that shows a plan and no email is told apart by its plan.
    const plans = runtimeAccounts([
      { id: 'login-a', status: { planType: 'Pro' } },
      { id: 'login-b', status: { planType: 'Plus' } },
    ]);
    expect(runtimeDisplayName(two, [one, two], plans)).toBe('Claude · your terminal sign-in — Plus');
  });

  it('falls back to profile, then stored name, when both runtimes are on one account', () => {
    const one = source({
      harness: 'claude-code',
      name: 'claude-you',
      profile: 'Default',
      credential: { id: 'a', store: 'host' },
    });
    const two = source({
      harness: 'claude-code',
      name: 'claude-you-2',
      profile: 'Fast',
      credential: { id: 'b', store: 'host' },
    });
    const same = runtimeAccounts([
      { id: 'a', email: 'kirin@one.example', status: {} },
      { id: 'b', email: 'kirin@one.example', status: {} },
    ]);
    expect(runtimeDisplayName(one, [one, two], same)).toBe('Claude · your terminal sign-in — Default profile');
    expect(runtimeDisplayName(two, [one, two], same)).toBe('Claude · your terminal sign-in — Fast profile');
  });

  it('reads the account words out of a login list answer, and out of nothing when it is not one', () => {
    const answer = {
      format: 1,
      logins: [
        { id: 'a', email: 'kirin@one.example', status: { word: 'ready' }, token: 'never-read' },
        { id: 'b', status: { word: 'ready', planType: 'Pro' } },
        { id: 'c', status: { word: 'ready' } },
      ],
    };
    expect([...runtimeAccountsFrom(answer)]).toEqual([
      ['a', 'kirin@one.example'],
      ['b', 'Pro'],
    ]);
    expect(runtimeAccountsFrom(undefined).size).toBe(0);
    expect(runtimeAccountsFrom({ logins: 'no' }).size).toBe(0);
  });

  it('says the harness in the words a person uses', () => {
    expect(harnessWord('claude-code')).toBe('Claude');
    expect(harnessWord('codex')).toBe('Codex');
  });
});
