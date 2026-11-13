import { PERSON_ORIGIN } from '../../../../contract/index.ts';
import { expect, test } from 'bun:test';
import { FERRET_READABLE_FOLDERS, FerretsPort, FerretTokensFile } from '../../../../contract/index.ts';
import { FakeHarness, FakeRunner, ferretId } from '../../../../contract/testing/index.ts';
import { host as plainHost, record } from './route-fixture.ts';

/**
 * Today's read allowance (rebuild-ref `handoffFolders`, `fyd.ts:10841`): every launch names the hand-off folders of the
 * ferret's OWN session folder, so Claude reads its first turn without asking. 5.0: Ferrets hands them on the launch spec
 * (`LaunchSpec.readable`), resolved on the ferret's own `sessions` handle (the test host places it at `/sessions/<id>`).
 */
const host = async (...args: Parameters<typeof plainHost>) => {
  const h = await plainHost(...args);
  h.state('ferrets').plant(FerretTokensFile, JSON.stringify({ format: 1, tokens: [] }));
  return await h.restart();
};

/** Where the test host places a ferret's own `sessions` handle (production: `state/ferrets/sessions/<id>`). */
const sessionFolderOf = (_h: unknown, ferret: string): string => `/sessions/${ferret}`;

test('a start hands the harness exactly its own turns, channel and attachments folders, never the session folder', async () => {
  // Arrange
  const harness = new FakeHarness();
  const h = await host([], { harness, runner: new FakeRunner() });

  // Act: two ferrets start.
  for (const name of ['one', 'two'])
    await h.request('POST', '/v1/ferrets', { headers: { 'x-fy-request-id': name }, body: { folder: `/work/${name}` } });

  // Assert: each launch names its own folders only.
  expect(harness.launched).toHaveLength(2);
  const [first, second] = harness.launched;
  for (const spec of [first!, second!]) {
    const own = sessionFolderOf(h, spec.ferret);
    expect(spec.readable as readonly string[] | undefined).toEqual(
      FERRET_READABLE_FOLDERS.map(folder => `${own}/${folder}`),
    );
    expect(spec.readable).not.toContain(own);
    expect(spec.readable?.some(folder => folder.endsWith('environment.json'))).toBe(false);
  }
  const firstOwn = sessionFolderOf(h, first!.ferret);
  expect(second!.readable?.some(folder => folder.startsWith(`${firstOwn}/`))).toBe(false);
});

test('a resume hands the same own folders again', async () => {
  // Arrange: a stopped lead.
  const harness = new FakeHarness();
  const h = await host([{ ...record('lead'), state: 'stopped' as const }], { harness, runner: new FakeRunner() });

  // Act
  const resumed = await h.provided(FerretsPort).resume(ferretId('lead'), 'carry on', { origin: PERSON_ORIGIN });

  // Assert
  expect(resumed.ok).toBe(true);
  const own = sessionFolderOf(h, 'lead');
  expect(harness.launched.at(-1)?.readable as readonly string[] | undefined).toEqual(
    FERRET_READABLE_FOLDERS.map(folder => `${own}/${folder}`),
  );
});
