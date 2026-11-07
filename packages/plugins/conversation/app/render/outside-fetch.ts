/**
 * THE ONE PLACE THIS HALF SPELLS "the real network", for the two requests that never talk to a daemon: the parent's
 * fetch of one pinned library bundle from the app's own origin (the sandbox frame may request nothing itself), and the
 * read of an `https` image a message links to, from a stranger's server with nothing of this app riding along.
 * Every daemon request goes through the plugin client (`client.ts`); this is not a way around it.
 *
 * `fetch` is a WebIDL operation on the global, and a bare builtin stored and called as a member is rejected
 * ("Illegal invocation"), so it is wrapped rather than passed around.
 */
export const outsideFetch = (input: string | URL | Request, init?: RequestInit): Promise<Response> =>
  globalThis.fetch(input, init);
