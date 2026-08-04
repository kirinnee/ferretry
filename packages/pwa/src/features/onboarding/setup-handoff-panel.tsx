/**
 * THE HAND-OFF, AS A MECHANISM RATHER THAN A SENTENCE.
 *
 * "Now open this page on your other device" is not a hand-off; it is homework. It
 * loses the reader's place, makes them retype a URL, and then asks them the
 * chooser's question again on a device that knows nothing about what the first
 * one already decided. What travels here is the PLACE — route and step — encoded
 * by `setup-handoff.ts`, so the second device resumes rather than restarts.
 *
 * THE CARRIER IS CHOSEN BY WHICH DEVICE IS SENDING, and the two are not the same
 * mechanism wearing different labels:
 *
 * - A COMPUTER SENDS A QR. The phone has a camera, the computer has a screen, and
 *   the phone reads the screen. Nothing is typed and nothing is transcribed.
 * - A PHONE DOES NOT SEND A QR. Nothing on a desk is pointing a camera at a phone.
 *   It sends a link — shared through the OS if this browser has that, copied if
 *   not, and printed in full so it can be read aloud or typed as a last resort.
 *   Drawing a QR here would look like the same affordance and be useless, which
 *   is worse than being honest about the asymmetry.
 *
 * THE SHORT URL IS ALWAYS THERE. A link carrying `#fy-setup=v1;first-time;install`
 * is not something a human retypes correctly, and they never have to: the bare
 * setup page asks the same question, and answering it by hand costs one tap. It
 * is offered BESIDE the full link, never instead of it, because losing the place
 * is a real cost and only the reader can decide it is worth avoiding a long URL.
 */

import { Share2 } from 'lucide-react';

import { CopyButton, type ClipboardWriter } from './copy-button.tsx';
import type { DeviceKind } from './device-kind.ts';
import { qrModules } from './setup-handoff.ts';

/**
 * How this browser hands text to the operating system, or nothing.
 *
 * A port rather than a direct `navigator.share`, because the capability is
 * genuinely absent on most desktops and on Firefox, and a button that throws
 * `NotAllowedError` when pressed is worse than a button that was never drawn. The
 * composition root decides; this component only asks whether it exists.
 */
export type SetupSharePort = (payload: { readonly title: string; readonly url: string }) => Promise<void>;

/** How wide the QR is drawn, in CSS pixels. */
const QR_SIZE = 176;

/**
 * The QR, drawn as one path of squares in the page's own colours.
 *
 * An SVG rather than a canvas or a data-URL `<img>`: it is crisp at any density,
 * it can take a token for its ink, and it needs no ref, no effect and no second
 * paint. `shape-rendering="crispEdges"` because a QR module is a square and
 * anti-aliasing its edges is exactly the blur a camera struggles with.
 *
 * THE QUIET ZONE IS NOT DECORATION. The specification requires four modules of
 * light margin, and a scanner that cannot find it will not attempt a read — which
 * is why the light background is painted here rather than inherited from whatever
 * the page happens to be. That also means the QR stays black-on-white in dark
 * mode, deliberately: a camera reads contrast, not taste.
 */
function HandoffQr({ url, label }: { readonly url: string; readonly label: string }) {
  const modules = qrModules(url);
  const quiet = 4;
  const span = modules.length + quiet * 2;
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${span} ${span}`}
      width={QR_SIZE}
      height={QR_SIZE}
      shapeRendering="crispEdges"
      className="shrink-0 rounded-control"
      data-onboarding-qr=""
    >
      <rect x="0" y="0" width={span} height={span} fill="#ffffff" />
      {modules.map((row, y) =>
        row.map((dark, x) =>
          dark ? (
            // biome-ignore lint/suspicious/noArrayIndexKey: a QR module IS its coordinate
            <rect key={`${y}-${x}`} x={x + quiet} y={y + quiet} width={1} height={1} fill="#000000" />
          ) : null,
        ),
      )}
    </svg>
  );
}

export interface SetupHandoffPanelProps {
  /** The link that carries the place — long, and never meant to be typed. */
  readonly url: string;
  /** The same page with no place attached, for a reader who would rather type. */
  readonly plainUrl: string;
  /** Which device is SENDING. Decides the carrier, not the label. */
  readonly device: DeviceKind;
  readonly write: ClipboardWriter;
  /** The OS share sheet, when this browser has one. */
  readonly share?: SetupSharePort | undefined;
  /** What the QR's accessible name says this link is for. */
  readonly label: string;
}

export function SetupHandoffPanel({ url, plainUrl, device, write, share, label }: SetupHandoffPanelProps) {
  return (
    <div className="flex min-w-0 flex-col gap-2" data-onboarding-handoff={device}>
      {device === 'desktop' ? (
        <div className="flex min-w-0 items-center gap-3 rounded-control border border-border bg-surface-2 p-3">
          <HandoffQr url={url} label={label} />
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <p className="m-0 text-meta leading-base text-fg">Point your phone's camera at this.</p>
            <p className="m-0 text-2xs leading-base text-faint">
              It opens this setup on the phone, already at the right step. Nothing secret is in it.
            </p>
          </div>
        </div>
      ) : (
        <p className="m-0 text-meta leading-base text-muted">
          A computer has no camera pointed at this screen, so there is no code to scan. Send it the link instead.
        </p>
      )}

      {/*
        THE LINK AND ITS COPY CONTROL ARE ONE OBJECT.
        They were two: a bare icon on a line of its own, then the URL under it.
        An unlabelled icon with nothing beside it reads as an orphan — there is
        no way to tell what it copies — so it lives in the same bordered box as
        the thing it copies, exactly as `CommandBlock` does for a command.
      */}
      <div className="flex min-w-0 items-start gap-1 rounded-control border border-code-border bg-code-bg py-2 pl-2 pr-1">
        <p
          className="m-0 min-w-0 flex-1 self-center break-all font-mono text-meta leading-base text-code-fg"
          data-onboarding-handoff-url=""
        >
          {url}
        </p>
        <CopyButton text={url} label="Copy setup link" write={write} />
      </div>

      <div className="flex min-w-0 flex-wrap items-center gap-2">
        {share === undefined ? null : (
          <button
            type="button"
            className="kt-btn min-h-[44px]"
            data-variant="ghost"
            onClick={() => {
              /*
               * A DECLINED SHARE SHEET IS NOT AN ERROR. Dismissing it rejects
               * with `AbortError`, and an unhandled rejection here would be a
               * console failure caused by a reader changing their mind.
               */
              void share({ title: 'Ferretry setup', url }).catch(() => undefined);
            }}
            data-onboarding-share=""
          >
            <Share2 size={16} aria-hidden="true" />
            Share
          </button>
        )}
      </div>

      <p className="m-0 text-2xs leading-base text-faint">
        Rather type it? <span className="font-mono text-syn-string">{plainUrl}</span> asks the same question — you just
        answer it yourself.
      </p>
    </div>
  );
}
