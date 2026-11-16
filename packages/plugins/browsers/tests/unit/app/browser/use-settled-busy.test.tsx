import { describe, expect, it } from 'bun:test';
import { render, run, runAsync } from '@ferretry/app/testing';
import { useSettledBusy } from '../../../../app/features/browser/use-settled-busy.ts';

/** Short delays on the page's own timers, so the suite waits real milliseconds, not today's fake clock. */
const SHOW_MS = 40;
const HIDE_MS = 90;

const Probe = ({ busy, onValue }: { busy: boolean; onValue: (shown: boolean) => void }) => {
  onValue(useSettledBusy(busy, SHOW_MS, HIDE_MS));
  return null;
};

const wait = async (milliseconds: number): Promise<void> => {
  await runAsync(async () => {
    await new Promise(resolve => setTimeout(resolve, milliseconds));
  });
};

describe('useSettledBusy', () => {
  it('takes the first value as is, shows work only after it lasts, and hides it only after a pause', async () => {
    let shown = false;
    const tree = render(<Probe busy={false} onValue={value => (shown = value)} />);
    expect(shown).toBe(false);

    run(() => tree.update(<Probe busy onValue={value => (shown = value)} />));
    await wait(SHOW_MS / 2);
    expect(shown).toBe(false);
    await wait(SHOW_MS);
    expect(shown).toBe(true);

    run(() => tree.update(<Probe busy={false} onValue={value => (shown = value)} />));
    await wait(HIDE_MS / 2);
    expect(shown).toBe(true);
    await wait(HIDE_MS);
    expect(shown).toBe(false);
    tree.unmount();
  });

  it('never shows a blip, and keeps the cue through a gap shorter than the hide delay', async () => {
    let shown = false;
    const tree = render(<Probe busy={false} onValue={value => (shown = value)} />);
    run(() => tree.update(<Probe busy onValue={value => (shown = value)} />));
    await wait(SHOW_MS / 4);
    run(() => tree.update(<Probe busy={false} onValue={value => (shown = value)} />));
    await wait(HIDE_MS * 2);
    expect(shown).toBe(false);

    run(() => tree.update(<Probe busy onValue={value => (shown = value)} />));
    await wait(SHOW_MS * 2);
    expect(shown).toBe(true);
    run(() => tree.update(<Probe busy={false} onValue={value => (shown = value)} />));
    await wait(HIDE_MS / 3);
    run(() => tree.update(<Probe busy onValue={value => (shown = value)} />));
    await wait(HIDE_MS * 2);
    expect(shown).toBe(true);
    tree.unmount();
  });
});
