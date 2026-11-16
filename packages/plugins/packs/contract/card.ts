import { z } from 'zod';

/** A board card's id as the asking ferret names it (`--card F12`): a letter for its kind, then a number. */
export const CARD_ID_PATTERN = /^[BFIC][1-9][0-9]{0,8}$/u;
export const CardIdSchema = z.string().regex(CARD_ID_PATTERN);
export type CardId = z.infer<typeof CardIdSchema>;
