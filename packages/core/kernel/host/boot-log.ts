/**
 * The boot log: a line goes to `append` only once the home is decided and open. Before that the home may be someone
 * else's — a Ferretry 4 home already has a `logs/fyd.log` — and a refused boot writes nothing into it (§9.3).
 */
export interface BootLog {
  /** The line sink: drops every line until `open()`. */
  readonly append: (line: string) => void;
  /** The home was opened for this daemon; lines are written from here on. */
  open(): void;
}

export function bootLog(write: (line: string) => void): BootLog {
  let opened = false;
  return {
    append: line => {
      if (opened) write(line);
    },
    open: () => {
      opened = true;
    },
  };
}
