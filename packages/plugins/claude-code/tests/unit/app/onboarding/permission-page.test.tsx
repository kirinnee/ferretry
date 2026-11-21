/** The permission page: it names the real flag, shows the current mode, and writes only `permissionMode`. */
import { interact, type Mounted, mount, must } from '@ferretry/app/testing';
import { readConfigText } from '@ferretry/std/yaml';
import { afterEach, describe, expect, it } from 'bun:test';
import {
  PermissionPage,
  permissionRead,
  withPermissionMode,
} from '../../../../app/features/onboarding/permission-page.tsx';
import { type Call, scripted, stepHarness } from '../../../fixtures/onboarding/harness.ts';

const mounted: Mounted[] = [];
afterEach(async () => {
  for (const view of mounted.splice(0)) await view.unmount();
});
const settle = async (): Promise<void> => {
  await interact(async () => {
    for (let turn = 0; turn < 20; turn += 1) await new Promise(resolve => setTimeout(resolve, 0));
  });
};

const WITHHELD_TEXT =
  '# ‹hidden›: the text of this file is not shown because it holds a raw secret, which the owner must move into the secret store; edit it at the machine\n';
const FILE =
  'binary: /fake/bin/claude # my own\nsearchPaths:\n  - /fake/bin\npermissionMode: skip\ndangerousRmWaiver: false\n';

const open = async (table: Record<string, unknown>, calls: Call[]) => {
  const run = stepHarness();
  const view = await mount(<PermissionPage client={scripted(table, calls)} step={run.step} />);
  mounted.push(view);
  await settle();
  return { view, run };
};

const select = (view: Mounted, value: string) =>
  interact(() => must(view.container.querySelector<HTMLInputElement>(`input[value="${value}"]`), value).click());

describe('the permission text', () => {
  it('reads the mode, defaulting to skip (owner !A525)', () => {
    const mode = (text: string) => permissionRead(text);
    expect(mode(FILE)).toEqual({ kind: 'mode', mode: 'skip' });
    expect(mode('permissionMode: auto\n')).toEqual({ kind: 'mode', mode: 'auto' });
    expect(mode("permissionMode: 'auto' # asks\n")).toEqual({ kind: 'mode', mode: 'auto' });
    expect(mode('')).toEqual({ kind: 'mode', mode: 'skip' });
    expect(mode('# only a comment\n')).toEqual({ kind: 'mode', mode: 'skip' });
    expect(mode('binary: /x\n')).toEqual({ kind: 'mode', mode: 'skip' });
  });

  it('reads every YAML form of the key the same way (flow map, folded scalar, quoted, document marker)', () => {
    const auto = { kind: 'mode', mode: 'auto' } as const;
    expect(permissionRead('{permissionMode: auto, dangerousRmWaiver: false}\n')).toEqual(auto);
    expect(permissionRead('permissionMode: >-\n  auto\ndangerousRmWaiver: false\n')).toEqual(auto);
    expect(permissionRead('permissionMode: "auto"\n')).toEqual(auto);
    expect(permissionRead('---\npermissionMode: auto\n...\n')).toEqual(auto);
    expect(permissionRead('binary: x\n# permissionMode: skip\npermissionMode: auto\n')).toEqual(auto);
  });

  it('says unknown, never skip, for what it cannot read: a bad value, a non-map, broken YAML, a withheld text', () => {
    const unknown = { kind: 'unknown' } as const;
    expect(permissionRead('permissionMode: nonsense\n')).toEqual(unknown);
    expect(permissionRead('- a\n- b\n')).toEqual(unknown);
    expect(permissionRead('permissionMode: [auto\n')).toEqual(unknown);
    expect(permissionRead(WITHHELD_TEXT)).toEqual(unknown);
    expect(permissionRead('permissionMode: auto\n', 'invalid')).toEqual(unknown);
  });

  it('sets only the permissionMode key, in every form, keeping the other keys and the comments', () => {
    const parsedValue = (text: string) =>
      (readConfigText(text) as { read: { value: Record<string, unknown> } }).read.value;
    expect(withPermissionMode(FILE, 'auto')).toBe(FILE.replace('permissionMode: skip', 'permissionMode: auto'));
    expect(withPermissionMode('', 'auto')).toBe('permissionMode: auto\n');
    expect(withPermissionMode('binary: /x\n', 'skip')).toBe('binary: /x\npermissionMode: skip\n');
    const flow = withPermissionMode('{permissionMode: skip, dangerousRmWaiver: false}\n', 'auto');
    expect(parsedValue(flow)).toEqual({ permissionMode: 'auto', dangerousRmWaiver: false });
    const folded = withPermissionMode('# mine\npermissionMode: >-\n  skip\ndangerousRmWaiver: true\n', 'auto');
    expect(parsedValue(folded)).toEqual({ permissionMode: 'auto', dangerousRmWaiver: true });
    expect(folded).toContain('# mine');
    expect(permissionRead(folded)).toEqual({ kind: 'mode', mode: 'auto' });
  });
});

