import {
  capturePaneArguments,
  deleteBufferArguments,
  hasSessionArguments,
  killPaneArguments,
  killSessionArguments,
  listSessionsArguments,
  loadBufferArguments,
  newSessionArguments,
  paneMetadataArguments,
  paneIdentityArguments,
  pasteBufferArguments,
  remainOnExitArguments,
  sendKeyArguments,
  sendLiteralArguments,
} from './commands.ts';
import type { PaneState, TmuxCommandPort, TmuxLaunch } from './contracts.ts';
import { parsePaneMetadata, promptIsReady } from './pane.ts';

/** Orchestrates only validated tmux commands; spawning remains in an injected adapter. */
export class TmuxController {
  constructor(private readonly commands: TmuxCommandPort) {}

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

  async state(session: string): Promise<PaneState> {
    if (!(await this.alive(session))) return { alive: false, dead: true, promptReady: false, history: '', visible: '' };
    const [metadataResult, historyResult, visibleResult] = await Promise.all([
      this.commands.execute(paneMetadataArguments(session)),
      this.commands.execute(capturePaneArguments(session, true)),
      this.commands.execute(capturePaneArguments(session, false)),
    ]);
    const metadata = parsePaneMetadata(metadataResult.code === 0 ? metadataResult.stdout : '1|||||');
    const visible = visibleResult.code === 0 ? visibleResult.stdout : '';
    return {
      alive: true,
      ...metadata,
      promptReady: !metadata.dead && promptIsReady(visible, metadata.cursorY, metadata.cursorX),
      history: historyResult.code === 0 ? historyResult.stdout : '',
      visible,
    };
  }

  async paneIdentity(session: string): Promise<{ readonly paneId: string; readonly pid: number } | undefined> {
    const result = await this.commands.execute(paneIdentityArguments(session));
    if (result.code !== 0) return undefined;
    const [paneId = '', rawPid = ''] = result.stdout.trim().split('\t');
    const pid = Number(rawPid);
    return /^%[1-9][0-9]*$/u.test(paneId) && Number.isSafeInteger(pid) && pid > 1 ? { paneId, pid } : undefined;
  }

  async killPaneExact(paneId: string): Promise<void> {
    const result = await this.commands.execute(killPaneArguments(paneId));
    if (result.code !== 0) throw new Error(result.stderr.trim() || 'tmux could not kill the pane');
  }

  async launch(launch: TmuxLaunch): Promise<void> {
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
    const result = await this.commands.execute(killSessionArguments(session));
    if (result.code !== 0) throw new Error(result.stderr.trim() || 'tmux could not stop the session');
  }
}
