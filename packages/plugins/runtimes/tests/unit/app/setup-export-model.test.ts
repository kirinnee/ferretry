import { describe, expect, it } from 'bun:test';
import type { CloneReview } from '../../../contract/index.ts';
import { AGENT_CONTROL_KINDS, AGENT_CONTROL_WORDS } from '../../../app/features/fleet/machine/agent-control-words.ts';
import {
  controlsText,
  copyChange,
  decisionsFor,
  leaveOutChoice,
  outcomeCounts,
  reviewRequest,
  runnableRefs,
  settingsTexts,
  writeChoice,
  writesByDefault,
} from '../../../app/features/fleet/setup/copy-model.ts';
import { readExport } from '../../../app/features/fleet/setup/export-settings.tsx';
import {
  carriedFile,
  crc32,
  EXPORT_ROOT,
  exportFileName,
  exportManifest,
  exportPlan,
  LEFT_OUT_INVALID,
  LEFT_OUT_NOT_PROVEN,
  LEFT_OUT_NOT_WHOLE,
  secretReference,
  zipFiles,
} from '../../../app/features/fleet/setup/export-settings-model.ts';
import { scripted } from './support/client.ts';

const CONTROLS = {
  agentPermissions: 'auto' as const,
  defaultRuntime: 'claude-default',
  agentControl: { terminals: true, browsers: true, files: true, ferretrySettings: false, pageScripts: false },
};

describe('export settings: which files go in the zip', () => {
  it('carries every file the machine reports except an invalid one, and names the invalid one', () => {
    const plan = exportPlan({
      files: [
        { path: 'warden.yaml', state: 'ok' },
        { path: 'logins/work.yaml', state: 'invalid' },
        { path: 'voice.yaml', state: 'pending' },
      ],
    });
    expect(plan.include).toEqual(['warden.yaml', 'voice.yaml']);
    expect(plan.leftOut).toEqual([{ path: 'logins/work.yaml', reason: LEFT_OUT_INVALID }]);
  });

  it('leaves out a file the machine does not show whole (a hidden value, an issue) rather than carry masked text', () => {
    expect(carriedFile({ path: 'a.yaml', text: 'x: 1\n', issues: [] })).toEqual({
      file: { path: 'a.yaml', text: 'x: 1\n' },
    });
    expect(carriedFile({ path: 'a.yaml', text: 'x: 1\n' })).toEqual({ file: { path: 'a.yaml', text: 'x: 1\n' } });
    expect(
      carriedFile({
        path: 'b.yaml',
        text: '# hidden',
        issues: [{ path: 'b.yaml', severity: 'warning', message: 'a value is hidden' }],
      }),
    ).toEqual({ leftOut: { path: 'b.yaml', reason: LEFT_OUT_NOT_WHOLE } });
  });

  it('reads the files through the client and never carries one that is withheld or invalid', async () => {
    const reads: string[] = [];
    const client = scripted({
      'GET /v1/config/file': (call: { readonly query: Readonly<Record<string, string>> | undefined }) => {
        const path = call.query?.['path'] ?? '';
        reads.push(path);
        return path === 'secretish.yaml'
          ? {
              path,
              exists: true,
              text: '# hidden',
              etag: 'e',
              issues: [{ path, severity: 'error', message: 'the text of this file is not shown' }],
            }
          : { path, exists: true, text: `# ${path}\n`, etag: 'e', issues: [] };
      },
    });
    const read = await readExport(client, {
      files: [
        { path: 'warden.yaml', state: 'ok' },
        { path: 'secretish.yaml', state: 'ok' },
        { path: 'broken.yaml', state: 'invalid' },
      ],
    });
    expect(read.files.map(file => file.path)).toEqual(['warden.yaml']);
    expect(read.plan.leftOut.map(entry => entry.path).sort()).toEqual(['broken.yaml', 'secretish.yaml']);
    // An invalid file is never even read.
    expect(reads).not.toContain('broken.yaml');
  });
});

