import type { AttachTarget } from '../protocol/attach-target.ts';

/** The host act behind `fy attach`, kept behind a port because it hands this terminal to tmux. Answers the exit code. */
export interface ITerminalAttacher {
  attach(target: AttachTarget): Promise<number>;
}

/** The attach proof failed, or this host cannot attach: said to the person, exit 1. */
export class AttachError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AttachError';
  }
}
