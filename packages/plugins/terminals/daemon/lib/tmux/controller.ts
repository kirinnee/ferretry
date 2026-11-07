import {
  capturePaneArguments,
  captureRowsArguments,
  deleteBufferArguments,
  hasSessionArguments,
  killPaneArguments,
  killSessionArguments,
  listSessionsArguments,
  loadBufferArguments,
  newSessionArguments,
  paneActivityArguments,
  paneIdentityArguments,
  paneIdentityTableArguments,
  paneMetadataArguments,
  paneSessionClientsArguments,
  parseControlClients,
  pasteBufferArguments,
  releasedKillArguments,
  remainOnExitArguments,
  sendKeyArguments,
  sendLiteralArguments,
  sessionClientsArguments,
} from './commands.ts';
import type { PaneActivity, PaneState, TmuxCommandPort, TmuxCommandResult, TmuxLaunch } from './contracts.ts';
import type { TmuxLaunchGuard } from './harness-guard.ts';
import {
  type PaneIdentity,
  paneStateFrom,
  parsePaneActivity,
  parsePaneIdentity,
  parsePaneIdentityTable,
  parsePaneMetadata,
} from './pane.ts';
import { type PaneSighting, paneProofArguments, parsePaneSighting } from './pane-proof.ts';
import { isTmuxServerAbsent } from './server-absent.ts';

/** How many times a kill is tried against clients that keep leaving before its failure is answered. */
const RELEASED_KILL_ATTEMPTS = 3;

/** Orchestrates only validated tmux commands; spawning remains in an injected adapter. */
export class TmuxController {
  /**
   * @param guard Consulted before every launch, and a refusal it throws fails that launch before any
   *   pane exists. A controller built without one launches whatever it is given, as it always did.
   */
  constructor(
    private readonly commands: TmuxCommandPort,
    private readonly guard?: TmuxLaunchGuard,
  ) {}

  async alive(session: string): Promise<boolean> {
    return (await this.commands.execute(hasSessionArguments(session))).code === 0;
  }

  async listSessions(): Promise<readonly string[]> {
    const result = await this.commands.execute(listSessionsArguments());
    if (result.code !== 0) return [];
    return result.stdout
      .split('\n')
      .map(value => value.trim())
      .filter(Boolean);
  }

  async capture(session: string, history = true): Promise<string> {
    const result = await this.commands.execute(capturePaneArguments(session, history));
    return result.code === 0 ? result.stdout : '';
  }

  /**
   * The pane's state now. `history: false` skips the scrollback — the whole of it, tens of kilobytes on
   * a long session — for a caller that reads only the screen; its `history` is then empty.
   */
  async state(session: string, options: { readonly history?: boolean } = {}): Promise<PaneState> {
    if (!(await this.alive(session))) return { alive: false, dead: true, promptReady: false, history: '', visible: '' };
    const history = options.history ?? true;
    const [metadataResult, historyResult, visibleResult] = await Promise.all([
      this.commands.execute(paneMetadataArguments(session)),
      history ? this.commands.execute(capturePaneArguments(session, true)) : undefined,
      this.commands.execute(capturePaneArguments(session, false)),
    ]);
    const metadata = parsePaneMetadata(metadataResult.code === 0 ? metadataResult.stdout : '1|||||');
    return paneStateFrom(
      metadata,
      visibleResult.code === 0 ? visibleResult.stdout : '',
      historyResult?.code === 0 ? historyResult.stdout : '',
    );
  }

  /**
   * Rows `first` to `last` of the visible frame with their attributes, or `undefined` when tmux could
   * not capture them — the second capture a composer's ink is read from, never a substitute for the first.
   */
  async rows(session: string, first: number, last: number): Promise<string | undefined> {
    const result = await this.commands.execute(captureRowsArguments(session, first, last));
    return result.code === 0 ? result.stdout : undefined;
  }

  /** The pane's metadata and activity stamp in one question, or `undefined` when the session is not there. */
  async activity(session: string): Promise<PaneActivity | undefined> {
    const result = await this.commands.execute(paneActivityArguments(session));
    return result.code === 0 ? parsePaneActivity(result.stdout) : undefined;
  }

  /** The visible frame, or `undefined` when tmux could not capture it — never an empty screen in its place. */
  async visible(session: string): Promise<string | undefined> {
    const result = await this.commands.execute(capturePaneArguments(session, false));
    return result.code === 0 ? result.stdout : undefined;
  }