describe('export settings: the zip', () => {
  it('names the file by machine and day, and lists the promise of no secrets', () => {
    const when = new Date('2026-11-14T09:00:00Z');
    expect(exportFileName('Studio Mac!', when)).toBe('ferretry-settings-Studio-Mac-2026-11-14.zip');
    expect(exportFileName('???', when)).toBe('ferretry-settings-machine-2026-11-14.zip');
    expect(exportManifest('x.zip', [{ path: 'warden.yaml', text: '' }])).toBe(
      ['x.zip', `  ${EXPORT_ROOT}/warden.yaml`, `  # secrets: none (only ${secretReference('NAME')} references)`].join(
        '\n',
      ),
    );
  });

  it('builds a stored zip every unzip reads: local headers, central directory, end record, right checksums', () => {
    const when = new Date('2026-11-14T09:00:00Z');
    const bytes = zipFiles([{ path: 'a.yaml', text: 'hello\n' }], when);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(view.getUint32(0, true)).toBe(0x04034b50);
    expect(view.getUint32(14, true)).toBe(crc32(new TextEncoder().encode('hello\n')));
    expect(view.getUint32(bytes.length - 22, true)).toBe(0x06054b50);
    expect(view.getUint16(bytes.length - 22 + 10, true)).toBe(1);
    expect(new TextDecoder().decode(bytes.slice(30, 30 + `${EXPORT_ROOT}/a.yaml`.length))).toBe(
      `${EXPORT_ROOT}/a.yaml`,
    );
  });

  it('crc32 matches the published check value', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });
});

describe('agent controls', () => {
  it('words every switch the machine has, with the safety sentences kept in full', () => {
    expect(AGENT_CONTROL_KINDS).toEqual(['terminals', 'browsers', 'files', 'ferretrySettings', 'pageScripts']);
    for (const kind of AGENT_CONTROL_KINDS) expect(AGENT_CONTROL_WORDS[kind].detail.length).toBeGreaterThan(10);
    expect(AGENT_CONTROL_WORDS.pageScripts.detail).toContain('sign-ins');
  });
});

const review = (overrides: Partial<CloneReview> = {}): CloneReview => ({
  mode: 'first',
  source: { name: 'work-mac', verified: 'browser' },
  items: [],
  settings: [],
  logins: [],
  keys: [],
  same: { count: 0, probable: 0 },
  fingerprint: 'fp',
  ...overrides,
});

const request = reviewRequest({
  bundle: { format: 1 } as never,
  source: { daemonId: 'fy_daemon_src', name: 'work-mac' },
  targetName: 'studio',
  settings: [{ path: 'controls', text: controlsText(CONTROLS as never) }],
});

describe('copy settings: what is handed over', () => {
  it('sends the source’s controls as JSON and a settings file it shows whole, and says which it left out', () => {
    const { settings, leftOut } = settingsTexts(
      [
        { path: 'warden.yaml', exists: true, text: 'a: 1\n', issues: [] },
        { path: 'learning.yaml', exists: false, text: '', issues: [] },
        { path: 'voice.yaml', exists: true, text: '# hidden', issues: [{}] },
      ],
      CONTROLS as never,
    );
    expect(settings.map(doc => doc.path)).toEqual(['warden.yaml', 'learning.yaml', 'controls']);
    expect(settings.find(doc => doc.path === 'learning.yaml')?.text).toBe('');
    expect(leftOut).toEqual(['voice.yaml']);
    expect(JSON.parse(settings.find(doc => doc.path === 'controls')?.text ?? '{}')).toEqual(CONTROLS);
  });

  it('names the two machines and the source daemon in the review request', () => {
    expect(request.source).toEqual({ daemonId: 'fy_daemon_src' });
    expect(request.names).toEqual({ source: 'work-mac', target: 'studio' });
  });
});

