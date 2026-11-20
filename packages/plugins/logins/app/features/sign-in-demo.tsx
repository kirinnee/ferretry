/**
 * A short looping picture of what to do while a sign-in waits (r11 O6, owner item 8: "instruction too wordy, maybe show
 * an animation of what to do?"): open the link, copy what the provider ends on, paste it here. Pure CSS — three
 * crossfading frames in a tiny browser window — so it ships no library and holds nothing from the real flow: the link,
 * the address and the code are never drawn into it, only stand-in bars. It is decoration for the numbered steps beside
 * it, which stay the accessible instruction, so the whole picture is `aria-hidden`. Under reduced motion the three frames
 * are laid out side by side, still.
 *
 * `address` is Codex's link sign-in (the page that will not load); `code` is Claude's (a code on the provider's page).
 */
import type { ReactElement } from 'react';

export type SignInDemoKind = 'address' | 'code';

const FRAMES: Readonly<Record<SignInDemoKind, readonly [string, string, string]>> = {
  address: ['Open the link', 'Copy the address', 'Paste it here'],
  code: ['Open the link', 'Copy the code', 'Paste it here'],
};

function Window({ children, hot }: { readonly children: ReactElement; readonly hot?: boolean }) {
  return (
    <div className="fy-sd__window">
      <div className="fy-sd__bar">
        <i />
        <i />
        <i />
        <span className="fy-sd__address" data-hot={hot === true ? '' : undefined} />
      </div>
      <div className="fy-sd__body">{children}</div>
    </div>
  );
}

export function SignInDemo({ kind }: { readonly kind: SignInDemoKind }) {
  const [open, copy, paste] = FRAMES[kind];
  return (
    <div className="fy-sd" data-sign-in-demo={kind} aria-hidden="true">
      <figure className="fy-sd__frame" data-frame="1">
        <Window>
          <span className="fy-sd__button">Continue</span>
        </Window>
        <figcaption>{open}</figcaption>
      </figure>
      <figure className="fy-sd__frame" data-frame="2">
        <Window hot={kind === 'address'}>
          {kind === 'address' ? (
            <span className="fy-sd__lines">
              <b />
              <b />
            </span>
          ) : (
            <span className="fy-sd__code" data-hot="" />
          )}
        </Window>
        <figcaption>{copy}</figcaption>
      </figure>
      <figure className="fy-sd__frame" data-frame="3">
        <div className="fy-sd__field">
          <span className="fy-sd__typed" />
        </div>
        <span className="fy-sd__button fy-sd__button--ok">Finish</span>
        <figcaption>{paste}</figcaption>
      </figure>
    </div>
  );
}