  /**
   * Every session's active pane in ONE listing, keyed by session name, or `undefined` when tmux would
   * not list them. A server with no sessions — or none at all — is an empty table: there is no pane.
   */
  async paneIdentities(): Promise<ReadonlyMap<string, PaneIdentity> | undefined> {
    const result = await this.commands.execute(paneIdentityTableArguments());
    if (result.code === 0) return parsePaneIdentityTable(result.stdout);
    return isTmuxServerAbsent(result.stderr) ? new Map() : undefined;
  }

  async paneIdentity(session: string): Promise<PaneIdentity | undefined> {
    const result = await this.commands.execute(paneIdentityArguments(session));
    return result.code === 0 ? parsePaneIdentity(result.stdout) : undefined;
  }

  /** What tmux says the pane `-t <session>` names is, alive or dead (`pane-proof.ts`). */
  async paneSighting(session: string): Promise<PaneSighting | undefined> {
    const result = await this.commands.execute(paneProofArguments(session));
    return result.code === 0 ? parsePaneSighting(result.stdout) : undefined;
  }

  async killPaneExact(paneId: string): Promise<void> {
    const result = await this.releasedKill(paneSessionClientsArguments(paneId), killPaneArguments(paneId));
    if (result.code !== 0) throw new Error(result.stderr.trim() || 'tmux could not kill the pane');
  }

  async launch(launch: TmuxLaunch): Promise<void> {
    await this.guard?.check(launch);
    if (await this.alive(launch.session)) throw new Error(`tmux session already exists: ${launch.session}`);
    const created = await this.commands.execute(newSessionArguments(launch));
    if (created.code !== 0) throw new Error(created.stderr.trim() || 'tmux could not create the session');
    const configured = await this.commands.execute(remainOnExitArguments(launch.session));
    if (configured.code !== 0) throw new Error(configured.stderr.trim() || 'tmux could not configure the session');
  }

  async sendLiteral(session: string, text: string): Promise<void> {
    const result = await this.commands.execute(sendLiteralArguments(session, text));
    if (result.code !== 0) throw new Error(result.stderr.trim() || 'tmux could not send literal text');
  }

  async sendKey(session: string, key: string): Promise<void> {
    const result = await this.commands.execute(sendKeyArguments(session, key));
    if (result.code !== 0) throw new Error(result.stderr.trim() || 'tmux could not send key');
  }

  /**
   * Deliver text to the pane as one bracketed-paste event.
   *
   * The buffer is deleted on the way out of BOTH paths. `paste-buffer -d` does it on success; the
   * failure path does it explicitly, because a load that pasted into nothing would otherwise leave
   * the payload sitting in the tmux server until the daemon is restarted.
   */
  async paste(session: string, text: string): Promise<void> {
    if (text.length === 0) throw new Error('paste text must not be empty');
    const loaded = await this.commands.execute(loadBufferArguments(session), text);
    if (loaded.code !== 0) throw new Error(loaded.stderr.trim() || 'tmux could not load the paste buffer');
    const pasted = await this.commands.execute(pasteBufferArguments(session));
    if (pasted.code !== 0) {
      await this.commands.execute(deleteBufferArguments(session));
      throw new Error(pasted.stderr.trim() || 'tmux could not paste into the pane');
    }
  }

  async stop(session: string): Promise<void> {
    if (!(await this.alive(session))) return;
    const result = await this.releasedKill(sessionClientsArguments(session), killSessionArguments(session));
    if (result.code !== 0) throw new Error(result.stderr.trim() || 'tmux could not stop the session');
  }

  /**
   * Kills `kill`'s target only after releasing the control clients on its session, in one command list
   * (`releasedKillArguments` says why: tmux 3.6a otherwise crashes the whole server).
   *
   * Retried when it fails with clients in the list, because the usual cause is one of them leaving
   * between the listing and the kill — and the next listing no longer names it. A failure with no
   * client to release is the kill's own and is answered at once. A listing tmux would not give is
   * read as no clients: the session is almost always gone by then, and refusing to kill one that is
   * not would be a stop that never stops.
   */
  private async releasedKill(listing: readonly string[], kill: readonly string[]): Promise<TmuxCommandResult> {
    for (let attempt = 1; ; attempt += 1) {
      const listed = await this.commands.execute(listing);
      const clients = listed.code === 0 ? parseControlClients(listed.stdout) : [];
      const result = await this.commands.execute(releasedKillArguments(clients, kill));
      if (result.code === 0 || clients.length === 0 || attempt >= RELEASED_KILL_ATTEMPTS) return result;
    }
  }
}
