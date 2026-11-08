import type { RunnerLook } from '@ferretry/core-ferrets/contract';
import type { JsonValue } from '@ferretry/std';
import type { PaneState } from './contracts.ts';
import { parseHarnessDialog } from './harness-dialog.ts';
import { paneActiveWork, paneBlockingPrompt, paneShowsPermissionPrompt } from './pane.ts';
import { parsePermissionPrompt } from './permission-prompt.ts';

/** A digest of a text: equal texts, equal digests; the text cannot be read back from it. */
export type FrameDigest = (text: string) => string;

/**
 * What one frame of a ferret's pane says about its turn (today's `turnPaneEvidenceOf` over these parsers), as the
 * runner contract carries it: `Runner.look`. The frame handed in is ALREADY MASKED, so every text derived from it — a
 * dialog's words, a permission prompt's command — is masked too. Pure: values in, a value out.
 */
export function turnLookOf(pane: PaneState, digest: FrameDigest): RunnerLook {
  const request = parsePermissionPrompt(pane.visible);
  const work = paneActiveWork(pane.visible);
  const prompt = paneBlockingPrompt(pane.visible);
  const dialog = parseHarnessDialog(pane.visible);
  return {
    frame: digest(pane.visible),
    working: work !== undefined,
    ...(work === 'spinner' ? { spinnerOnly: true } : {}),
    atPrompt: pane.promptReady,
    permission: request !== undefined || paneShowsPermissionPrompt(pane.visible),
    ...(prompt === undefined ? {} : { prompt }),
    ...(request === undefined ? {} : { request: request as unknown as JsonValue }),
    ...(dialog === undefined ? {} : { dialog: dialog as unknown as JsonValue }),
  };
}
