import {
  capturePaneArguments,
  hasSessionArguments,
  killSessionArguments,
  listSessionsArguments,
  newSessionArguments,
  paneMetadataArguments,
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

  async stop(session: string): Promise<void> {
    if (!(await this.alive(session))) return;
    const result = await this.commands.execute(killSessionArguments(session));
    if (result.code !== 0) throw new Error(result.stderr.trim() || 'tmux could not stop the session');
  }
}
