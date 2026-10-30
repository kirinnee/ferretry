import type { QueuedMessage, QueueWaitReason } from '@ferretry/protocol';

/** The tick a person reads for each state: one when accepted, two when delivered, three when read. */
const MARK: Readonly<Record<QueuedMessage['state'], string>> = {
  queued: '✓',
  typing: '✓ typing',
  delivered: '✓✓',
  read: '✓✓✓',
  unconfirmed: '? unconfirmed',
  cancelled: '✗ cancelled',
  failed: '✗ failed',
};

/** Why a waiting message has not gone yet, in plain words. */
const WAITING: Readonly<Record<QueueWaitReason, string>> = {
  launching: 'the ferret is still starting',
  busy: 'the ferret is busy',
  question: 'the ferret is waiting on a question',
  dialog: 'a dialog holds the ferret',
  draft: 'its box holds a draft',
  unreadable: "its screen can't be read",
  stopped: 'the ferret is not running',
};

/** The longest stretch of a message shown on its line. */
const PREVIEW_CHARS = 60;

const SENDER: Readonly<Record<QueuedMessage['sender'], string>> = { human: 'you', agent: 'ferret', daemon: 'Ferretry' };

function preview(text: string): string {
  const flat = text.replaceAll(/\s+/gu, ' ').trim();
  return flat.length > PREVIEW_CHARS ? `${flat.slice(0, PREVIEW_CHARS - 1)}…` : flat;
}

/** One line per message: its tick, who sent it, its words, and — while it waits — why. */
export function renderQueue(messages: readonly QueuedMessage[]): readonly string[] {
  if (messages.length === 0) return ['Nothing queued.'];
  return messages.map(message => {
    const who = message.fromName ?? SENDER[message.sender];
    const why =
      message.state === 'queued' && message.waitReason !== undefined
        ? ` — waiting: ${WAITING[message.waitReason]}`
        : '';
    const failure = message.state === 'failed' && message.failure !== undefined ? ` — ${message.failure}` : '';
    return `${MARK[message.state]}  ${message.id}  ${who}: ${preview(message.text)}${why}${failure}`;
  });
}
