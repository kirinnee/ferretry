import { describe, it } from 'bun:test';
import should from 'should';
import {
  isAddressablePaneId,
  MAX_PICKER_DISMISS_ATTEMPTS,
  nextPickerDismissStep,
  parsePaneCursor,
  activePaneIdArguments,
  capturePaneIdArguments,
  dismissPaneIdArguments,
  isAddressablePickerKey,
  paneIdCursorArguments,
  pickerKeyPaneIdArguments,
} from '../../../../src/lib/session/harness/index.ts';

const PICKER = ['Select Model', '  1. gpt-5-codex'].join('\n');
const IDLE = ['$ ', ''].join('\n');
const UNKNOWN = ['some half-drawn thing', ''].join('\n');

describe('isAddressablePaneId', () => {
  it.each([
    { paneId: '%0', addressable: true },
    { paneId: '%17', addressable: true },
    { paneId: '', addressable: false },
    { paneId: 'fy-session', addressable: false },
    { paneId: '%', addressable: false },
    { paneId: '%00', addressable: false },
    { paneId: '%01', addressable: false },
    { paneId: '%1x', addressable: false },
  ])('should treat $paneId as addressable=$addressable', ({ paneId, addressable }) => {
    // Arrange / Act / Assert
    should(isAddressablePaneId(paneId)).eql(addressable);
  });
});

describe('nextPickerDismissStep', () => {
  it('should settle when nothing is open and the prompt is ready', () => {
    // Arrange / Act
    const step = nextPickerDismissStep({ visiblePane: IDLE, promptReady: true }, 0);

    // Assert
    should(step).eql({ kind: 'settled' });
  });

  it('should refuse WITHOUT sending a key when the screen is unrecognised', () => {
    // Arrange: Escape into an unidentified modal is the exact hazard cleanup
    // exists to prevent, so an unknown screen is never keyed.
    const step = nextPickerDismissStep({ visiblePane: UNKNOWN, promptReady: false }, 0);

    // Assert
    should(step).eql({
      kind: 'unconfirmed',
      reason: 'the pane shows neither a recognised Codex picker nor an idle prompt, so no key was sent into it',
    });
  });

  it('should send an Escape numbered from the attempts already made', () => {
    // Arrange / Act
    const step = nextPickerDismissStep({ visiblePane: PICKER, promptReady: false }, 2);

    // Assert
    should(step).eql({ kind: 'send_escape', attempt: 3 });
  });

  it('should give up on a picker that outlives the attempt budget', () => {
    // Arrange / Act
    const step = nextPickerDismissStep({ visiblePane: PICKER, promptReady: false }, MAX_PICKER_DISMISS_ATTEMPTS);

    // Assert: the title is quoted so a human knows what is on the pane.
    should(step).eql({
      kind: 'unconfirmed',
      reason: `Select Model was still open after ${MAX_PICKER_DISMISS_ATTEMPTS} dismiss attempts`,
    });
  });

  it('should name the picker kind when the screen carries no title line to quote', () => {
    // Arrange: a reasoning picker names the model in its title, so the whole title
    // is what identifies it.
    const step = nextPickerDismissStep(
      { visiblePane: ['Select Reasoning Level for gpt-5-codex', '  1. high'].join('\n'), promptReady: false },
      1,
      1,
    );

    // Assert
    should(step).eql({
      kind: 'unconfirmed',
      reason: 'Select Reasoning Level for gpt-5-codex was still open after 1 dismiss attempts',
    });
  });

  it('should still send Escape when a picker is open even if the pane also looks prompt-ready', () => {
    // Arrange: a picker on screen wins over the cursor heuristic — the modal is
    // what consumes the next keystroke.
    const step = nextPickerDismissStep({ visiblePane: PICKER, promptReady: true }, 0);

    // Assert
    should(step).eql({ kind: 'send_escape', attempt: 1 });
  });
});

describe('pane-scoped tmux arguments', () => {
  it('should resolve the active pane of a session by id', () => {
    // Arrange / Act / Assert
    should(activePaneIdArguments('fy-abc')).eql(['display-message', '-p', '-t', 'fy-abc', '#{pane_id}']);
  });

  it('should capture only the visible pane, never history', () => {
    // Arrange / Act / Assert: history would drag closed pickers into the capture.
    should(capturePaneIdArguments('%3')).eql(['capture-pane', '-p', '-t', '%3']);
  });

  it('should read the cursor position of an exact pane', () => {
    // Arrange / Act / Assert
    should(paneIdCursorArguments('%3')).eql(['display-message', '-p', '-t', '%3', '#{cursor_x}|#{cursor_y}']);
  });

  it('should dismiss with Escape addressed to an exact pane', () => {
    // Arrange / Act / Assert
    should(dismissPaneIdArguments('%3')).eql(['send-keys', '-t', '%3', 'Escape']);
  });

  it('should send a verified picker digit to an exact pane', () => {
    // Arrange / Act / Assert: the pane id, not the session name — a session name re-resolves to
    // whichever pane is active when the command runs.
    should(pickerKeyPaneIdArguments('%3', '4')).eql(['send-keys', '-t', '%3', '4']);
  });

  it('should accept only a single digit as a picker key', () => {
    // Arrange / Act / Assert
    for (const key of ['1', '5', '9']) should(isAddressablePickerKey(key)).equal(true);
  });

  it('should refuse anything a row number cannot have produced', () => {
    // `0` addresses no row, `10` is two keystrokes, and a name like `Enter` or `C-c` is a tmux verb
    // that cannot be checked against a row read off the screen.
    // Arrange / Act / Assert
    for (const key of ['0', '10', '', ' 1', 'Enter', 'C-c', 'Escape', 'a']) {
      should(isAddressablePickerKey(key)).equal(false);
    }
  });
});

describe('parsePaneCursor', () => {
  it('should read a well-formed position', () => {
    // Arrange / Act / Assert
    should(parsePaneCursor(' 12|4 \n')).eql({ x: 12, y: 4 });
  });

  it.each([
    { name: 'a missing separator', value: '12' },
    { name: 'an empty x', value: '|4' },
    { name: 'an empty y', value: '12|' },
    { name: 'a non-numeric field', value: 'a|4' },
    { name: 'nothing at all', value: '' },
  ])('should refuse $name rather than defaulting to zero', ({ value }) => {
    // Arrange / Act / Assert
    should(parsePaneCursor(value)).eql(undefined);
  });
});
