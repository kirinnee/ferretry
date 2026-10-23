import { z } from 'zod';

/**
 * HANDING A LINK TO THIS COMPUTER'S OWN BROWSER, as the wire describes it.
 *
 * `POST /v1/system/open-url` asks the daemon to give one web address to the operating system's
 * default opener. It exists for the app installed in one browser whose reader wants links in another
 * (macOS Finicky, a work profile): only the OS knows that choice.
 *
 * THE SCHEMA ONLY BOUNDS THE SHAPE. What counts as an openable address — http or https, no
 * credentials, no scripting scheme — is the daemon's decision at its own boundary, because that is the
 * one place a refusal protects anything. The answer carries the host and nothing else, so a link with a
 * token in its query never travels back out.
 */

/** The longest address the daemon will hand to the operating system. */
export const OPEN_URL_MAX_LENGTH = 2048 as const;

export const OpenUrlRequestSchema = z.strictObject({
  url: z.string().min(1).max(OPEN_URL_MAX_LENGTH),
});
export type OpenUrlRequest = z.infer<typeof OpenUrlRequestSchema>;

export const OpenUrlViewSchema = z.strictObject({
  opened: z.literal(true),
  /** The host the address named: all the daemon records or repeats about it. */
  host: z.string().min(1).max(253),
});
export type OpenUrlView = z.infer<typeof OpenUrlViewSchema>;
