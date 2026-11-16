import { z } from 'zod';

/** The longest URL an agent may navigate to. */
export const AGENT_TOOL_MAX_URL_CHARS = 2_048;
/** The longest sentence an agent may leave the owner when it hands a surface over. */
export const AGENT_TOOL_MAX_ASK_CHARS = 280;

/** What the owner is asked to do when a surface is handed to them: a short plain sentence, never a secret. */
export const AskOwnerMessageSchema = z.string().trim().min(1).max(AGENT_TOOL_MAX_ASK_CHARS);

/** Whether an agent may be sent to this address: only web pages. An agent has no business opening `file:`, `javascript:`, `data:` or `chrome:` URLs. */
export function isWebUrl(value: string): boolean {
  return URL.canParse(value) && ['http:', 'https:'].includes(new URL(value).protocol);
}

/** The sentence an agent is told when it names an address that is not a web page. */
export const WEB_URL_ONLY = 'only http and https URLs can be opened';
