/**
 * The one action on a cold pairing screen: point the camera at the code.
 *
 * SELF-CONTAINED ON PURPOSE. The button, the live preview, the refusal and the
 * camera's release are one component because they are one decision — a screen
 * that owned half of them could leave a camera running behind a surface that
 * had already moved on.
 *
 * THE VIDEO IS ALWAYS MOUNTED, hidden until a scan starts. The decoder reads
 * frames from this exact element, and mounting it in the same commit that
 * starts the scan is a race: the camera can open before React has attached the
 * ref, and the first decode would then read nothing.
 *
 * WHAT IT NEVER DOES. It does not parse, keep or display the decoded text. A
 * pairing code is single-use and short-lived; this component hands the raw
 * string straight to its caller and holds nothing.
 */
import { Camera, QrCode, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import { useQrScan } from '../../hooks/use-qr-scan.ts';
import type { QrPreview, QrScanHost } from '../../lib/pair-scan.ts';

export interface PairScannerProps {
  /** `null` where this browser cannot scan; the caller shows paste instead. */
  readonly host: QrScanHost | null;
  /** The wording of the resting control — the first daemon reads differently from the fourth. */
  readonly label: string;
  /** The raw decoded text of the first QR code seen. */
  readonly onText: (text: string) => void;
  /** A scan that ended in a refusal, so the caller can reveal its fallback. */
  readonly onFailed: () => void;
}

export function PairScanner({ host, label, onText, onFailed }: PairScannerProps) {
  const video = useRef<HTMLVideoElement | null>(null);
  // True once frames are actually arriving. Permission prompts and camera
  // warm-up take a visible moment on a phone, and a black rectangle with no
  // caption reads as a broken app rather than as a camera opening.
  const [live, setLive] = useState(false);

  const preview = useMemo<QrPreview>(
    () => ({
      show: stream => {
        const element = video.current;
        if (element !== null) element.srcObject = stream as MediaProvider;
        return element;
      },
      clear: () => {
        const element = video.current;
        if (element !== null) element.srcObject = null;
        setLive(false);
      },
    }),
    [],
  );

  const scan = useQrScan(host, preview, onText);
  const scanning = scan.phase === 'scanning';

  // The caller is told in an effect, not during render: revealing the paste
  // fallback is a state change in an ancestor, and React refuses one made while
  // a descendant is rendering.
  const failed = scan.phase === 'failed';
  useEffect(() => {
    if (failed) onFailed();
  }, [failed, onFailed]);

  return (
    <div className="flex flex-col gap-3">
      <section className={scanning ? 'flex flex-col gap-2' : 'hidden'} aria-label="Camera viewfinder">
        {/* `hidden`, not `sr-only`: an off-screen video is still a decoded video. */}
        <div className="relative overflow-hidden rounded-panel border border-border-strong bg-surface-3">
          <video
            ref={video}
            className="block aspect-square w-full object-cover"
            autoPlay
            muted
            playsInline
            onPlaying={() => setLive(true)}
          />
          {/* The reticle IS the instruction — "put the code in here" — and it is
              the only instruction that survives a glance. */}
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <div className="h-[62%] w-[62%] rounded-panel border-2 border-accent" />
          </div>
        </div>
        {/* Below the frame rather than over it: a caption laid on live camera
            pixels has no contrast anyone can promise, in either theme. */}
        <p className="m-0 text-center text-ui font-medium text-fg" role="status">
          {live ? 'Point at the QR code' : 'Starting the camera…'}
        </p>
      </section>

      {scanning ? (
        <button type="button" className="kt-btn min-h-[44px] w-full" onClick={scan.stop}>
          <X size={16} aria-hidden="true" />
          Stop scanning
        </button>
      ) : (
        <button
          type="button"
          className="kt-btn min-h-[64px] w-full text-title"
          data-variant="primary"
          onClick={scan.start}
          disabled={host === null}
        >
          <QrCode size={22} aria-hidden="true" />
          {label}
        </button>
      )}

      {scan.phase === 'failed' && scan.message !== null && (
        <p className="m-0 flex items-start gap-2 text-ui leading-base text-err" role="alert">
          <Camera size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
          {scan.message}
        </p>
      )}
    </div>
  );
}
