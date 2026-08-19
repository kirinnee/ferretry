import { describe, expect, it } from 'bun:test';
import type { ReactTestRenderer } from 'react-test-renderer';
import { OperatorPasswordCard } from '../../../../src/features/settings/operator-password.tsx';
import {
  PASSWORD_ARRIVAL_VS_CREDENTIAL,
  PASSWORD_HOST_SET_COMMAND,
  PASSWORD_ONE_WAY_NOTE,
  PASSWORD_RECOVERY_NOTE,
  type PasswordControlState,
} from '../../../../src/lib/grants.ts';
import { render, run } from '../../../support/react.ts';

const text = (renderer: ReactTestRenderer): string => JSON.stringify(renderer.toJSON());

const marked = (renderer: ReactTestRenderer, attribute: string) =>
  renderer.root.findAll(node => typeof node.type === 'string' && node.props[attribute] !== undefined);

const card = (state: PasswordControlState, overrides: Record<string, unknown> = {}) =>
  render(
    <OperatorPasswordCard state={state} onSet={() => {}} {...overrides} />,
    // Host refs are null under react-test-renderer, so a ref effect never runs without one. Every render
    // test in this package supplies it for the same reason.
    { createNodeMock: () => ({}) },
  );

/** Types a value into both fields and submits, which is the only path that can reach `onSet`. */
function submit(renderer: ReactTestRenderer, password: string, confirmation = password): void {
  run(() => marked(renderer, 'data-password-field')[0]?.props.onChange({ target: { value: password } }));
  run(() => marked(renderer, 'data-password-confirm-field')[0]?.props.onChange({ target: { value: confirmation } }));
  run(() => renderer.root.findAllByType('form')[0]?.props.onSubmit({ preventDefault: () => {} }));
}