describe('the permission page', () => {
  const AUTO_FILE = FILE.replace('permissionMode: skip', 'permissionMode: auto');
  const READ_FILE = (text: string) => ({ path: 'harness-claude-code.yaml', text, etag: 'e1', exists: true });
  const WROTE = { path: 'harness-claude-code.yaml', etag: 'e2', outcome: 'applied' };

  it('selects the current value, says what skip allows and names the real flag, with no button of its own', async () => {
    const calls: Call[] = [];
    const { view, run } = await open({ 'GET /v1/config/file': READ_FILE(FILE) }, calls);
    expect((view.container.querySelector('input[value="skip"]') as HTMLInputElement).checked).toBe(true);
    const text = view.container.textContent ?? '';
    expect(text).toContain('--dangerously-skip-permissions');
    expect(text).toContain('even deleting files');
    expect(text).not.toContain('dangerousRmWaiver');
    expect(view.container.querySelector('button')).toBeNull();
    // The saved mode is showing: the page clears any save, so Next only records the answer.
    expect(run.events).toEqual(['ready', 'commit']);
    expect(run.hasCommit).toBe(false);
    expect(calls.map(call => call.route)).toEqual(['GET /v1/config/file']);
  });

  it('writes nothing on a pick: only the save Next runs writes, against the etag it read, touching only permissionMode', async () => {
    const calls: Call[] = [];
    const { view, run } = await open({ 'GET /v1/config/file': READ_FILE(FILE), 'PUT /v1/config/file': WROTE }, calls);
    await select(view, 'auto');
    await settle();
    expect(view.container.querySelector('[data-permission-consequence]')).toBeNull();
    expect(calls.some(call => call.route === 'PUT /v1/config/file')).toBe(false);
    // The page never holds Next (rule 8): it registers a save instead.
    expect(run.events.some(event => event.startsWith('busy:'))).toBe(false);
    await interact(() => run.runCommit());
    const puts = calls.filter(call => call.route === 'PUT /v1/config/file');
    expect(puts).toHaveLength(1);
    expect(puts[0]?.init?.body).toEqual({
      path: 'harness-claude-code.yaml',
      text: AUTO_FILE,
      etag: 'e1',
    });
  });

  it('shows the full consequence of Skip as one line when Skip is picked, and writes nothing until Next', async () => {
    const calls: Call[] = [];
    const { view, run } = await open(
      { 'GET /v1/config/file': READ_FILE(AUTO_FILE), 'PUT /v1/config/file': WROTE },
      calls,
    );
    expect(view.container.querySelector('[data-permission-consequence]')).toBeNull();
    await select(view, 'skip');
    await settle();
    const warning = view.container.querySelector('[data-permission-consequence="skip"]')?.textContent ?? '';
    expect(warning).toContain('runs every command, even deleting files');
    expect(warning).toContain('--dangerously-skip-permissions');
    expect(calls.some(call => call.route === 'PUT /v1/config/file')).toBe(false);
    await interact(() => run.runCommit());
    expect(calls.filter(call => call.route === 'PUT /v1/config/file')).toHaveLength(1);
  });

  it('registers no save when the pick is the saved mode, and withdraws it when the pick moves back', async () => {
    const calls: Call[] = [];
    const { view, run } = await open({ 'GET /v1/config/file': READ_FILE(FILE), 'PUT /v1/config/file': WROTE }, calls);
    await select(view, 'auto');
    await select(view, 'skip');
    await settle();
    // Back on the saved card: the registered save is cleared, so Next writes nothing.
    expect(run.events.filter(event => event === 'commit').length).toBeGreaterThanOrEqual(2);
    expect(run.hasCommit).toBe(false);
    await interact(() => run.runCommit());
    expect(calls.some(call => call.route === 'PUT /v1/config/file')).toBe(false);
  });

  it('writes nothing when the arrow keys move over the cards', async () => {
    const calls: Call[] = [];
    const { view, run } = await open({ 'GET /v1/config/file': READ_FILE(FILE), 'PUT /v1/config/file': WROTE }, calls);
    const key = (name: string) =>
      interact(() => {
        const focused = document.activeElement;
        const holder =
          focused instanceof HTMLInputElement && view.container.contains(focused)
            ? focused
            : must(view.container.querySelector<HTMLInputElement>('input:checked'), 'checked');
        holder.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }));
      });
    await key('ArrowLeft'); // focus moves skip -> auto
    await settle();
    expect(calls.some(call => call.route === 'PUT /v1/config/file')).toBe(false);
    expect(run.events.some(event => event.startsWith('busy:') || event === 'done')).toBe(false);
  });

  it('throws the daemon’s words, stays the page, and the next Next reads the file afresh and writes once', async () => {
    const calls: Call[] = [];
    let puts = 0;
    const { view, run } = await open(
      {
        'GET /v1/config/file': READ_FILE(FILE),
        'PUT /v1/config/file': () => {
          puts += 1;
          return puts === 1 ? new Error('That file changed since you read it.') : WROTE;
        },
      },
      calls,
    );
    await select(view, 'auto');
    await settle();
    await interact(() => expect(run.runCommit()).rejects.toThrow('That file changed since you read it.'));
    expect(run.events).not.toContain('done');
    await interact(() => run.runCommit());
    // The refused write dropped the file: the second Next read it again before it wrote.
    expect(calls.map(call => call.route)).toEqual([
      'GET /v1/config/file',
      'PUT /v1/config/file',
      'GET /v1/config/file',
      'PUT /v1/config/file',
    ]);
  });

  it('says once that a held write is saved but not yet in effect, and the next Next writes nothing more', async () => {
    const calls: Call[] = [];
    const { view, run } = await open(
      {
        'GET /v1/config/file': READ_FILE(FILE),
        'PUT /v1/config/file': { path: 'harness-claude-code.yaml', etag: 'e2', outcome: 'pending' },
      },
      calls,
    );
    await select(view, 'auto');
    await settle();
    await interact(() => expect(run.runCommit()).rejects.toThrow('the owner has to confirm it'));
    await settle();
    expect(run.hasCommit).toBe(false);
    expect(calls.filter(call => call.route === 'PUT /v1/config/file')).toHaveLength(1);
  });
});

