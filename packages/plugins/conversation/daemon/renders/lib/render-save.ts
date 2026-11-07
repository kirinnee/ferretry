/**
 * Whether a picture may be saved: the rule the daemon applies BEFORE anything is written, built from the
 * same `fy-render` grammar core the reader runs, so a save the daemon refuses is a block the app would have
 * refused (docs/renders.md § Validation).
 *
 * Returns the refusal as a sentence, or `null` when the save is fine. It reads strings and nothing else.
 */
import { LONE_SURROGATE, parseFyRenderHeaders, validateHtml, validateSvg } from './fy-render.ts';
import type { RenderSaveRequest } from '../../../contract/index.ts';

export function renderSaveRefusal(request: Pick<RenderSaveRequest, 'kind' | 'alt' | 'payload'>): string | null {
  // The alt goes through the header parser the fence uses (non-empty, no control character, at most the alt
  // cap). A line break would be read as a second header line, so it is refused as what it is.
  if (/[\r\n]/u.test(request.alt)) return 'Alt text must be one line without control characters';
  const headers = parseFyRenderHeaders([`type: ${request.kind}`, `alt: ${request.alt}`]);
  if (typeof headers === 'string') return headers;
  // Stored as UTF-8, so a lone surrogate would come back as U+FFFD and the digest would name other bytes.
  if (LONE_SURROGATE.test(request.alt) || LONE_SURROGATE.test(request.payload))
    return 'The text contains an unpaired UTF-16 surrogate';
  if (request.payload.trim().length === 0) return 'The payload must not be empty';
  return request.kind === 'svg' ? validateSvg(request.payload) : validateHtml(request.payload);
}
