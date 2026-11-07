import type { DaemonTransport, SocketListeners, TransportRequest } from '../../../src/client/transport.ts';

/**
 * The client-side witness (redesign §10.5): a decorator that delegates every member of the real sealed-session
 * transport and writes down what the app asked it to send. "Nothing was attempted" is the absence of a path here.
 *
 * It records the method and the path of a request, the path of a socket and the number of event streams opened.
 * It never records a body or a header.
 */
export class RecordingTransport implements DaemonTransport {
  readonly #requests: string[] = [];
  readonly #sockets: string[] = [];
  #eventOpens = 0;

  constructor(private readonly inner: DaemonTransport) {}

  /** `GET /v1/plugins`, in the order they were sent. */
  requests(): readonly string[] {
    return [...this.#requests];
  }

  /** The paths of the sockets the app opened. */
  sockets(): readonly string[] {
    return [...this.#sockets];
  }

  /** How many times the event stream was opened. */
  eventOpens(): number {
    return this.#eventOpens;
  }

  /** Every path the app sent anything to: requests and sockets. */
  paths(): readonly string[] {
    return [...this.#requests.map(line => line.slice(line.indexOf(' ') + 1)), ...this.#sockets];
  }

  reset(): void {
    this.#requests.length = 0;
    this.#sockets.length = 0;
    this.#eventOpens = 0;
  }

  request: DaemonTransport['request'] = request => {
    this.#requests.push(`${(request as TransportRequest).method} ${request.path}`);
    return this.inner.request(request);
  };

  events: DaemonTransport['events'] = (listener, onClose, onOpen) => {
    this.#eventOpens += 1;
    return this.inner.events(listener, onClose, onOpen);
  };

  socket = (path: string, listeners: SocketListeners): ReturnType<DaemonTransport['socket']> => {
    this.#sockets.push(path);
    return this.inner.socket(path, listeners);
  };

  onReconnect: DaemonTransport['onReconnect'] = listener => this.inner.onReconnect(listener);
}
