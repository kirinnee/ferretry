import type { OpeningAttachmentsSource } from '@ferretry/core-ferrets/contract';
import { err, ok } from '@ferretry/std';
import {
  decodeInitialAttachments,
  InitialAttachmentError,
  planInitialAttachments,
  type RawDeflatePort,
  renderInitialAttachmentSection,
} from '../lib/index.ts';
import { NodeRawDeflate } from './raw-deflate.ts';

/**
 * What Conversation answers when a start carries files (`fy start -f`, today's `composeOpeningMessage`): the files
 * decoded and bounded (sixteen at most, 32 MiB decoded in all), a document's text extracted beside the original, and the
 * "## Attachments" section that names every file by absolute path for the opening message. Pure: nothing is written
 * here. Ferrets writes the planned files into the ferret's own `attachments/` folder and appends the section to the task.
 *
 * A refusal the decoding states (too many, too large, an unsafe name, undecodable bytes) is a sentence for the caller;
 * anything else is a defect and is rethrown rather than worded as a caller's mistake.
 */
export function openingAttachmentsSource(deflater: RawDeflatePort = new NodeRawDeflate()): OpeningAttachmentsSource {
  return {
    plan: ({ attachments, directory }) => {
      try {
        const planned = planInitialAttachments(decodeInitialAttachments(attachments), directory, deflater);
        return ok({ section: renderInitialAttachmentSection(planned.delivered), files: planned.files });
      } catch (error) {
        if (error instanceof InitialAttachmentError) return err(error.message);
        throw error;
      }
    },
  };
}