describe('the permission page on other YAML forms', () => {
  const FLOW = '{permissionMode: auto, dangerousRmWaiver: false}\n';
  const FOLDED = 'permissionMode: >-\n  auto\ndangerousRmWaiver: false\n';

  for (const [name, text] of [
    ['a flow map', FLOW],
    ['a folded scalar', FOLDED],
  ] as const) {
    it(`shows Auto as chosen, not Skip, when the file is ${name}`, async () => {
      const { view } = await open(
        { 'GET /v1/config/file': { path: 'harness-claude-code.yaml', text, etag: 'e1', exists: true } },
        [],
      );
      expect((view.container.querySelector('input[value="auto"]') as HTMLInputElement).checked).toBe(true);
      expect((view.container.querySelector('input[value="skip"]') as HTMLInputElement).checked).toBe(false);
    });

    it(`writes a pick over ${name} as YAML that still reads, with the other keys kept`, async () => {
      const calls: Call[] = [];
      const { view, run } = await open(
        {
          'GET /v1/config/file': { path: 'harness-claude-code.yaml', text, etag: 'e1', exists: true },
          'PUT /v1/config/file': { path: 'harness-claude-code.yaml', etag: 'e2', outcome: 'applied' },
        },
        calls,
      );
      await select(view, 'skip');
      await settle();
      await interact(() => run.runCommit());
      const body = calls.find(call => call.route === 'PUT /v1/config/file')?.init?.body as { text: string };
      const read = readConfigText(body.text);
      expect(read.ok && read.read.value).toEqual({ permissionMode: 'skip', dangerousRmWaiver: false });
    });
  }

  it('shows the mode as unknown and writes nothing when the route withheld the text', async () => {
    const calls: Call[] = [];
    const { view, run } = await open(
      {
        'GET /v1/config/file': {
          path: 'harness-claude-code.yaml',
          absolutePath: '/fake/home/config/harness-claude-code.yaml',
          text: WITHHELD_TEXT,
          etag: 'e1',
          exists: true,
          state: 'ok',
        },
      },
      calls,
    );
    expect(view.container.querySelector('input[type="radio"]')).toBeNull();
    const unknown = view.container.querySelector('[data-mode-unknown]')?.textContent ?? '';
    expect(unknown).toContain('unknown');
    expect(unknown).toContain('Change this at the machine: /fake/home/config/harness-claude-code.yaml');
    expect(calls.map(call => call.route)).toEqual(['GET /v1/config/file']);
    // Nothing to save: no commit is ever registered.
    expect(run.events).toEqual(['ready']);
    expect(run.hasCommit).toBe(false);
  });
});
