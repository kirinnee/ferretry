import { type ReadMessage, readMessage } from '../../../../app/hypermedia/parse-message.ts';

/** A message these tests expect to be read as hypermedia: `readMessage` answers `null` only for text it shows as text. */
export function mustRead(...args: Parameters<typeof readMessage>): ReadMessage {
  const read = readMessage(...args);
  if (read === null) throw new Error('the message was shown as text, not read as hypermedia');
  return read;
}
