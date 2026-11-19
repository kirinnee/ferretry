/**
 * THE FERRET LIST PREVIEWS — the small animated frames beside Settings › This device › Ferret list: "Group Needs you at
 * the top" and the row density. Each is a `SettingPreview` (from the app's compose kit) over a mini ferret list drawn with
 * divs (`device-settings-previews.css`), so the choice shows what the real list will do.
 *
 *   - Needs you:  on lifts the ferret with an open Inbox item into a "Needs you" group at the top; off leaves it in its
 *                 folder with just the badge. The lifted row slides up while the loop plays.
 *   - Density:    Full is two lines a row (title, then folder and marks); Compact drops the folder and the marks;
 *                 Minimal is one line, the title and its badge.
 *
 * `before` is the value the chosen one is most unlike, so each choice plays a visible change; with motion off the frame
 * holds the final state (`SettingPreview`'s own rule).
 */

import { SettingPreview } from '@ferretry/app';
import './device-settings-previews.css';

export type PreviewDensity = 'full' | 'compact' | 'minimal';

const DENSITY_BEFORE: Readonly<Record<PreviewDensity, PreviewDensity>> = {
  full: 'minimal',
  compact: 'full',
  minimal: 'full',
};
const DENSITY_WORDS: Readonly<Record<PreviewDensity, string>> = {
  full: 'Each ferret shows its title, folder and marks',
  compact: 'Each ferret shows its title and what it asks',
  minimal: 'Each ferret is one line',
};

interface RowProps {
  readonly density: PreviewDensity;
  /** The ferret has an open Inbox item: its dot and badge are the accent. */
  readonly asking?: boolean;
  readonly lifted?: boolean;
}

/** One ferret: a dot, a title and a badge; Full adds a folder line and marks, Compact a single ask line. */
function Row({ density, asking = false, lifted = false }: RowProps) {
  return (
    <span className="fy-dsp-row" data-asking={asking ? '' : undefined} data-lifted={lifted ? '' : undefined}>
      <i className="fy-dsp-dot" />
      <span className="fy-dsp-text">
        <i className="fy-dsp-title" />
        {density === 'minimal' ? null : <i className="fy-dsp-sub" data-kind={density === 'full' ? 'folder' : 'ask'} />}
      </span>
      {density === 'full' ? <i className="fy-dsp-mark" /> : null}
      {asking ? <i className="fy-dsp-badge" /> : null}
    </span>
  );
}

function DensityFrame({ density }: { readonly density: PreviewDensity }) {
  return (
    <div className="fy-dsp-frame" data-dsp-density={density}>
      <Row density={density} asking />
      <Row density={density} />
      <Row density={density} />
      <Row density={density} />
    </div>
  );
}

export function DensityPreview({ density }: { readonly density: PreviewDensity }) {
  return (
    <SettingPreview
      label={DENSITY_WORDS[density]}
      value={density}
      before={<DensityFrame density={DENSITY_BEFORE[density]} />}
      after={<DensityFrame density={density} />}
    />
  );
}

/** The list with or without a Needs you group. The asking ferret sits at the top when grouped, in its folder when not. */
function NeedsYouFrame({ grouped }: { readonly grouped: boolean }) {
  return (
    <div className="fy-dsp-frame" data-dsp-grouped={grouped ? 'on' : 'off'}>
      {grouped ? (
        <>
          <b className="fy-dsp-group fy-dsp-group--needs">Needs you</b>
          <Row density="compact" asking lifted />
          <b className="fy-dsp-group">ferretry</b>
          <Row density="compact" />
          <Row density="compact" />
        </>
      ) : (
        <>
          <b className="fy-dsp-group">ferretry</b>
          <Row density="compact" />
          <Row density="compact" asking />
          <Row density="compact" />
        </>
      )}
    </div>
  );
}

export function NeedsYouPreview({ grouped }: { readonly grouped: boolean }) {
  return (
    <SettingPreview
      label={grouped ? 'Ferrets that need you go first' : 'Ferrets stay in their folders'}
      value={grouped ? 'on' : 'off'}
      before={<NeedsYouFrame grouped={!grouped} />}
      after={<NeedsYouFrame grouped={grouped} />}
    />
  );
}
