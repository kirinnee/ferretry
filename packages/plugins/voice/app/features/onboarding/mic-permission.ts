/**
 * THE MICROPHONE'S PERMISSION, as the Voice step needs it: what the browser says now, and a way to ask. Total: neither call
 * ever throws, and every way it can go wrong is a state that carries the sentence to say (what happened and the remedy).
 *
 *   - `prompt`       the browser will ask when the person presses Allow (or it cannot say, which reads the same).
 *   - `granted`      the microphone opens without a question.
 *   - `denied`       the browser (or the person) said no; only the browser's site settings can change that.
 *   - `unavailable`  there is nothing to ask: no microphone API on this page, no microphone plugged in, or another app holds it.
 *
 * `request` opens the microphone once and shuts it again at once: it is the permission prompt, nothing is recorded here.
 * Call it from the button's own click so the prompt belongs to it.
 */

export type MicState =
  | { readonly kind: 'prompt' }
  | { readonly kind: 'granted' }
  | { readonly kind: 'denied'; readonly message: string }
  | { readonly kind: 'unavailable'; readonly message: string; readonly retry: boolean };

export interface MicPort {
  /** What the browser says now, without asking. */
  state(): Promise<MicState>;
  /** Ask (opens the microphone once and closes it). Resolves to the state after the answer. */
  request(): Promise<MicState>;
}

export const MIC_DENIED_MESSAGE =
  'The browser is blocking the microphone for this page. Click the lock icon beside the address, set Microphone to Allow, then press Try again.';
export const MIC_INSECURE_MESSAGE =
  'This page cannot use a microphone. Open Ferretry over https, or at localhost. You can still type to your ferrets.';
export const MIC_MISSING_MESSAGE = 'No microphone was found. Plug one in or switch one on, then press Try again.';
export const MIC_BUSY_MESSAGE = 'Another app is using the microphone. Close it, then press Try again.';

interface TrackLike {
  stop(): void;
}

/** The slice of the page this port reads, so a test hands it plain objects. */
export interface MicGlobalLike {
  readonly navigator?: {
    readonly mediaDevices?: { getUserMedia(constraints: { audio: boolean }): Promise<{ getTracks(): TrackLike[] }> };
    readonly permissions?: { query(descriptor: { name: string }): Promise<{ readonly state: string }> };
  };
}

const nameOf = (error: unknown): string => {
  const name = (error as { name?: unknown } | null)?.name;
  return typeof name === 'string' ? name : '';
};

/** The state a failed `getUserMedia` means. */
const micStateOfError = (error: unknown): MicState => {
  switch (nameOf(error)) {
    case 'NotAllowedError':
    case 'SecurityError':
    case 'PermissionDeniedError':
      return { kind: 'denied', message: MIC_DENIED_MESSAGE };
    case 'NotFoundError':
    case 'OverconstrainedError':
    case 'DevicesNotFoundError':
      return { kind: 'unavailable', message: MIC_MISSING_MESSAGE, retry: true };
    case 'NotReadableError':
    case 'AbortError':
    case 'TrackStartError':
      return { kind: 'unavailable', message: MIC_BUSY_MESSAGE, retry: true };
    default:
      return { kind: 'unavailable', message: MIC_INSECURE_MESSAGE, retry: false };
  }
};

/** The production port over the page's own `navigator`. */
export function browserMic(global: MicGlobalLike = globalThis as unknown as MicGlobalLike): MicPort {
  const devices = global.navigator?.mediaDevices;
  const canOpen = typeof devices?.getUserMedia === 'function';
  const unavailable: MicState = { kind: 'unavailable', message: MIC_INSECURE_MESSAGE, retry: false };
  return {
    state: async () => {
      if (!canOpen) return unavailable;
      try {
        const status = await global.navigator?.permissions?.query({ name: 'microphone' });
        if (status?.state === 'granted') return { kind: 'granted' };
        if (status?.state === 'denied') return { kind: 'denied', message: MIC_DENIED_MESSAGE };
      } catch {
        // Some browsers refuse to name the microphone here: it reads as "will ask".
      }
      return { kind: 'prompt' };
    },
    request: async () => {
      if (!canOpen || devices === undefined) return unavailable;
      try {
        const stream = await devices.getUserMedia({ audio: true });
        for (const track of stream.getTracks()) track.stop();
        return { kind: 'granted' };
      } catch (error) {
        return micStateOfError(error);
      }
    },
  };
}
