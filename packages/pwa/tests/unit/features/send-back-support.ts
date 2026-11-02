import { afterEach, beforeEach } from 'bun:test';
import { writeMdComposePref } from '../../../src/lib/md-compose.ts';
import { interact, must } from '../../support/dom.ts';
import { flush } from '../board-support.ts';

/** Draws the send-back box's composer as a plain textarea, the editor these suites drive; call once per file. */
export const plainSendBackEditor = (): void => {
  beforeEach(() => writeMdComposePref('off'));
  afterEach(() => writeMdComposePref('on'));
};

/** The send-back box ("Not good", "Not yet"): the one component every host draws. */
export const sendBackBox = (root: ParentNode): HTMLElement =>
  must(root.querySelector<HTMLElement>('[data-board-send-back]'), 'the send-back box');

export const sendBackField = (box: ParentNode): HTMLTextAreaElement =>
  must(box.querySelector<HTMLTextAreaElement>('form textarea'), 'the send-back field');

export const sendBackSubmit = (box: ParentNode): HTMLButtonElement =>
  must(box.querySelector<HTMLButtonElement>('button[data-composer-send]'), 'the send-back submit');

export const writeSendBack = async (box: ParentNode, words: string): Promise<void> => {
  const field = sendBackField(box);
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(field, words);
  await interact(() => field.dispatchEvent(new Event('input', { bubbles: true })));
};

/** Writes the words and sends them, as the owner would with the Send back button. */
export const sendBack = async (box: ParentNode, words: string): Promise<void> => {
  await writeSendBack(box, words);
  await interact(() => sendBackSubmit(box).click());
  await interact(() => flush());
};
