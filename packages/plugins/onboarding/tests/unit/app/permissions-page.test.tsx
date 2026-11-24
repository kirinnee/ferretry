/**
 * THE "PERMISSIONS" PAGE: one tick-box, "Use Ferretry's autonomous defaults (recommended)", ticked by default, covering every
 * harness the person picked; the per-harness Auto / Skip choice sits under "Change". A pick writes nothing until the footer's Next
 * runs the commit, which sets ONLY `permissionMode` in each file that changed.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { ensureDom, interact, type Mounted, mount, must } from '@ferretry/app/testing';
import type { StepHost } from '@ferretry/kernel/contract';
import { coveredBy, modeOf, withMode } from '../../../app/features/permissions/permissions-model.ts';
import {
  type PermissionsFiles,
  PermissionsPage,
  type ReadFile,
} from '../../../app/features/permissions/permissions-page.tsx';

ensureDom();

let view: Mounted | undefined;
afterEach(async () => {
  await view?.unmount();
  view = undefined;
});

const BOTH = coveredBy(['claude-code', 'codex']);

const file = (text: string, extra: Partial<ReadFile> = {}): ReadFile => ({
  text,
  etag: 'etag-1',
  where: '/fy/config/harness.yaml',
  withheld: false,
  pending: false,
  ...extra,
});

/** A machine whose two files say `texts`; every write is recorded and answers `outcome`. */
const machine = (texts: Record<string, ReadFile>, outcome: 'applied' | 'held' = 'applied') => {
  const writes: { file: string; text: string; etag: string }[] = [];
  const files: PermissionsFiles = {
    read: async name => texts[name] ?? file(''),
    write: async (name, text, etag) => {
      writes.push({ file: name, text, etag });
      texts[name] = file(text, { etag: `${etag}+` });
      return outcome;
    },
  };
  return { files, writes };
};

const held: { save: (() => Promise<void>) | null } = { save: null };

const fakeStep = () => {
  held.save = null;
  const calls: string[] = [];
  const step = {
    ready: () => calls.push('ready'),
    segment: {},
    remember: () => undefined,
    done: () => calls.push('done'),
    skip: () => calls.push('skip'),
    notNeeded: () => calls.push('notNeeded'),
    commit: (save: (() => Promise<void>) | null) => {
      calls.push(save === null ? 'commit:clear' : 'commit:hold');
      held.save = save;
    },
    busy: () => calls.push('busy'),
  } as unknown as StepHost;
  return { step, calls };
};

const mountPage = async (files: PermissionsFiles, harnesses = BOTH) => {
  const fake = fakeStep();
  view = await mount(<PermissionsPage step={fake.step} harnesses={harnesses} files={files} />);
  await interact(async () => undefined);
  return fake;
};

const root = (): HTMLElement => must(view?.container, 'page');
const tick = (): HTMLInputElement =>
  must(root().querySelector<HTMLInputElement>('[data-permissions-defaults] input'), 'the tick-box');
const change = (): HTMLButtonElement =>
  must(root().querySelector<HTMLButtonElement>('[data-permissions-change]'), 'Change');
const cards = (harness: string): HTMLInputElement[] => [
  ...root().querySelectorAll<HTMLInputElement>(`[data-permissions-harness="${harness}"] input[type="radio"]`),
];
const radio = (harness: string, mode: 'auto' | 'skip'): HTMLInputElement =>
  must(
    root().querySelector<HTMLInputElement>(`[data-permissions-harness="${harness}"] input[value="${mode}"]`),
    `${harness} ${mode}`,
  );

describe('the permission mode of a config file', () => {
  it('reads the default (skip) from an empty file, the key when it is set and unknown for anything else', () => {
    expect(modeOf('')).toBe('skip');
    expect(modeOf('permissionMode: auto\n')).toBe('auto');
    expect(modeOf('permissionMode: yolo\n')).toBeNull();
    expect(modeOf('- a\n- b\n')).toBeNull();
  });

  it('sets only that key and keeps every other key and comment', () => {
    const text = '# the binary\nbinary: claude\npermissionMode: skip # owner default\n';
    expect(withMode(text, 'auto')).toBe('# the binary\nbinary: claude\npermissionMode: auto # owner default\n');
    expect(() => withMode('- a\n', 'auto')).toThrow();
  });

  it('covers the harnesses it has a file for, in the order given, and leaves out any other', () => {
    expect(coveredBy(['codex', 'claude-code', 'fake-third']).map(harness => harness.key)).toEqual([
      'claude-code',
      'codex',
    ]);
  });
});

