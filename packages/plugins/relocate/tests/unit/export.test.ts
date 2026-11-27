import { describe, expect, test } from 'bun:test';
import { MOVES, STAYS } from '../../contract/index.ts';
import { CONVERSATION, FERRET, HISTORY, NEVER_LISTED, SESSION_FILES } from '../support/fake-ferrets.ts';
import { openBundle } from '../support/open-bundle.ts';
import { world } from '../support/world.ts';

/** Exports once and opens the bundle with the target's own one-time key, as the target would. */
async function exported(options: Parameters<typeof world>[0] = {}) {
  const w = await world({ ...options, extra: { ...NEVER_LISTED, ...(options.extra ?? {}) } });
  const made = await w.offer();
  const result = await w.relocation.export(FERRET, made.offer);
  const chunks = Array.from({ length: result.header.chunks }, (_, index) => w.relocation.chunk(result.exportId, index));
  const opened = await openBundle(made.privateKey, made.offer.offerId, result.header, chunks);
  return { w, made, result, chunks, opened };
}

describe('the snapshot lists exactly what the table says moves', () => {
  test('a fixture ferret in a real git tree seals its record, journal, session files, conversation and tree', async () => {
    const { opened } = await exported();
    expect(opened).toBeDefined();
    const keys = [...(opened?.files.keys() ?? [])].sort();
    expect(keys).toEqual(
      [
        'ferret-record:record.json',
        'journal:history.jsonl',
        ...Object.keys(SESSION_FILES).map(path => `session:${path}`),
        `conversation:${CONVERSATION.relPath}`,
        'worktree-commits:commits.bundle',
        'worktree-changes:changes.diff',
        'worktree-file:new.txt',
      ].sort(),
    );
    const files = opened?.files;
    expect(new TextDecoder().decode(files?.get('journal:history.jsonl'))).toBe(HISTORY);
    expect(new TextDecoder().decode(files?.get('session:turns/turn-001.md'))).toBe(
      SESSION_FILES['turns/turn-001.md'] as string,
    );
    expect(new TextDecoder().decode(files?.get('worktree-file:new.txt'))).toBe('a new file\n');
    expect(new TextDecoder().decode(files?.get('worktree-changes:changes.diff'))).toContain('+changed');
    // the unpushed commit is in the bundle, the pushed one is not: it is already on the remote
    expect(new TextDecoder().decode(files?.get('worktree-commits:commits.bundle')).slice(0, 16)).toContain(
      'git bundle',
    );
    expect(opened?.manifest.worktree?.branch).toBe('main');
    expect(MOVES.map(row => row.id)).toContain('worktree-untracked');
  });

  test('the ferret record carries only the fields the table names', async () => {
    const { opened } = await exported();
    const record = JSON.parse(new TextDecoder().decode(opened?.files.get('ferret-record:record.json'))) as Record<
      string,
      unknown
    >;
    expect(Object.keys(record).sort()).toEqual(['harness', 'name', 'role']);
    expect(record).not.toHaveProperty('folder');
    expect(record).not.toHaveProperty('handle');
  });
});

describe('what must not move is absent from the sealed bundle (opened with the test key)', () => {
  test('environment.json, tokens.json and media/ are left behind even when a source lists them', async () => {
    const { opened } = await exported();
    const paths = [...(opened?.files.keys() ?? [])].join('\n');
    for (const name of ['environment.json', 'tokens.json', 'media/leak.png']) expect(paths).not.toContain(name);
    for (const value of ['SESSION-CREDENTIAL-VALUE-aa11', 'TOKENS-VALUE-bb22', 'MEDIA-VALUE-cc33'])
      expect(new TextDecoder().decode(opened?.plaintext)).not.toContain(value);
  });

  test('a secret-named attachment (id_rsa) is left behind and named', async () => {
    const { opened, w } = await exported();
    expect([...(opened?.files.keys() ?? [])].join('\n')).not.toContain('id_rsa');
    expect(new TextDecoder().decode(opened?.plaintext)).not.toContain('ATTACHED-SECRET-NAME-VALUE-dd44');
    const view = await w.relocation.preflight(FERRET, (await w.offer()).offer.daemonId);
    expect(view.withheld).toContain('attachments/id_rsa');
  });

  test('a git-ignored .env and node_modules are absent, and named as staying', async () => {
    const { opened, w } = await exported();
    const text = new TextDecoder().decode(opened?.plaintext);
    expect(text).not.toContain(w.fixture.secrets['.env'] as string);
    expect([...(opened?.files.keys() ?? [])].join('\n')).not.toContain('node_modules');
    const view = await w.relocation.preflight(FERRET, (await w.offer()).offer.daemonId);
    expect(view.ignored).toEqual(expect.arrayContaining(['.env', 'node_modules']));
  });

  test('a new file git does NOT ignore but whose name says secret (.env.local, *.pem) stays too', async () => {
    const { opened, w } = await exported();
    const text = new TextDecoder().decode(opened?.plaintext);
    expect(text).not.toContain(w.fixture.secrets['.env.local'] as string);
    expect(text).not.toContain(w.fixture.secrets['deploy.pem'] as string);
    const view = await w.relocation.preflight(FERRET, (await w.offer()).offer.daemonId);
    expect(view.withheld).toEqual(expect.arrayContaining(['.env.local', 'deploy.pem']));
  });

  test('the harness’s credential file auth.json never rides, wherever it sits', async () => {
    const { opened } = await exported({ extra: { 'attachments/auth.json': 'HARNESS-AUTH-VALUE-ee55' } });
    expect(new TextDecoder().decode(opened?.plaintext)).not.toContain('HARNESS-AUTH-VALUE-ee55');
  });

  test('every row of the stays table has a test above, and no row is a secret value', () => {
    expect(STAYS.map(row => row.id)).toEqual([
      'session-credential',
      'harness-secrets',
      'ignored-files',
      'secret-named-files',
      'secret-values',
      'browser',
      'jobs',
      'ledger',
    ]);
  });
});
