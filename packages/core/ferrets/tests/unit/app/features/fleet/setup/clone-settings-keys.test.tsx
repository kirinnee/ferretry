import { afterEach, describe, expect, it } from 'bun:test';
import type { CloneKeyChoice } from '@ferretry/plugin-runtimes/contract';
import { CloneSettingsKeys } from '../../../../../../app/features/fleet/setup/clone-settings-keys.tsx';
import type { ReviewedSettings, SettingsPicks } from '../../../../../../app/features/fleet/setup/clone-settings-merge.ts';
import { interact, type Mounted, mount } from '@ferretry/app/testing';

const mounts: Mounted[] = [];
afterEach(async () => {
  for (const view of mounts.splice(0)) await view.unmount();
});

const DOCUMENT: ReviewedSettings = {
  path: 'warden.yaml',
  keys: [
    { key: 'caps.jevUsdPerDay', outcome: 'theirs', choice: 'take', mine: '1', theirs: '5', loosens: true },
    { key: 'intervalMinutes', outcome: 'both', mine: '5', theirs: '10' },
    { key: 'investigation.note', outcome: 'new', choice: 'take', theirs: '${secret:JEV_API_KEY}' },
    { key: 'layers.llm', outcome: 'mine', choice: 'keep', mine: 'true', theirs: 'false' },
  ],
};

const show = async (
  review: readonly ReviewedSettings[],
  picks: SettingsPicks = new Map(),
  onPick: (path: string, key: string, choice: CloneKeyChoice) => void = () => undefined,
): Promise<Mounted> => {
  const view = await mount(
    <CloneSettingsKeys review={review} picks={picks} source="work-mac" machineName="studio" onPick={onPick} />,
  );
  mounts.push(view);
  return view;
};

const row = (view: Mounted, name: string): Element => {
  const found = view.container.querySelector(`[data-clone-key="${name}"]`);
  if (found === null) throw new Error(`no row ${name}`);
  return found;
};

describe('the per-key settings rows', () => {
  it('should list each differing key with both sides and where it came from', async () => {
    const view = await show([DOCUMENT]);
    const first = row(view, 'warden.yaml:caps.jevUsdPerDay');
    expect(first.textContent).toContain('Changed on work-mac');
    expect(first.textContent).toContain('studio');
    expect(first.textContent).toContain('1');
    expect(first.textContent).toContain('5');
    expect(first.querySelector('[data-clone-key-loosens]')?.textContent).toBe('Loosens what studio may spend or do');
    expect(row(view, 'warden.yaml:layers.llm').textContent).toContain('Changed here, kept');
  });

  it('should pre-select NOTHING for a key changed on both machines, and say a pick is needed', async () => {
    const view = await show([DOCUMENT]);
    const both = row(view, 'warden.yaml:intervalMinutes');
    expect(both.getAttribute('data-outcome')).toBe('both');
    const radios = [...both.querySelectorAll('input[type="radio"]')] as HTMLInputElement[];
    expect(radios).toHaveLength(2);
    expect(radios.some(radio => radio.checked)).toBe(false);
  });

  it('should report a pick for a both-changed key as take or keep', async () => {
    const picked: [string, string, string][] = [];
    const view = await show([DOCUMENT], new Map(), (path, key, choice) => picked.push([path, key, choice]));
    const radios = [
      ...row(view, 'warden.yaml:intervalMinutes').querySelectorAll('input[type="radio"]'),
    ] as HTMLInputElement[];
    await interact(() => radios[1]?.click());
    await interact(() => radios[0]?.click());
    expect(picked).toEqual([
      ['warden.yaml', 'intervalMinutes', 'take'],
      ['warden.yaml', 'intervalMinutes', 'keep'],
    ]);
  });

  it('should show the pick that was made, and the default for a key that has one', async () => {
    const view = await show([DOCUMENT], new Map([['warden.yaml\u0000intervalMinutes', 'take' as const]]));
    const radios = [
      ...row(view, 'warden.yaml:intervalMinutes').querySelectorAll('input[type="radio"]'),
    ] as HTMLInputElement[];
    expect(radios.map(radio => radio.checked)).toEqual([false, true]);
    const box = row(view, 'warden.yaml:caps.jevUsdPerDay').querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(box.checked).toBe(true);
  });

  it('should let a default be turned off, which keeps this machine’s value', async () => {
    const picked: [string, string, string][] = [];
    const view = await show([DOCUMENT], new Map(), (path, key, choice) => picked.push([path, key, choice]));
    const box = row(view, 'warden.yaml:caps.jevUsdPerDay').querySelector('input[type="checkbox"]') as HTMLInputElement;
    await interact(() => box.click());
    expect(picked).toEqual([['warden.yaml', 'caps.jevUsdPerDay', 'keep']]);
  });

  it('should show a ${secret:NAME} as the reference it is, and offer nothing for a key only changed here', async () => {
    const view = await show([DOCUMENT]);
    expect(row(view, 'warden.yaml:investigation.note').textContent).toContain('${secret:JEV_API_KEY}');
    expect(row(view, 'warden.yaml:layers.llm').querySelector('input')).toBeNull();
  });

  it('should say why a document cannot be copied, and draw nothing for one that is the same', async () => {
    const view = await show([
      { path: 'voice.yaml', refused: 'this device may not change voice.yaml', keys: [] },
      { path: 'learning.yaml', keys: [] },
    ]);
    expect(view.container.textContent).toContain('this device may not change voice.yaml');
    expect(view.container.querySelector('[data-clone-setting-document="learning.yaml"]')).toBeNull();
    expect((await show([{ path: 'learning.yaml', keys: [] }])).container.textContent).toBe('');
  });

  it('should say a document is not on this machine yet', async () => {
    const view = await show([
      { path: 'voice.yaml', isNew: true, keys: [{ key: 'a', outcome: 'new', choice: 'take', theirs: '1' }] },
    ]);
    expect(view.container.textContent).toContain('not on studio yet');
  });
});