describe('Permissions: one tick-box for every picked harness', () => {
  it('is ticked by default for Claude and Codex together, names both, and writes nothing', async () => {
    const { files, writes } = machine({});
    const fake = await mountPage(files);
    expect(tick().checked).toBe(true);
    expect(root().textContent).toContain('Use Ferretry’s autonomous defaults (recommended)');
    expect(root().textContent).toContain('Claude Code and Codex');
    expect(fake.calls).toContain('ready');
    expect(held.save).toBeNull();
    expect(writes).toEqual([]);
    // The per-harness choices are under "Change", closed.
    expect(root().querySelector('[data-permissions-details]')).toBeNull();
    expect(change().getAttribute('aria-expanded')).toBe('false');
  });

  it('opens the per-harness Auto / Skip choices under Change, one group per harness', async () => {
    const { files } = machine({});
    await mountPage(files);
    await interact(async () => change().click());
    expect(change().getAttribute('aria-expanded')).toBe('true');
    expect(cards('claude-code')).toHaveLength(2);
    expect(cards('codex')).toHaveLength(2);
  });

  it('unticking asks for Auto mode on every harness; the footer Next then writes ONLY permissionMode in both files', async () => {
    const texts = { 'harness-claude-code.yaml': file('binary: claude\n'), 'harness-codex.yaml': file('') };
    const { files, writes } = machine(texts);
    await mountPage(files);
    await interact(async () => tick().click());
    expect(tick().checked).toBe(false);
    expect(writes).toEqual([]);
    expect(held.save).not.toBeNull();
    await interact(async () => held.save?.());
    expect(writes).toEqual([
      { file: 'harness-claude-code.yaml', text: 'binary: claude\npermissionMode: auto\n', etag: 'etag-1' },
      { file: 'harness-codex.yaml', text: 'permissionMode: auto\n', etag: 'etag-1' },
    ]);
  });

  it('ticking the box again before Next clears the commit, so Next writes nothing', async () => {
    const { files, writes } = machine({});
    const fake = await mountPage(files);
    await interact(async () => tick().click());
    await interact(async () => tick().click());
    expect(tick().checked).toBe(true);
    expect(held.save).toBeNull();
    expect(fake.calls.at(-1)).toBe('commit:clear');
    expect(writes).toEqual([]);
  });

  it('choosing Auto for one harness only unticks the box and writes only that harness', async () => {
    const { files, writes } = machine({});
    await mountPage(files);
    await interact(async () => change().click());
    await interact(async () => radio('codex', 'auto').click());
    expect(tick().checked).toBe(false);
    await interact(async () => held.save?.());
    expect(writes.map(write => write.file)).toEqual(['harness-codex.yaml']);
  });

  it('starts unticked with Change open when a file already says Auto, and shows that harness as Auto', async () => {
    const { files } = machine({ 'harness-codex.yaml': file('permissionMode: auto\n') });
    await mountPage(files);
    expect(tick().checked).toBe(false);
    expect(change().getAttribute('aria-expanded')).toBe('true');
    expect(radio('codex', 'auto').checked).toBe(true);
    expect(radio('claude-code', 'skip').checked).toBe(true);
  });

  it('covers only the harness that was picked, and says so', async () => {
    const { files } = machine({});
    await mountPage(files, coveredBy(['codex']));
    expect(root().textContent).toContain('Codex run commands');
    expect(root().textContent).not.toContain('Claude Code');
  });

  it('says a held write is saved but waits for the owner, and goes on after the next Next', async () => {
    const { files } = machine({}, 'held');
    await mountPage(files);
    await interact(async () => tick().click());
    await expect(held.save?.()).rejects.toThrow('the owner has to confirm');
  });

  it('writes nothing to a file it cannot read safely, and says where to change it', async () => {
    const { files, writes } = machine({
      'harness-claude-code.yaml': file('permissionMode: yolo\n', { where: '/fy/config/harness-claude-code.yaml' }),
    });
    await mountPage(files);
    await interact(async () => tick().click());
    await interact(async () => held.save?.());
    expect(writes.map(write => write.file)).toEqual(['harness-codex.yaml']);
    expect(root().textContent).toContain('Change this at the machine: /fy/config/harness-claude-code.yaml');
  });

  it('names the real flag and what Skip allows while any harness skips', async () => {
    const { files } = machine({});
    await mountPage(files);
    const note = must(root().querySelector('[data-permission-consequence="skip"]'), 'the warning');
    expect(note.textContent).toContain('--dangerously-skip-permissions');
    expect(note.textContent).toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(note.textContent).toContain('deleting files');
  });
});
