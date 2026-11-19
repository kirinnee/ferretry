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
import { Camera, ImageUp, Link2, QrCode, X } from 'lucide-react';
import { type ChangeEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { ChoiceCards, type ChoiceOption } from '@ferretry/app';

import { useDeviceFacts } from '../../hooks/use-device-permissions.ts';
import { useQrScan } from '../../hooks/use-qr-scan.ts';
import { howToEnable } from '../../lib/device-permissions.ts';
import type { QrPreview, QrScanHost } from '../../lib/pair-scan.ts';
import { QrImageError, readQrImageInBrowser } from './qr-image.ts';

export interface PairScannerProps {
  /** `null` where this browser cannot scan; the caller shows paste instead. */
  readonly host: QrScanHost | null;
  /** Whether the pasted-link field is open, so its way reads as the chosen one. */
  readonly pasteOpen: boolean;
  /** Open the pasted-link field (the third way; the form itself is the caller's). */
  readonly onPaste: () => void;
  /**
   * Bumps on every change to the pasted-link field. Typing there is choosing the pasted way, so a picture still being
   * read is let go the moment it changes. A count only: the typed text never reaches this component.
   */
  readonly typedRevision?: number;
  /** Reads one picture to its QR text; the page's own decoder unless a suite hands another. Never rendered or kept. */
  readonly readImage?: (file: Blob) => Promise<string>;
  /** The raw decoded text of the first QR code seen. */
  readonly onText: (text: string) => void;
  /** A scan that ended in a refusal, so the caller can reveal its fallback. */
  readonly onFailed: () => void;
}

export function PairScanner({
  host,
  pasteOpen,
  onPaste,
  typedRevision = 0,
  readImage = readQrImageInBrowser,
  onText,
  onFailed,
}: PairScannerProps) {
  const video = useRef<HTMLVideoElement | null>(null);
  // True once frames are actually arriving. Permission prompts and camera
  // warm-up take a visible moment on a phone, and a black rectangle with no
  // caption reads as a broken app rather than as a camera opening.
  const [live, setLive] = useState(false);

  const preview = useMemo<QrPreview>(
    () => ({
      show: stream => {
        const element = video.current;
        if (element !== null) {
          element.srcObject = stream as MediaProvider;
          // iOS Safari will not play a camera stream it was not told, in the page, is muted and inline;
          // React sets `muted` as a property only, so the attributes are written here as well.
          element.muted = true;
          element.setAttribute('muted', '');
          element.setAttribute('playsinline', '');
          void Promise.resolve(element.play()).catch(() => undefined);
        }
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
  const upload = useQrUpload(readImage, onText, typedRevision);
  const facts = useDeviceFacts();
  const scanning = scan.phase === 'scanning';
  // A click anywhere on the pasted way's card is choosing it, even when it is already the chosen one. The card is a
  // native radio, and choosing a chosen radio again raises no change, so a re-choice is read from the click itself.
  // A ref callback, because the group is mounted and unmounted as scanning starts and stops.
  const cancelUpload = upload.cancel;
  const group = useCallback(
    (element: HTMLDivElement | null) => {
      if (element === null) return undefined;
      const onClick = (event: Event): void => {
        if (event.target instanceof Element && event.target.closest('[data-choice="paste"]') !== null) cancelUpload();
      };
      element.addEventListener('click', onClick);
      return () => element.removeEventListener('click', onClick);
    },
    [cancelUpload],
  );
  // Starting the camera is choosing another way: a picture still being read is let go.
  useEffect(() => {
    if (scanning) cancelUpload();
  }, [scanning, cancelUpload]);

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
            <div className="h-[62%] w-[62%] rounded-panel border-heavy border-accent" />
          </div>
        </div>
        {/* Below the frame rather than over it: a caption laid on live camera
            pixels has no contrast anyone can promise, in either theme. */}
        <p className="m-0 text-center text-ui font-medium text-fg" role="status">
          {live ? 'Point at the QR code' : 'Starting the camera…'}
        </p>
      </section>

      {scanning ? (
        <button type="button" className="kt-btn min-h-[44px] self-center px-6 py-3" onClick={scan.stop}>
          <X size={16} aria-hidden="true" />
          Stop scanning
        </button>
      ) : (
        // Three equal ways in, none of them the "real" one: the app's choice cards, never a full-width bar.
        <div ref={group} data-pair-ways="">
          <ChoiceCards
            label="Ways to read the pairing code"
            value={pasteOpen ? 'paste' : null}
            options={ways(host !== null, upload.busy)}
            onChange={id => {
              if (id === 'scan') scan.start();
              else if (id === 'upload') upload.pick();
              else {
                // Every explicit choice of the pasted way lets a read in flight go; typing does the same.
                upload.cancel();
                onPaste();
              }
            }}
          />
        </div>
      )}
      <input
        ref={upload.input}
        type="file"
        accept="image/*"
        className="hidden"
        tabIndex={-1}
        aria-label="QR code image"
        data-pair-upload=""
        onChange={event => void upload.read(event)}
      />
      {upload.problem === null ? null : (
        <p className="m-0 text-ui leading-base text-err" role="alert" data-pair-upload-problem="">
          {upload.problem}
        </p>
      )}

      {scan.phase === 'failed' && scan.message !== null && (
        <p className="m-0 flex items-start gap-2 text-ui leading-base text-err" role="alert">
          <Camera size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
          {scan.message}
        </p>
      )}

      {scan.code === 'permission-denied' ? (
        <div
          className="flex flex-col gap-1 rounded-control border border-border bg-surface-2 px-control-x py-3"
          data-camera-howto=""
        >
          <span className="text-ui font-semibold text-fg">To scan, turn the camera back on:</span>
          <ol className="m-0 flex list-decimal flex-col gap-1 pl-5 text-meta leading-base text-fg">
            {howToEnable('camera', facts).map(step => (
              <li key={step}>{step}</li>
            ))}
          </ol>
          <span className="text-meta leading-base text-muted">Or paste the pairing link below instead.</span>
        </div>
      ) : null}

      {host === null ? (
        <p className="m-0 text-meta leading-base text-muted" data-camera-unavailable="">
          {facts.secure
            ? 'This browser cannot scan here. Paste the pairing link below instead.'
            : 'This page is not on a secure (https) connection, so it cannot open the camera. Paste the pairing link below instead.'}
        </p>
      ) : null}
    </div>
  );
}

const ways = (canScan: boolean, reading: boolean): readonly ChoiceOption[] => [
  { id: 'scan', title: 'Scan QR code', icon: <QrCode size={22} />, disabled: !canScan },
  { id: 'upload', title: reading ? 'Reading…' : 'Upload a QR image', icon: <ImageUp size={22} />, disabled: reading },
  { id: 'paste', title: 'Paste a link', icon: <Link2 size={22} /> },
];

/**
 * The upload way: pick a picture, read its QR in this tab, hand the text up.
 *
 * The picture and the text live in the handler only. The input is emptied as soon as the read ends (so the same
 * picture can be chosen again, and nothing keeps the file), and what is shown is a sentence about the picture, never
 * its content.
 */
function useQrUpload(
  readImage: (file: Blob) => Promise<string>,
  onText: (text: string) => void,
  typedRevision: number,
) {
  const input = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // Which read is the live one. A read that finishes after the person has moved on — this way unmounted (the screen went
  // on to confirm a pasted link, or the camera started), the pasted way chosen or typed into, or a newer picture chosen
  // — is stale and must neither speak nor hand its text up. A counter, not a mounted flag: a flag set false in cleanup
  // stays false when StrictMode replays the effect, and would leave the button on "Reading…" with no error.
  const run = useRef(0);
  useEffect(
    () => () => {
      run.current += 1;
    },
    [],
  );
  const cancel = useCallback((): void => {
    run.current += 1;
    setBusy(false);
  }, []);
  const lastRevision = useRef(typedRevision);
  useEffect(() => {
    if (lastRevision.current === typedRevision) return;
    lastRevision.current = typedRevision;
    cancel();
  }, [typedRevision, cancel]);

  const read = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const element = event.currentTarget;
    const file = element.files?.[0];
    if (file === undefined) return;
    run.current += 1;
    const mine = run.current;
    setProblem(null);
    setBusy(true);
    let text: string | undefined;
    try {
      text = await readImage(file);
    } catch (reason) {
      if (run.current === mine)
        setProblem(reason instanceof QrImageError ? reason.message : 'That image could not be read.');
    } finally {
      element.value = '';
      if (run.current === mine) setBusy(false);
    }
    if (text !== undefined && run.current === mine) onText(text);
  };

  return { input, busy, problem, read, cancel, pick: () => input.current?.click() };
}
