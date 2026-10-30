import type {
  IFyApiClient,
  SendRequest,
  SignalKind,
  SignalOptions,
  StartSessionRequestInput,
} from '@ferretry/protocol';
import type { ISessionApi } from '../../lib/session/ports.ts';

/** Opens a connection to the daemon. Called at most once, on the first command that needs it. */
export type FyClientConnector = () => Promise<IFyApiClient>;

/**
 * The daemon side of the session commands, over the protocol client.
 *
 * The connector is lazy and memoised: `fy --help` must not demand a token, and a single command
 * never opens two connections. Every method is a straight delegation — the decisions live in
 * `src/lib/session`, and this class exists so they can be tested without a daemon.
 */
export class FySessionApi implements ISessionApi {
  #client: Promise<IFyApiClient> | undefined;

  constructor(private readonly connector: FyClientConnector) {}

  private client(): Promise<IFyApiClient> {
    this.#client ??= this.connector();
    return this.#client;
  }

  async list(): ReturnType<ISessionApi['list']> {
    return (await this.client()).list();
  }

  async get(id: string): ReturnType<ISessionApi['get']> {
    return (await this.client()).get(id);
  }

  async suggestNames(count: number): ReturnType<ISessionApi['suggestNames']> {
    return (await this.client()).suggestNames(count);
  }

  async start(input: StartSessionRequestInput, requestId?: string): ReturnType<ISessionApi['start']> {
    return (await this.client()).start(input, requestId);
  }

  async send(id: string, input: SendRequest): ReturnType<ISessionApi['send']> {
    return (await this.client()).send(id, input);
  }

  async sendStatus(id: string, sendId: string): ReturnType<ISessionApi['sendStatus']> {
    return (await this.client()).sendStatus(id, sendId);
  }

  async answer(
    id: string,
    toolUseId: string,
    labels: string[],
    other?: string,
    responses?: string[],
  ): ReturnType<ISessionApi['answer']> {
    return (await this.client()).answer(id, toolUseId, labels, other, responses);
  }

  async interrupt(id: string): ReturnType<ISessionApi['interrupt']> {
    return (await this.client()).interrupt(id);
  }

  async resume(id: string, message?: string): ReturnType<ISessionApi['resume']> {
    return (await this.client()).resume(id, message);
  }

  async rename(id: string, name?: string, teammate?: string): ReturnType<ISessionApi['rename']> {
    return (await this.client()).rename(id, name, teammate);
  }

  async signal(
    id: string,
    kind: SignalKind,
    message?: string,
    options?: SignalOptions,
  ): ReturnType<ISessionApi['signal']> {
    return (await this.client()).signal(id, kind, message, options);
  }

  async upload(id: string, file: string): ReturnType<ISessionApi['upload']> {
    return (await this.client()).upload(id, file);
  }
}
