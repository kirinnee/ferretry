/**
 * THE CLEAN-UP A LIVE TURN GETS: "Fix" only, never "Polish".
 *
 * Live sends what it shows, so the words must stay the person's: Fix corrects names and obvious
 * mishearings; Polish rewrites. A configured Polish is therefore run as Fix when this device holds a
 * key (the style is a parameter of that call). The daemon's own route reads the style from
 * `voice.yaml` and takes none in the request, so with only a machine key and a machine style of
 * Polish the turn is sent as it was heard — the words are never rewritten, and the owner can set Fix
 * on the machine (docs/voice.md › Live voice).
 *
 * It follows the rest of dictation otherwise: nothing is sent while clean-up is off for the device or
 * the machine; a failure of any kind returns the raw words (`kept: 'raw'`) — never an error, because a
 * turn is never lost to a clean-up that failed; and the call is bounded to {@link LIVE_CLEANUP_TIMEOUT_MS} so
 * a slow provider cannot hold a message hostage behind its countdown.
 */

import type { DaemonConnection } from '../daemon-connection.ts';
import { requestDeviceCleanup } from '../stt/device-cleanup.ts';
import { enhance } from '../stt/enhancement.ts';
import { type RemoteEnhancementFetch, requestRemoteEnhancement } from '../stt/remote-enhancement.ts';
import type { DeviceSpeedupKeys } from '../stt/speedup-keys.ts';
import { isRemoteEnhancementProvider, type SttSettings, sttDictionary } from '../stt/stt-settings.ts';
import type { VoiceCleanup } from '../stt/voice-cleanup.ts';
import { verifyWordOnly } from '../stt/word-only-verifier.ts';

export const LIVE_CLEANUP_TIMEOUT_MS = 3_000;

export interface LiveCleanupDeps {
  readonly settings: SttSettings;
  /** The machine's cleanup settings (voice.yaml). */
  readonly cleanup: VoiceCleanup;
  readonly keys: DeviceSpeedupKeys | null;
  readonly daemon: DaemonConnection;
  readonly fetchImpl: RemoteEnhancementFetch;
  /** The conversation on screen, oldest first; `needsEvidence` is the local enhancer's "enough messages?" rule. */
  readContext(needsEvidence: boolean): readonly string[];
}

export interface CleanedTurn {
  readonly text: string;
  /** `cleaned`: the words changed; `raw`: clean-up was off, found nothing, was refused, or failed. */
  readonly kept: 'cleaned' | 'raw';
}

const raw = (text: string): CleanedTurn => ({ text, kept: 'raw' });

export async function cleanLiveTurn(text: string, deps: LiveCleanupDeps, signal: AbortSignal): Promise<CleanedTurn> {
  const { settings, cleanup } = deps;
  if (!settings.enhancement || text.trim() === '') return raw(text);
  const { entries } = sttDictionary(settings);
  if (!isRemoteEnhancementProvider(settings.enhancementProvider)) {
    const candidate = enhance({
      text,
      dictionary: entries,
      context: [...deps.readContext(true)],
      userContext: settings.userContext,
    });
    return candidate.text !== text && verifyWordOnly(text, candidate.text).ok
      ? { text: candidate.text, kept: 'cleaned' }
      : raw(text);
  }
  // Cleanup switched off on the machine: nothing is sent, nothing is spent.
  if (cleanup.style === 'off') return raw(text);
  const provider = settings.enhancementProvider;
  const context = cleanup.useConversation ? [...deps.readContext(false)].slice(-cleanup.conversationMessages) : [];
  try {
    const direct =
      deps.keys === null
        ? undefined
        : await requestDeviceCleanup(deps.keys, {
            provider,
            model: settings.enhancementModel,
            text,
            dictionary: entries,
            context,
            userContext: settings.userContext,
            // Fix only: a configured Polish runs as Fix in Live.
            cleanup: { ...cleanup, style: 'fix' },
            timeoutMs: LIVE_CLEANUP_TIMEOUT_MS,
            signal,
          });
    // The daemon takes no style in its request: under a machine style of Polish the words stay as heard.
    const result =
      direct ??
      (cleanup.style === 'polish'
        ? undefined
        : await requestRemoteEnhancement(deps.daemon, {
            provider,
            model: settings.enhancementModel,
            text,
            dictionary: entries,
            context,
            userContext: settings.userContext,
            timeoutMs: LIVE_CLEANUP_TIMEOUT_MS,
            signal,
            fetchImpl: deps.fetchImpl,
          }));
    if (result === undefined || result.kept === 'raw') return raw(text);
    const cleaned = result.text.trim();
    return cleaned === '' || cleaned === text.trim() ? raw(text) : { text: cleaned, kept: 'cleaned' };
  } catch {
    // Every failure — a timeout, a refusal, no key, a network — keeps the words as they were heard.
    return raw(text);
  }
}
