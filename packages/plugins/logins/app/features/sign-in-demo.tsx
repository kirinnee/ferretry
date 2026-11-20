/**
 * A short picture of what to do while a sign-in waits (r11 O6, owner item 8: "instruction too wordy, maybe show an
 * animation of what to do?"): four frames played ONCE and left on the last — 1 open the link, 2 sign in, 3 copy what
 * the provider ends on (a mock address bar with `http://localhost…` highlighted, or the code), 4 paste it here.
 * Pure CSS: it ships no library and holds nothing from the real flow — the link, the address and the code are never
 * drawn into it, only stand-in bars and the one fixed word `localhost`. It is decoration for the numbered steps beside
 * it, which stay the accessible instruction, so the whole picture is `aria-hidden`. Under reduced motion the four
 * frames are four stills, laid out two by two.
 *
 * `address` is Codex's link sign-in (the page that will not load); `code` is Claude's (a code on the provider's page).
 */
import type { ReactElement } from 'react';

export type SignInDemoKind = 'address' | 'code';

type Frames = readonly [string, string, string, string];

const FRAMES: Readonly<Record<SignInDemoKind, Frames>> = {
  address: ['Open the link', 'Sign in', 'Copy the address bar', 'Paste it here'],
  code: ['Open the link', 'Sign in', 'Copy the code', 'Paste it here'],
};

/** A mock browser window; `address` is what its bar shows, highlighted when `hot`. */
function Window({
  children,
  address,
  hot,
}: {
  readonly children: ReactElement;
  readonly address?: string;
  readonly hot?: boolean;
}) {
  return (
    <div className="fy-sd__window">
      <div className="fy-sd__bar">
        <i />
        <i />
        <i />
        <span className="fy-sd__address" data-hot={hot === true ? '' : undefined}>
          {address}
        </span>
      </div>
      <div className="fy-sd__body">{children}</div>
    </div>
  );
}

export function SignInDemo({ kind }: { readonly kind: SignInDemoKind }) {
  const [open, signIn, copy, paste] = FRAMES[kind];
  return (
    <div className="fy-sd" data-sign-in-demo={kind} aria-hidden="true">
      <figure className="fy-sd__frame" data-frame="1">
        <Window>
          <span className="fy-sd__button">Continue</span>
        </Window>
        <figcaption>{open}</figcaption>
      </figure>
      <figure className="fy-sd__frame" data-frame="2">
        <Window>
          <span className="fy-sd__lines" data-sign-in-step="">
            <b />
            <b />
            <span className="fy-sd__button">Sign in</span>
          </span>
        </Window>
        <figcaption>{signIn}</figcaption>
      </figure>
      <figure className="fy-sd__frame" data-frame="3">
        <Window {...(kind === 'address' ? { address: 'http://localhost…', hot: true } : {})}>
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
      <figure className="fy-sd__frame" data-frame="4">
        <Window>
          <span className="fy-sd__paste">
            <span className="fy-sd__field">
              <span className="fy-sd__typed" />
            </span>
            <span className="fy-sd__button fy-sd__button--ok">Finish</span>
          </span>
        </Window>
        <figcaption>{paste}</figcaption>
      </figure>
    </div>
  );
}
