import { describe, it } from 'bun:test';
import should from 'should';
import { type HostDocumentRead, type HostHarnessScan, type ImportOptions } from '../../../daemon/lib/account/import.ts';
import { mergeImport, mergeImportRecord, planImport } from '../../../daemon/lib/account/import-plan.ts';

const digest = (text: string): string => String(Bun.hash(text));
const text = (source: string, body: string): HostDocumentRead => ({
  kind: 'text',
  source,
  text: body,
  bytes: body.length,
});

const scan = (harness: 'claude' | 'codex', login: HostHarnessScan['login']): HostHarnessScan => ({
  harness,
  command: `/bin/${harness}`,
  login,
  instructions: text('/h/words.md', '# words\n'),
  settings: text(
    '/h/settings',
    harness === 'claude' ? JSON.stringify({ model: 'claude-opus-5' }) : 'model = "gpt-5.6"\n',
  ),
  skills: [],
  missingCommands: [],
  problems: [],
});

/** The first import, committed (the configuration and its record), then the same scan planned again on top of it. */
const retried = (scans: readonly HostHarnessScan[], again: Partial<ImportOptions> = {}) => {
  const first = planImport(scans, { digest });
  const existing = mergeImport(undefined, first);
  const record = mergeImportRecord(first);
  return { first, existing, retry: planImport(scans, { digest, existing, record, ...again }) };
};

describe('planImport — a retry on the same committed import record', () => {
  for (const [store, login] of [
    ['host', { state: 'signed-in' }],
    ['ferretry', { state: 'not-shareable' }],
  ] as const) {
    for (const harness of ['claude', 'codex'] as const) {
      it(`should carry the ${harness} runtime and its ${store} login through instead of planning a "-2" copy`, () => {
        // Arrange
        const scans = [scan(harness, login)];

        // Act
        const { first, existing, retry } = retried(scans);

        // Assert: the first import made one runtime on one login of that store…
        should(Object.keys(first.runtimes)).deepEqual([`${harness}-default`]);
        should(Object.values(existing.credentials).map(credential => credential.store)).deepEqual([store]);
        // …and the retry adds no second runtime, no second login, and names the first as the one in use.
        should(retry.runtimes).deepEqual({});
        should(retry.credentials).deepEqual({});
        should(retry.profiles).deepEqual({});
        should(retry.duplicates.map(entry => entry.existing)).deepEqual([`${harness}-default`]);
        should(mergeImport(existing, retry).runtimes).deepEqual(existing.runtimes);
        should(mergeImport(existing, retry).credentials).deepEqual(existing.credentials);
      });
    }
  }

  it('should keep a Ferretry login the person already signed in, not overwrite it with an empty slot', () => {
    // Arrange
    const scans = [scan('codex', { state: 'not-shareable' })];
    const first = planImport(scans, { digest });
    const signedIn = mergeImport(undefined, first);
    const credentialId = Object.keys(signedIn.credentials)[0] as string;
    const withLogin = {
      ...signedIn,
      credentials: { [credentialId]: { harness: 'codex', store: 'ferretry', account: 'me' } },
    };

    // Act
    const retry = planImport(scans, {
      digest,
      existing: withLogin as typeof signedIn,
      record: mergeImportRecord(first),
    });

    // Assert
    should(retry.credentials).deepEqual({});
    should(Object.keys(retry.runtimes)).deepEqual([]);
  });

  it('should still plan a second runtime when the person asks for another anyway', () => {
    // Arrange
    const scans = [scan('claude', { state: 'not-shareable' })];

    // Act
    const { retry } = retried(scans, { addDuplicates: ['claude'] });

    // Assert: another runtime, on the SAME login (no second login is made for it).
    should(Object.keys(retry.runtimes)).deepEqual(['claude-default-2']);
    should(retry.credentials).deepEqual({});
  });

  it('should not reuse a runtime when there is no import record: that is a first import', () => {
    // Arrange
    const scans = [scan('codex', { state: 'not-shareable' })];
    const existing = mergeImport(undefined, planImport(scans, { digest }));

    // Act
    const plan = planImport(scans, { digest, existing });

    // Assert
    should(Object.keys(plan.credentials)).deepEqual(['codex-you-2']);
  });
});