describe('OperatorPasswordCard', () => {
  it('explains arrival versus credential BEFORE the tap, in every state', () => {
    // The route this control calls is refused to every caller off the host, and a person holding a phone
    // on the same desk reads "on the same network" as "at the machine". The distinction is on screen
    // before anybody presses anything rather than arriving as a refusal afterwards.
    for (const state of [
      { kind: 'ready', first: true },
      { kind: 'locked' },
      { kind: 'remote' },
    ] satisfies PasswordControlState[]) {
      expect(text(card(state))).toContain(PASSWORD_ARRIVAL_VS_CREDENTIAL);
    }
  });

  it('shows a REMOTE browser the reason and the host command, never a control', () => {
    // THE EXPLAINED-UNAVAILABLE STATE. A greyed control with nothing beside it is the dead end this panel
    // exists to remove, and hiding it entirely sends somebody hunting for a setting the product does have.
    // Arrange, Act
    const renderer = card({ kind: 'remote' });

    // Assert — no field and no submit: nothing that could fail on press.
    expect(marked(renderer, 'data-password-field')).toHaveLength(0);
    expect(marked(renderer, 'data-password-submit')).toHaveLength(0);
    // And the reason, with the two places that CAN do it.
    expect(marked(renderer, 'data-password-unavailable')).toHaveLength(1);
    const rendered = text(renderer);
    expect(rendered).toContain('did not arrive on the host');
    expect(rendered).toContain(PASSWORD_HOST_SET_COMMAND);
  });

  it('shows a LOCKED local browser what it needs, and the way back if it does not have it', () => {
    // The reader who has forgotten the password is exactly the reader this control refuses, so the escape
    // hatch is printed at the point of decision rather than left in a document.
    // Arrange, Act
    const renderer = card({ kind: 'locked' });

    // Assert
    expect(marked(renderer, 'data-password-locked')).toHaveLength(1);
    expect(marked(renderer, 'data-password-field')).toHaveLength(0);
    expect(text(renderer)).toContain(PASSWORD_RECOVERY_NOTE);
    expect(text(renderer)).toContain('without asking for the old one');
  });

  it('offers the control to a local browser that is past the gate', () => {
    // Arrange, Act
    const first = card({ kind: 'ready', first: true });
    const replacing = card({ kind: 'ready', first: false });

    // Assert — and the two read differently, because setting a first password and replacing one a
    // machine is already gated by are not the same act.
    expect(marked(first, 'data-password-field')).toHaveLength(1);
    expect(text(first)).toContain('Set the password');
    expect(text(replacing)).toContain('Replace the password');
    // The HEADING names the act rather than the noun: "Operator password" is what the unlock prompt
    // directly above this is called, and two adjacent panels under one name is a screen a reader has to
    // disambiguate for themselves.
    expect(text(first)).toContain('Set an operator password');
    expect(text(replacing)).toContain('Change the operator password');
    expect(text(card({ kind: 'remote' }))).toContain('Setting the operator password');
  });

  it('offers NOTHING that removes the password, in any state this card can be in', () => {
    // THE VERB IS GONE, and this is what stops it coming back as a control. Removing a password revokes
    // no paired device, so a machine that had paired one would keep it and lose its gate — the state
    // pairing exists to make unreachable. Asserted across every state rather than the one it used to be
    // drawn in, because a control reappearing under a different posture is the same defect.
    // Arrange, Act
    const states: PasswordControlState[] = [
      { kind: 'ready', first: true },
      { kind: 'ready', first: false },
      { kind: 'locked' },
      { kind: 'remote' },
    ];

    // Assert
    for (const state of states) {
      const rendered = card(state);
      expect(marked(rendered, 'data-password-clear')).toHaveLength(0);
      expect(text(rendered)).not.toContain('Remove the password');
      expect(text(rendered)).not.toContain('password clear');
    }
  });

  it('says setting one cannot be undone BEFORE the first press, and not again afterwards', () => {
    // It is the decision a reader can only make once, so the consequence belongs beside the button that
    // makes it — not in a confirmation, and not discovered later by hunting for an undo. A reader
    // replacing a password they already have is not making this choice again, so they are not told twice.
    // Arrange, Act
    const first = card({ kind: 'ready', first: true });
    const replacing = card({ kind: 'ready', first: false });

    // Assert
    expect(marked(first, 'data-password-one-way')).toHaveLength(1);
    expect(text(first)).toContain(PASSWORD_ONE_WAY_NOTE);
    expect(marked(replacing, 'data-password-one-way')).toHaveLength(0);
  });

  it('NEVER puts the password in the rendered output, before or after it is sent', () => {
    // The credential rule, asserted rather than asserted-about. There is no getter for this value
    // anywhere in the system, and a control that echoed it back — as a value, a masked form, a length or
    // a fingerprint — would be the first crack in that.
    // Arrange
    const sent: string[] = [];
    const renderer = card({ kind: 'ready', first: true }, { onSet: (password: string) => sent.push(password) });

    // Act
    submit(renderer, 'correct-horse-battery');

    // Assert — it reached the handler, and nothing on screen carries it.
    expect(sent).toEqual(['correct-horse-battery']);
    expect(text(renderer)).not.toContain('correct-horse-battery');
    // Cleared at submit, so it does not sit in a field while somebody walks away from the screen.
    expect(marked(renderer, 'data-password-field')[0]?.props.value).toBe('');
    expect(marked(renderer, 'data-password-confirm-field')[0]?.props.value).toBe('');
  });

  it('refuses a password the daemon would reject, at the field rather than as a 400', () => {
    // The minimum has ONE owner and it is the protocol schema. A person is told before the call rather
    // than by a refusal, and nothing is sent while the value cannot succeed.
    // Arrange
    const sent: string[] = [];
    const renderer = card({ kind: 'ready', first: true }, { onSet: (password: string) => sent.push(password) });

    // Act
    submit(renderer, 'short');

    // Assert
    expect(sent).toEqual([]);
    expect(marked(renderer, 'data-password-problem')).toHaveLength(1);
    expect(text(renderer)).toContain('Use at least 8 characters');
  });

  it('refuses two entries that disagree, so a typo is not stored as the password', () => {
    // There is no way to read this value back, so a mistyped password is a password nobody knows. The
    // second field is what makes that unreachable rather than merely unlikely.
    // Arrange
    const sent: string[] = [];
    const renderer = card({ kind: 'ready', first: true }, { onSet: (password: string) => sent.push(password) });

    // Act
    submit(renderer, 'a-good-password', 'a-good-passwrod');

    // Assert
    expect(sent).toEqual([]);
    expect(text(renderer)).toContain('do not match');
  });

  it('sends nothing while a call is already in flight', () => {
    // Arrange
    const sent: string[] = [];
    const renderer = card(
      { kind: 'ready', first: true },
      { busy: true, onSet: (password: string) => sent.push(password) },
    );

    // Act
    submit(renderer, 'a-good-password');

    // Assert
    expect(sent).toEqual([]);
    expect(marked(renderer, 'data-password-submit')[0]?.props.disabled).toBe(true);
  });

  it('never offers to save the password to a browser password manager', () => {
    // This is a local operator secret rather than a site login, and a manager offering to keep it would
    // put it somewhere this product cannot reason about.
    // Arrange, Act
    const renderer = card({ kind: 'ready', first: true });

    // Assert
    for (const attribute of ['data-password-field', 'data-password-confirm-field']) {
      expect(marked(renderer, attribute)[0]?.props.type).toBe('password');
      expect(marked(renderer, attribute)[0]?.props.autoComplete).toBe('off');
    }
  });

  it('renders the daemon’s own refusal whole, because it names the command a human runs', () => {
    // Arrange, Act
    const renderer = card(
      { kind: 'ready', first: false },
      { failure: 'changing this machine’s operator password needs the password it already has' },
    );

    // Assert
    expect(marked(renderer, 'data-password-failure')).toHaveLength(1);
    expect(text(renderer)).toContain('needs the password it already has');
  });

  it('takes the heading and lead sentence the surface around it needs', () => {
    // The pairing flow asks for the SAME control under its own heading, so one component carries one set
    // of rules about where it can succeed rather than two panels drifting apart.
    // Arrange, Act
    const renderer = card(
      { kind: 'ready', first: true },
      { heading: 'Set the operator password', intro: 'This is the gate every device you add will pass.' },
    );

    // Assert
    const rendered = text(renderer);
    expect(rendered).toContain('Set the operator password');
    expect(rendered).toContain('This is the gate every device you add will pass.');
  });
});
