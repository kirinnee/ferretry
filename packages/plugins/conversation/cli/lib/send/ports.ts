import type { SendRecord, SendRequest, SendResult } from '../../../contract/index.ts';

/** Ambient facts the shell may know: the ferret this `fy` runs inside. Unknown to a cli half unless `--session` names it. */
export interface SendEnvironment {
  readonly callerFerret?: string;
}

/** One uploaded attachment, as far as a send needs to know. */
export interface UploadedAttachment {
  readonly id: string;
}

/** The daemon calls `fy send` needs; the controller never sees a URL or a status code. */
export interface SendGateway {
  send(ferret: string, request: SendRequest): Promise<SendResult>;
  /**
   * The send's ledger row, or `undefined` while a message still in Ferretry's queue has none yet. With `waitMs` the DAEMON
   * holds the read open until the fate settles or that long has passed (the shell gives a plugin no clock to wait on).
   */
  sendStatus(ferret: string, sendId: string, waitMs?: number): Promise<SendRecord | undefined>;
  upload(ferret: string, file: string): Promise<UploadedAttachment>;
  /** Parks the calling ferret until the peer replies (Ferrets' `signal waiting`). */
  parkUntilReply(
    caller: string,
    options: { readonly peer: string; readonly until?: string; readonly condition: string },
  ): Promise<void>;
}

/** Reads a local file the caller named. The shell hands a verb no file access of its own, so a port says so. */
export interface SendFiles {
  readText(path: string): Promise<string>;
}

/** Presentation: results and answers on stdout, advisory notes on stderr. */
export interface ConversationOutput {
  out(line: string): void;
  note(line: string): void;
}
