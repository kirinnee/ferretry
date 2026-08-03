type OrientationLockCapable = ScreenOrientation & {
  lock?: (orientation: 'portrait' | 'portrait-primary') => Promise<void>;
};

/** Requests portrait when the platform allows it, without treating refusal as an error. */
export async function attemptPortraitLock(screenLike: { orientation?: ScreenOrientation } = screen): Promise<boolean> {
  const orientation = screenLike.orientation as OrientationLockCapable | undefined;
  if (orientation === undefined || typeof orientation.lock !== 'function') return false;
  try {
    await orientation.lock('portrait');
    return true;
  } catch {
    return false;
  }
}

/**
 * What the platform can tell us about how the device is actually held.
 *
 * `innerWidth`/`innerHeight` are deliberately absent. A software keyboard collapses the
 * viewport — an upright 360x800 phone reports 360x345 with the keyboard open — so viewport
 * arithmetic reads a portrait phone as landscape and mounts the rotate-back gate on top of
 * the page the person is typing into. Only evidence a keyboard cannot move is admissible.
 */
export interface OrientationEvidence {
  readonly matchMedia?: typeof matchMedia;
  readonly screen?: {
    readonly orientation?: { readonly type?: string };
    readonly width?: number;
    readonly height?: number;
  };
}

/** Phones stop here; a tablet held sideways is a supported layout, not a mistake. */
const PHONE_SHORT_SIDE_MAX_PX = 500;

/** Landscape as the platform reports it, or `undefined` when it reports nothing usable. */
function readLandscape(view: OrientationEvidence): boolean | undefined {
  const reported = view.screen?.orientation?.type;
  if (typeof reported === 'string' && reported !== '') return reported.startsWith('landscape');
  const media = view.matchMedia?.('(orientation: landscape)');
  return media === undefined ? undefined : media.matches;
}

/** The shorter side of the screen itself, which no on-screen keyboard can shrink. */
function readShortScreenSide(view: OrientationEvidence): number | undefined {
  const width = view.screen?.width;
  const height = view.screen?.height;
  if (typeof width !== 'number' || typeof height !== 'number') return undefined;
  const shortest = Math.min(width, height);
  return Number.isFinite(shortest) && shortest > 0 ? shortest : undefined;
}

/**
 * A phone held sideways, judged only on evidence a software keyboard cannot move.
 *
 * Ambiguity refuses the gate rather than assuming it: an overlay wrongly mounted over a
 * working page is precisely the failure this answer exists to prevent, and a device that
 * hides its orientation has given us no grounds to interrupt anyone.
 */
export function isPhoneLandscape(view: OrientationEvidence): boolean {
  if (view.matchMedia?.('(pointer: coarse)').matches !== true) return false;
  const shortSide = readShortScreenSide(view);
  if (shortSide === undefined || shortSide > PHONE_SHORT_SIDE_MAX_PX) return false;
  return readLandscape(view) === true;
}

/** Must match the `#fy-portrait-gate` rule in `styles/index.css`; a mismatched id ships the
 *  gate as unstyled block text interleaved with the page instead of a layer over it. */
const GATE_ID = 'fy-portrait-gate';

/** Mounts at most one honest rotate-back gate, leaving desktop/tablet landscape untouched. */
export function syncPortraitGate(doc: Document = document, view: Window = window): void {
  const existing = doc.getElementById(GATE_ID);
  if (!isPhoneLandscape(view)) {
    existing?.remove();
    return;
  }
  if (existing !== null) return;
  const gate = doc.createElement('div');
  gate.id = GATE_ID;
  gate.setAttribute('role', 'alertdialog');
  gate.setAttribute('aria-label', 'Rotate your device to portrait');
  gate.innerHTML =
    '<div class="fy-portrait-gate__inner">' +
    '<div class="fy-portrait-gate__icon" aria-hidden="true">&#x21bb;</div>' +
    '<p class="fy-portrait-gate__title">Turn your phone upright</p>' +
    '<p class="fy-portrait-gate__body">Ferretry is portrait-only on phones.</p>' +
    '</div>';
  doc.body.appendChild(gate);
}

/** Syncs the visual fallback and retries a platform lock once after a user gesture. */
export function installPortraitLock(view: Window = window, doc: Document = document): void {
  const sync = (): void => syncPortraitGate(doc, view);
  void attemptPortraitLock().then(locked => {
    if (!locked) {
      const retry = (): void => {
        void attemptPortraitLock().then(sync);
      };
      view.addEventListener('pointerdown', retry, { once: true });
    }
    sync();
  });
  view.addEventListener('resize', sync);
  view.addEventListener('orientationchange', sync);
  sync();
}
