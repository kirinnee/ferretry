/**
 * Send key preview — what Enter does, typed live: "hi there" goes into a mini composer, the key lights up, and then
 * either the message flies up into the thread (Enter sends) or the box grows a second line (Enter starts a new line).
 * The keyboard and the phone differ only in the key's name on the chip: the preview shows the KEY's effect.
 */

import { SettingPreview } from '@ferretry/app';
import type { ComposerEnterKeyPreference } from '@ferretry/app';
import './previews.css';

export type SendKeyDevice = 'keyboard' | 'phone';

const KEY_LABEL: Readonly<Record<SendKeyDevice, string>> = { keyboard: '↵', phone: 'return' };

const OUTCOME_LABEL: Readonly<Record<ComposerEnterKeyPreference, string>> = {
  send: 'The key sends the message',
  newline: 'The key starts a new line',
};

/** The frame before the key: the words going in. */
function Typing({ keyLabel }: { readonly keyLabel: string }) {
  return (
    <div className="fy-cvp">
      <div className="fy-cvp-box fy-cvp-box--active">
        <div className="fy-cvp-line">
          <span className="fy-cvp-typed">hi there</span>
          <span className="fy-cvp-caret" />
        </div>
      </div>
      <span className="fy-cvp-key fy-cvp-key--press">{keyLabel}</span>
    </div>
  );
}

/** The frame after it: the message sent, or a second line begun. */
function Result({ outcome, keyLabel }: { readonly outcome: ComposerEnterKeyPreference; readonly keyLabel: string }) {
  return (
    <div className="fy-cvp">
      {outcome === 'send' ? (
        <>
          <div className="fy-cvp-bubble">hi there</div>
          <div className="fy-cvp-box">
            <div className="fy-cvp-line fy-cvp-hint">Message…</div>
          </div>
        </>
      ) : (
        <div className="fy-cvp-box fy-cvp-box--active">
          <div className="fy-cvp-line">hi there</div>
          <div className="fy-cvp-line">
            <span className="fy-cvp-typed fy-cvp-typed--late">and then</span>
            <span className="fy-cvp-caret" />
          </div>
        </div>
      )}
      <span className="fy-cvp-key">{keyLabel}</span>
    </div>
  );
}

export function SendKeyPreview({
  device,
  outcome,
}: {
  readonly device: SendKeyDevice;
  readonly outcome: ComposerEnterKeyPreference;
}) {
  const keyLabel = KEY_LABEL[device];
  return (
    <SettingPreview
      label={OUTCOME_LABEL[outcome]}
      value={`${device}-${outcome}`}
      before={<Typing keyLabel={keyLabel} />}
      after={<Result outcome={outcome} keyLabel={keyLabel} />}
    />
  );
}
