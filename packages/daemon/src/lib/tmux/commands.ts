import { sessionTarget, TmuxAddressError } from './address.ts';
import type { TmuxLaunch } from './contracts.ts';

export const paneMetadataFormat =
  '#{pane_dead}|#{pane_dead_status}|#{cursor_x}|#{cursor_y}|#{pane_height}|#{pane_width}';

export function hasSessionArguments(session: string): readonly string[] {
  return ['has-session', '-t', sessionTarget(session)];
}

export function listSessionsArguments(): readonly string[] {
  return ['list-sessions', '-F', '#{session_name}'];
}

export function capturePaneArguments(session: string, history: boolean): readonly string[] {
  return history
    ? ['capture-pane', '-p', '-S', '-', '-t', sessionTarget(session)]
    : ['capture-pane', '-p', '-t', sessionTarget(session)];
}

export function paneMetadataArguments(session: string): readonly string[] {
  return ['display-message', '-p', '-t', sessionTarget(session), paneMetadataFormat];
}

export function sendLiteralArguments(session: string, text: string): readonly string[] {
  if (text.length === 0) throw new TmuxAddressError('literal text must not be empty');
  return ['send-keys', '-t', sessionTarget(session), '-l', text];
}

export function sendKeyArguments(session: string, key: string): readonly string[] {
  if (!/^[A-Za-z0-9+_-]+$/.test(key)) throw new TmuxAddressError('key must be a tmux key name');
  return ['send-keys', '-t', sessionTarget(session), key];
}

export function newSessionArguments(launch: TmuxLaunch): readonly string[] {
  const args = ['new-session', '-d', '-s', sessionTarget(launch.session), '-c', launch.cwd];
  if (launch.width !== undefined) args.push('-x', String(launch.width));
  if (launch.height !== undefined) args.push('-y', String(launch.height));
  return [...args, ...launch.command];
}

export function remainOnExitArguments(session: string): readonly string[] {
  return ['set-option', '-t', sessionTarget(session), 'remain-on-exit', 'on'];
}

export function killSessionArguments(session: string): readonly string[] {
  return ['kill-session', '-t', sessionTarget(session)];
}
