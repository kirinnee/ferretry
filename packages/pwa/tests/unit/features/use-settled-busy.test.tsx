import { describe, expect, it } from 'bun:test';

import { useSettledBusy } from '../../../src/features/browser/use-settled-busy.ts';
import { unitClock } from '../../../../daemon/tests/support/unit-clock.ts';
import { render, run } from '../../support/react.ts';

const Probe = ({ busy, onValue }: { busy: boolean; onValue: (shown: boolean) => void }) => {
  onValue(useSettledBusy(busy, 300, 800));
  return null;
};

describe('useSettledBusy', () => {
  it('takes the first value as is, shows work only after it lasts, and hides it only after a pause', async () => {
    unitClock.hold();
    let shown = false;
    const tree = render(<Probe busy={false} onValue={value => (shown = value)} />);
    expect(shown).toBe(false);

    run(() => tree.update(<Probe busy onValue={value => (shown = value)} />));
    run(() => unitClock.advance(299));
    expect(shown).toBe(false);
    run(() => unitClock.advance(1));
    expect(shown).toBe(true);

    run(() => tree.update(<Probe busy={false} onValue={value => (shown = value)} />));
    run(() => unitClock.advance(799));
    expect(shown).toBe(true);
    run(() => unitClock.advance(1));
    expect(shown).toBe(false);
    tree.unmount();
  });

  it('never shows a blip, and keeps the cue through a gap shorter than the hide delay', () => {
    unitClock.hold();
    let shown = false;
    const tree = render(<Probe busy={false} onValue={value => (shown = value)} />);
    run(() => tree.update(<Probe busy onValue={value => (shown = value)} />));
    run(() => unitClock.advance(200));
    run(() => tree.update(<Probe busy={false} onValue={value => (shown = value)} />));
    run(() => unitClock.advance(2_000));
    expect(shown).toBe(false);

    run(() => tree.update(<Probe busy onValue={value => (shown = value)} />));
    run(() => unitClock.advance(300));
    expect(shown).toBe(true);
    run(() => tree.update(<Probe busy={false} onValue={value => (shown = value)} />));
    run(() => unitClock.advance(500));
    run(() => tree.update(<Probe busy onValue={value => (shown = value)} />));
    run(() => unitClock.advance(2_000));
    expect(shown).toBe(true);
    tree.unmount();
  });
});
