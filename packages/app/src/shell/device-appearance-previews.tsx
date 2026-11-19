/**
 * THE LOOK PREVIEWS — the small animated frames beside Settings › This device › Look (colour mode, text size, motion),
 * so a person sees what a choice does before and after they make it.
 *
 * Each one is a `SettingPreview` whose scene is a few divs drawn from theme tokens (`device-appearance-previews.css`):
 *
 *   - Colour mode:  a tiny chat in the chosen mode, drawn in the CURRENT theme family (a `data-swatch` scope re-declares
 *                   that family's light or dark tokens locally); Auto is one frame split down the middle.
 *   - Text size:    the same few lines at 100% / 112% / 125%, beside a button that keeps its size — "touch targets never
 *                   shrink", shown instead of said.
 *   - Motion:       "Follow system" is dots bouncing and a ring turning; "Reduced" is the same dots at rest.
 *
 * What it loops from is a contrast, not a history: `before` is the value the chosen one is most unlike, so every choice
 * plays a visible change, including the first time the page opens. With motion off the frame holds the final state
 * (`SettingPreview` mounts only `after`), so the Motion scene's own movement is drawn only while motion is allowed.
 */

import type { MotionPreference } from '../compose/controls.ts';
import { SettingPreview } from '../compose/setting-preview.tsx';
import { swatchAttributes } from '../theme/catalog.ts';
import type { TextScale } from '../theme/preferences.ts';
import { useMotionAllowed } from '../ui/use-motion-allowed.ts';
import './device-appearance-previews.css';

export type ColourMode = 'system' | 'light' | 'dark';

/** The value a choice is most unlike: where its loop starts from. */
const MODE_BEFORE: Readonly<Record<ColourMode, ColourMode>> = { system: 'light', light: 'dark', dark: 'light' };
const SCALE_BEFORE: Readonly<Record<TextScale, TextScale>> = { default: 'larger', large: 'default', larger: 'default' };
const MOTION_BEFORE: Readonly<Record<MotionPreference, MotionPreference>> = { system: 'reduced', reduced: 'system' };

const MODE_WORDS: Readonly<Record<ColourMode, string>> = {
  system: 'Light and dark, as this device decides',
  light: 'Always light',
  dark: 'Always dark',
};
const SCALE_WORDS: Readonly<Record<TextScale, string>> = {
  default: 'Text at its designed size',
  large: 'Text 12% larger',
  larger: 'Text 25% larger',
};
const MOTION_WORDS: Readonly<Record<MotionPreference, string>> = {
  system: 'Animations play',
  reduced: 'Everything stays still',
};

/** One tiny chat: a side rail, a header line, a reply, a message and the accent button. */
function ModePane({ family, tone }: { readonly family: string; readonly tone: 'light' | 'dark' }) {
  return (
    <div className="fy-dap-pane" {...swatchAttributes(`${family}-${tone}`)} data-dap-tone={tone}>
      <i className="fy-dap-rail" />
      <span className="fy-dap-body">
        <i className="fy-dap-line fy-dap-line--head" />
        <i className="fy-dap-bubble" />
        <i className="fy-dap-bubble fy-dap-bubble--mine" />
        <i className="fy-dap-chip" />
      </span>
    </div>
  );
}

function ModeFrame({ family, mode }: { readonly family: string; readonly mode: ColourMode }) {
  if (mode !== 'system') {
    return (
      <div className="fy-dap-frame" data-dap-mode={mode}>
        <ModePane family={family} tone={mode} />
      </div>
    );
  }
  // Auto: both modes in one frame, the dark one clipped to the right half.
  return (
    <div className="fy-dap-frame" data-dap-mode="system">
      <ModePane family={family} tone="light" />
      <div className="fy-dap-half">
        <ModePane family={family} tone="dark" />
      </div>
    </div>
  );
}

export function ColourModePreview({ family, mode }: { readonly family: string; readonly mode: ColourMode }) {
  return (
    <SettingPreview
      label={MODE_WORDS[mode]}
      value={mode}
      before={<ModeFrame family={family} mode={MODE_BEFORE[mode]} />}
      after={<ModeFrame family={family} mode={mode} />}
    />
  );
}

/** Three lines of text at the scale, and a button that does not follow it. */
function ScaleFrame({ scale }: { readonly scale: TextScale }) {
  return (
    <div className="fy-dap-frame fy-dap-frame--text" data-dap-scale={scale}>
      <span className="fy-dap-type">
        <b className="fy-dap-type__title">Aa</b>
        <span className="fy-dap-type__line">Hello, ferret</span>
        <span className="fy-dap-type__line">in this size</span>
      </span>
      <i className="fy-dap-button" />
    </div>
  );
}

export function TextSizePreview({ scale }: { readonly scale: TextScale }) {
  return (
    <SettingPreview
      label={SCALE_WORDS[scale]}
      value={scale}
      before={<ScaleFrame scale={SCALE_BEFORE[scale]} />}
      after={<ScaleFrame scale={scale} />}
    />
  );
}

/** Three dots and a ring: bouncing and turning when motion is on, at rest when it is off. */
function MotionFrame({ motion, moving }: { readonly motion: MotionPreference; readonly moving: boolean }) {
  const alive = motion === 'system' && moving;
  return (
    <div className="fy-dap-frame fy-dap-frame--motion" data-dap-motion={alive ? 'moving' : 'still'}>
      <span className="fy-dap-dots">
        <i className="fy-dap-dot" />
        <i className="fy-dap-dot" />
        <i className="fy-dap-dot" />
      </span>
      <i className="fy-dap-ring" />
      <span className="fy-dap-caption">{alive ? 'Moving' : 'Still'}</span>
    </div>
  );
}

export function MotionPreview({ motion }: { readonly motion: MotionPreference }) {
  // "Follow system" only moves when this device allows it: a device that asks for less motion gets the still frame.
  const moving = useMotionAllowed();
  return (
    <SettingPreview
      label={MOTION_WORDS[motion]}
      value={motion}
      before={<MotionFrame motion={MOTION_BEFORE[motion]} moving={moving} />}
      after={<MotionFrame motion={motion} moving={moving} />}
    />
  );
}
