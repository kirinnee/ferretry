/**
 * The words box a "Not good" or "Not yet" asks in (`data-inbox-gate-why`): the Inbox's own, a plain textarea with a
 * Cancel and a submit. Agenda's helpers, driving Agenda's box.
 */

import { interact, must } from '@ferretry/app/testing';

/** The input-modality store is shared by the whole process: a touch in another suite would stop Enter sending here. */
export const mouseIsLastPointer = async (): Promise<void> => {
  const mouse = new Event('pointerdown');
  Object.defineProperty(mouse, 'pointerType', { value: 'mouse' });
  await interact(() => window.dispatchEvent(mouse));
};

/** The box is a plain textarea already, so there is no rich editor to turn off: kept so each suite says it. */
export const plainSendBackEditor = (): void => undefined;

export const sendBackBox = (root: ParentNode): HTMLElement =>
  must(root.querySelector<HTMLElement>('[data-inbox-gate-why]'), 'the send-back box');

const sendBackField = (box: ParentNode): HTMLTextAreaElement =>
  must(box.querySelector<HTMLTextAreaElement>('form textarea'), 'the send-back field');

export const sendBackSubmit = (box: ParentNode): HTMLButtonElement =>
  must(box.querySelector<HTMLButtonElement>('form button[type="submit"]'), 'the send-back submit');

export const writeSendBack = async (box: ParentNode, words: string): Promise<void> => {
  const field = sendBackField(box);
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(field, words);
  await interact(() => field.dispatchEvent(new Event('input', { bubbles: true })));
};