describe('copy settings: the change a review makes', () => {
  it('a first copy is the chosen mode, with the components the person left out', () => {
    const made = copyChange({ review: review(), request, choices: { skip: ['mcp/notes'], mode: 'replace' } });
    expect(made).toMatchObject({ kind: 'clone.import', mode: 'replace', skip: ['mcp/notes'] });
    const plain = copyChange({ review: review(), request, choices: { skip: [], mode: 'alongside' } });
    expect('skip' in plain).toBe(false);
  });

  it('a repeat copy takes the defaults the review chose, keeps the settings, and carries the review’s fingerprint', () => {
    const repeat = review({
      mode: 'update',
      items: [
        { ref: 'profile/a', kind: 'profile', outcome: 'theirs', match: 'key', choice: 'take', files: [] },
        { ref: 'mcp/n', kind: 'mcp', outcome: 'new', match: 'none', choice: 'add', files: [] },
      ],
      settings: [
        { path: 'warden.yaml', keys: [{ key: 'mode', outcome: 'theirs', choice: 'take', mine: 'a', theirs: 'b' }] },
      ],
      logins: [{ sourceId: 'work', outcome: 'ask' }],
    });
    expect(decisionsFor(repeat, { skip: [] })).toEqual({
      decisions: { 'profile/a': 'take', 'mcp/n': 'add' },
      settingsDecisions: { 'warden.yaml': { mode: 'take' } },
      logins: { work: 'slot' },
    });
    const made = copyChange({ review: repeat, request, choices: { skip: [], mode: 'alongside' } });
    expect(made).toMatchObject({ mode: 'update', reviewed: 'fp', settings: [{ path: 'controls' }] });
  });

  it('keeps what is here where both machines changed it, unless the person ticked it; a left-out item is kept or skipped', () => {
    const both = review({
      mode: 'update',
      items: [
        { ref: 'profile/a', kind: 'profile', outcome: 'both', match: 'key', files: [] },
        { ref: 'mcp/n', kind: 'mcp', outcome: 'new', match: 'none', choice: 'add', files: [] },
        { ref: 'mcp/t', kind: 'mcp', outcome: 'theirs', match: 'key', choice: 'take', files: [] },
      ],
      settings: [{ path: 'voice.yaml', keys: [{ key: 'k', outcome: 'both', mine: '1', theirs: '2' }] }],
    });
    // Nothing is written that nobody chose: a changed-on-both item and key are kept.
    expect(decisionsFor(both, { skip: [] })).toMatchObject({
      decisions: { 'profile/a': 'keep', 'mcp/n': 'add', 'mcp/t': 'take' },
      settingsDecisions: { 'voice.yaml': { k: 'keep' } },
    });
    // The person ticks the both-changed one and leaves two out.
    expect(decisionsFor(both, { skip: ['mcp/n', 'mcp/t'], take: ['profile/a'] }).decisions).toEqual({
      'profile/a': 'take',
      'mcp/n': 'skip',
      'mcp/t': 'keep',
    });
    expect([leaveOutChoice('new'), leaveOutChoice('theirs'), leaveOutChoice('both')]).toEqual(['skip', 'keep', 'keep']);
    expect([writeChoice('new'), writeChoice('theirs'), writeChoice('removed-here')]).toEqual(['add', 'take', 'add']);
    expect(writesByDefault(both.items[0] as never)).toBe(false);
    expect(writesByDefault(both.items[1] as never)).toBe(true);
  });

  it('lists what would run and counts the outcomes', () => {
    const r = review({
      items: [
        {
          ref: 'mcp/n',
          kind: 'mcp',
          outcome: 'new',
          match: 'none',
          files: [],
          runnable: { reference: 'mcp/n', kind: 'mcp', name: 'n', entries: [] },
        },
        { ref: 'profile/a', kind: 'profile', outcome: 'new', match: 'none', files: [] },
      ],
    });
    expect(runnableRefs(r)).toEqual(['mcp/n']);
    expect(outcomeCounts(r)).toEqual({ new: 2 });
  });
});

describe('export settings: nothing that may hold a credential is carried', () => {
  // A literal shaped like a secret NAME under a credential-named key is a value as far as any file can tell. The machine
  // may show it whole (no issue reported), so the export decides for itself, and fails closed.
  const LEAK = 'command: fixture-server\nenv:\n  API_KEY: FIXTUREKEY\n';

  it('leaves out a file whose text may hold a credential even when the machine reported no issue with it', () => {
    const answer = carriedFile({ path: 'mcp/fixture.yaml', text: LEAK, issues: [] });
    expect(answer).toEqual({ leftOut: { path: 'mcp/fixture.yaml', reason: LEFT_OUT_NOT_PROVEN } });
  });

  it('never puts such a value in the zip, through the whole read: status, file, plan, zip', async () => {
    const client = scripted({
      'GET /v1/config/file': (call: { readonly query: Readonly<Record<string, string>> | undefined }) => ({
        path: call.query?.['path'],
        exists: true,
        text: call.query?.['path'] === 'mcp/fixture.yaml' ? LEAK : 'enabled: true\n',
        etag: 'e',
        issues: [],
      }),
    });
    const read = await readExport(client, {
      files: [
        { path: 'mcp/fixture.yaml', state: 'ok' },
        { path: 'warden.yaml', state: 'ok' },
      ],
    });
    expect(read.files.map(file => file.path)).toEqual(['warden.yaml']);
    expect(read.plan.leftOut.map(entry => entry.path)).toEqual(['mcp/fixture.yaml']);
    const zipped = new TextDecoder().decode(zipFiles(read.files, new Date('2026-11-14T00:00:00Z')));
    expect(zipped).not.toContain('FIXTUREKEY');
  });

  it('still carries a file that holds only pointers and plain settings', () => {
    const text = 'command: fixture-server\nenv:\n  API_KEY: ${secret:FIXTURE_KEY}\n  LOG_LEVEL: debug\n';
    expect(carriedFile({ path: 'mcp/fixture.yaml', text, issues: [] })).toEqual({
      file: { path: 'mcp/fixture.yaml', text },
    });
  });
});
