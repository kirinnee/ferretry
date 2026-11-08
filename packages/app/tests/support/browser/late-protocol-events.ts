/**
 * A PROTOCOL EVENT THAT ARRIVES FOR A TARGET THE CLIENT HAS ALREADY DROPPED IS NOT A TEST FAILURE.
 *
 * WHAT WAS MEASURED. The "Integration Tests (everything-else)" job died after every test had passed,
 * with `Unhandled error between tests` / `Cannot find object to "previewUpdated": handle@…` and
 * `Cannot find object to "loadstate": frame@…`. Playwright (in-process, as Bun runs it) hands each
 * server message to the client as `setImmediate(() => clientConnection.dispatch(message))`, and
 * `Connection.dispatch` THROWS when an event names a guid whose object was disposed a moment earlier —
 * a page closing while its handle's preview, or its frame's load state, is still in flight.
 *
 * WHY NOTHING IN A TEST CAN CATCH IT. The throw is inside a bare `setImmediate` callback: there is no
 * promise to await, no `try` around it, and Bun's runner reports it as an uncaught error even when a
 * `process.on('uncaughtException')` listener swallows it (measured on Bun 1.4.4). Waiting for
 * navigation before `page.close()` shortens the window but cannot close it, because the server's own
 * events are not ordered against the client's close. The only seam is `Connection.dispatch` itself.
 *
 * WHAT IS SWALLOWED, and nothing wider. An EVENT (no command `id`) whose object is gone, whose guid this
 * connection DID create earlier, and whose error is exactly Playwright's `Cannot find object to "<event>":
 * <guid>`. A guid this connection never created is a real protocol bug and still throws, and so does every
 * other error `dispatch` raises, and so does a late reply to a command (that rejects its awaiting caller
 * with `TargetClosedError`, which is the correct place for a test to see a page closed under it).
 */

interface WireMessage {
  readonly id?: number;
  readonly guid?: string;
  readonly method?: string;
  readonly params?: Readonly<Record<string, unknown>>;
}

export interface ClientConnection {
  dispatch(message: WireMessage): void;
  readonly _objects: ReadonlyMap<string, unknown>;
}

const LATE_EVENT = /^Cannot find object to "[A-Za-z]+": [A-Za-z]+@[0-9a-f]+$/u;

/** True for exactly the error `Connection.dispatch` throws for an event addressed to a dropped object. */
export const isLateEventError = (error: unknown): boolean => error instanceof Error && LATE_EVENT.test(error.message);

const guarded = new WeakSet<object>();

/**
 * Makes `connection.dispatch` ignore late events for targets it created and has since dropped. Idempotent:
 * a connection is wrapped once, however many callers launch through it.
 */
export const ignoreLateProtocolEvents = (connection: ClientConnection): void => {
  if (guarded.has(connection)) return;
  guarded.add(connection);

  const created = new Set<string>();
  const dispatch = connection.dispatch.bind(connection);
  connection.dispatch = message => {
    if (message.method === '__create__' && typeof message.params?.guid === 'string') created.add(message.params.guid);
    try {
      dispatch(message);
    } catch (error) {
      const late =
        message.id === undefined &&
        message.guid !== undefined &&
        created.has(message.guid) &&
        !connection._objects.has(message.guid) &&
        isLateEventError(error);
      if (!late) throw error;
    }
  };
};
