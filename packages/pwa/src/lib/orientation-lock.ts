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

/** Phones in a short, coarse-pointer landscape viewport need the rotate-back gate. */
export function isPhoneLandscape(view: {
  readonly innerWidth: number;
  readonly innerHeight: number;
  readonly matchMedia?: typeof matchMedia;
}): boolean {
  if (view.innerWidth <= view.innerHeight || view.innerHeight > 500) return false;
  return view.matchMedia?.('(pointer: coarse)').matches ?? false;
}

const GATE_ID = 'ferretry-portrait-gate';

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
