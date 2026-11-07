/**
 * WHETHER TMUX'S REFUSAL MEANS "THERE IS NO SERVER", as opposed to a command that failed.
 *
 * The daemon's private server only exists while something lives in it, so "no server" is the
 * ordinary state of a daemon with no terminals and no sessions — and a reader that treats it as a
 * failure turns an empty answer into an error nobody can clear. That is exactly what happened: the
 * terminal listing recognised `no server running` and `failed to connect`, while tmux 3.6a, on a
 * socket path nothing has created yet, says `error connecting to <socket> (No such file or
 * directory)`. The listing threw, the worktree removal read the throw as undetermined evidence about
 * live terminals, and no managed worktree could be removed on a fresh daemon at all.
 *
 * THE PHRASINGS ARE MEASURED, not guessed (tmux 3.6a, `tmux -S <path> list-sessions`):
 *
 * - `error connecting to <path> (No such file or directory)` — no socket file at all;
 * - `no server running on <path>` — a socket file left by a server that is gone;
 * - `failed to connect` — the spelling this listing already recognised, kept for the
 *   releases that print it.
 *
 * `server exited unexpectedly` is measured too and deliberately NOT here: the command reached a server
 * that then went away mid-request, which is a race rather than a statement that nothing is running,
 * and the exit observer must not settle a session on it.
 *
 * Only the CONNECTION refusals are matched. `error connecting to` with any other reason — a socket
 * this user may not open, say — is a real failure and stays one, because reading it as "nothing is
 * running" would let a removal proceed past terminals it could not see.
 */
const SERVER_ABSENT = /no server running|failed to connect|error connecting to .*\(No such file or directory\)/iu;

/** True when tmux refused because its server is not running, which means it holds nothing. */
export function isTmuxServerAbsent(stderr: string): boolean {
  return SERVER_ABSENT.test(stderr);
}
