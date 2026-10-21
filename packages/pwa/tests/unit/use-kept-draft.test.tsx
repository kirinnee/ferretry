/**
 * A field that keeps what the person typed: it follows the machine's value until edited, keeps the edit
 * whatever that value does meanwhile, says when it moved underneath, and ends the edit when the
 * person's own save lands.
 */

import { describe, expect, it } from 'bun:test';
import { type KeptDraft, useKeptDraft } from '../../src/hooks/use-kept-draft.ts';
import { render, run } from '../support/react.ts';

function harness(initial: string, equal?: (a: string, b: string) => boolean) {
  let latest: KeptDraft<string> | undefined;
  const Probe = ({ saved }: { readonly saved: string }) => {
    latest = useKeptDraft(saved, equal);
    return null;
  };
  const view = render(<Probe saved={initial} />);
  const draft = (): KeptDraft<string> => {
    if (latest === undefined) throw new Error('the probe did not render');
    return latest;
  };
  return {
    draft,
    machine: (saved: string) => run(() => view.update(<Probe saved={saved} />)),
    type: (text: string) => run(() => draft().set(text)),
    unmount: () => run(() => view.unmount()),
  };
}

describe('useKeptDraft', () => {
  it('follows the machine while untouched', () => {
    const field = harness('8');
    expect(field.draft()).toMatchObject({ value: '8', dirty: false, changedElsewhere: false });
    field.machine('12');
    expect(field.draft()).toMatchObject({ value: '12', dirty: false, changedElsewhere: false });
    field.unmount();
  });

  it('keeps an edit when the same value is read again, without saying anything moved', () => {
    const field = harness('8');
    field.type('4');
    field.machine('8');
    expect(field.draft()).toMatchObject({ value: '4', dirty: true, changedElsewhere: false });
    field.unmount();
  });

  it('keeps an edit when the machine moves underneath, and says so until reloaded', () => {
    const field = harness('8');
    field.type('4');
    field.machine('24');
    expect(field.draft()).toMatchObject({ value: '4', dirty: true, changedElsewhere: true });
    run(() => field.draft().reload());
    expect(field.draft()).toMatchObject({ value: '24', dirty: false, changedElsewhere: false });
    field.unmount();
  });

  it('remembers the value the edit began on across further typing', () => {
    const field = harness('8');
    field.type('4');
    field.machine('24');
    field.type('40');
    expect(field.draft().changedElsewhere).toBe(true);
    field.unmount();
  });

  it('ends the edit when its own save lands, and when the person types the saved value back', () => {
    const field = harness('8');
    field.type('4');
    field.machine('4');
    expect(field.draft()).toMatchObject({ value: '4', dirty: false, changedElsewhere: false });
    // And it follows the machine again afterwards rather than resurrecting the old edit.
    field.machine('6');
    expect(field.draft()).toMatchObject({ value: '6', dirty: false });
    field.type('6');
    expect(field.draft().dirty).toBe(false);
    field.unmount();
  });

  it('compares with the given equality', () => {
    const field = harness('hello', (a, b) => a.trim() === b.trim());
    field.type('hello\n');
    expect(field.draft().dirty).toBe(false);
    field.unmount();
  });
});
