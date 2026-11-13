import { z } from 'zod';

/** The longest URL an agent may navigate to. */
export const AGENT_TOOL_MAX_URL_CHARS = 2_048;
/** The longest sentence an agent may leave the owner when it hands a surface over. */
export const AGENT_TOOL_MAX_ASK_CHARS = 280;

/** What the owner is asked to do when a surface is handed to them: a short plain sentence, never a secret. */
export const AskOwnerMessageSchema = z.string().trim().min(1).max(AGENT_TOOL_MAX_ASK_CHARS);
