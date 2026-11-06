/** Push notifications (`push.*`). One fragment of `DAEMON_FEATURES`; `index.ts` spreads them all. */
export const PUSH_FEATURES = {
  /**
   * Handled agenda alerts come down on every device (docs/notifications.md § When an alert is cleared): the daemon sends
   * `kind: 'clear'` pushes, and `POST /v1/push/seen` takes an item the owner opened down on their other devices. A
   * daemon without this name answers 404 there, so the app says an item was opened only where the machine reports it.
   */
  pushClear: 'push.clear.1',
} as const;
