import type { SendMessageRequest } from '../delivery/service.ts';
import { QueueingSends, type QueueingSendsPorts } from './queueing-sends.ts';

/** Who is speaking, as the send path flags it: at most one daemon producer, or none (an owner or a ferret). */
export interface SenderFlags {
  /** The Warden is speaking. */
  readonly warden?: true | undefined;
  /** Agenda's turn-end check is speaking. */
  readonly agenda?: true | undefined;
  /** The daemon's own failed-send notice. */
  readonly notice?: true | undefined;
  /** The session monitor is waking a ferret whose declared wait ended. */
  readonly monitor?: true | undefined;
  /** An agent's credential that names no ferret: the daemon's, never a person's. */
  readonly unnamedAgent: boolean;
}

/**
 * THE SIX WAYS A MESSAGE GETS INTO THE QUEUE, one {@link QueueingSends} per producer, so each is told apart by its sender
 * chip (Ferretry · Warden, Agenda, Delivery, Monitor) and a message to a ferret the owner is chatting with keeps the direct
 * path it always took. The Warden, Agenda, the daemon's notices and the monitor's wake are the daemon's own; an owner's
 * message is a person's.
 */
export class Senders {
  private readonly owner: QueueingSends;
  private readonly warden: QueueingSends;
  private readonly agenda: QueueingSends;
  private readonly notice: QueueingSends;
  private readonly monitor: QueueingSends;
  /**
   * An agent's credential that names no ferret (the Warden's or Agenda's token over the route, which carries no flag): it is
   * the daemon's, never a person's, so it never takes the owner's lane.
   */
  private readonly unnamed: QueueingSends;

  constructor(ports: QueueingSendsPorts) {
    this.owner = new QueueingSends(ports, 'human');
    this.warden = new QueueingSends(ports, 'daemon', 'Warden');
    this.agenda = new QueueingSends(ports, 'daemon', 'Agenda');
    this.notice = new QueueingSends(ports, 'daemon', 'Delivery');
    this.monitor = new QueueingSends(ports, 'daemon', 'Monitor');
    this.unnamed = new QueueingSends(ports, 'daemon');
  }

  /** The producer a request is from, by the flag it carries; no flag and a named sender is the owner's. */
  pick(flags: SenderFlags): { send(request: SendMessageRequest): ReturnType<QueueingSends['send']> } {
    if (flags.warden === true) return this.warden;
    if (flags.agenda === true) return this.agenda;
    if (flags.monitor === true) return this.monitor;
    if (flags.notice === true) return this.notice;
    return flags.unnamedAgent ? this.unnamed : this.owner;
  }
}
