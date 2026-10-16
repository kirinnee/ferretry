/**
 * HOW AN ATTACHED FILE REACHES THE AGENT.
 *
 * Both harnesses this daemon drives take a file the same way from a typed prompt: by its PATH. Claude
 * Code's Read tool opens images, PDFs and text by path, and Codex views an image or reads a file by
 * path — neither has a way to receive bytes through the pane, and pasting bytes into a TUI is not a
 * thing either supports. So a send that names attachments is delivered as the person's message plus a
 * short list of absolute paths, each a copy of the stored original under the file's own name, because
 * a harness decides what a file IS from its extension and the stored original has none.
 *
 * PURE. The copy is the composition root's (`bin/fyd.ts`); what the agent is told, and what a usable
 * delivered name is, are decided here.
 */

import { basename } from 'node:path';

/** One file as the agent is told about it. */
export interface DeliveredAttachment {
  readonly path: string;
  readonly mime: string;
}

/**
 * The name a delivered copy is written under: the uploaded file's own basename, reduced to characters
 * that need no quoting in a prompt, and never one of the store's reserved entry names.
 */
export function deliveredFilename(filename: string): string {
  const bare = basename(filename.replaceAll('\\', '/'))
    .replace(/[^\w.-]+/gu, '-')
    .replace(/^[-.]+/u, '');
  if (bare === '' || bare === 'original' || bare === 'manifest.json') return `attachment-${bare || 'file'}`;
  return bare;
}

/** The person's message, followed by the files the agent should open. */
export function messageWithAttachments(message: string, files: readonly DeliveredAttachment[]): string {
  if (files.length === 0) return message;
  const lines = files.map(file => `- ${file.path} (${file.mime})`);
  return `${message}\n\nAttached files — open them from these paths:\n${lines.join('\n')}`;
}
