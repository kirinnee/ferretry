/**
 * WHEN A REQUEST NEEDS A PASSKEY, ASK ONCE AND RETRY IT (`docs/design/zero-trust.md` B1).
 *
 * The daemon refuses an act that needs a step-up with `403 grant_step_up_required`. The router then
 * asks this gate, which shows ONE prompt — however many requests are waiting on that machine — and
 * resolves every one of them when the person has confirmed, so each is sent again exactly once. A
 * dismissed prompt resolves them `false`, and each request returns the daemon's refusal unchanged.
 *
 * THE CEREMONY STARTS ON A TAP, NEVER ON ITS OWN. Safari refuses WebAuthn without a user gesture, and a
 * passkey sheet nobody asked for is precisely the prompt a person must learn to refuse — so the gate
 * only opens a prompt; `confirm` (the button) runs the ceremony.
 *
 * A PROMPT COMES FROM THE MACHINE ON SCREEN. With two machines paired, every page reads both in the
 * background, so a locked second machine used to raise its prompt over the first machine's pages, named
 * by a host both share. A background request for any other machine now WAITS: it is listed by
 * `waitingDaemons()` — which the machine list shows as locked — and its prompt opens when that machine
 * comes on screen (`focus`). A request a person started (`explicit`) still asks wherever it came from.
 *
 * NOTHING HERE HOLDS A CREDENTIAL. A verified step-up is a fact the DAEMON remembers about this copy of
 * the app; the browser holds nothing it could lose, replay or leak.
 */

import { type StepUpAct, type StepUpOptionsRequest, stepUpSkippableAtMachine } from '@ferretry/protocol';
import type { DaemonConnection, DaemonId } from './daemon-connection.ts';
import { STEP_UP_FALLBACK_ACT } from './grants.ts';

/** The staged thing a bound passkey is for: a 2FA seed (`add-2fa-key`) or a task-plan selection (`approve-task-plan`). */
export type StepUpSubject = NonNullable<StepUpOptionsRequest['subject']>;

/** What the prompt shows: which machine is asking, which acts, and whether the last attempt failed and why. */
export interface StepUpPrompt {
  readonly daemon: DaemonConnection;
  /** The acts waiting on this machine, distinct and in the order they asked; never empty. */
  readonly acts: readonly string[];
  readonly busy: boolean;
  /** The confirmation is bound to one staged thing (a seed, a task-plan selection): it covers that and nothing else. */
  readonly bound?: true;
  /** One plain sentence for the person, or nothing. */
  readonly failure?: string;
  /** What this confirmation buys, once the machine has said; until then the prompt's own words stand. */
  readonly scope?: string;
  /**
   * This device has no passkey for the machine yet and may add its first one right now (its window is
   * open). The prompt then leads with setting one up, which its button does before it unlocks.
   */
  readonly firstPasskey?: boolean;
}

/**
 * Who started the request that needs a passkey: a person pressing something (`explicit`), or a page
 * reading in the background (`background`). Only the first may raise a prompt for a machine that is not
 * on screen.
 */
export type PromptOrigin = 'explicit' | 'background';

export interface StepUpGateDependencies {
  /** Runs the whole ceremony for one machine: options, the passkey sheet, and the daemon's verdict. */
  readonly ceremony: (daemon: DaemonConnection, act?: StepUpAct, subject?: StepUpSubject) => Promise<void>;
  /** The sentence a person is shown for a ceremony that failed. Never a raw exception. */
  readonly describe: (reason: unknown) => string;
  /**
   * What a confirmation on this machine buys, read ONCE when its prompt opens. A read that fails says
   * nothing: the prompt keeps the words it already has, and a confirmation never waits on it.
   */
  readonly scope?: (daemon: DaemonConnection) => Promise<string>;
  /**
   * Whether this device can only get in by adding its FIRST passkey, which it may do now. Read once when
   * the prompt opens, like {@link scope}; a read that fails says nothing.
   */
  readonly firstPasskey?: (daemon: DaemonConnection) => Promise<boolean>;
}

interface Waiting {
  readonly daemon: DaemonConnection;
  readonly acts: string[];
  readonly resolvers: ((stepped: boolean) => void)[];
  /** The ids of the acts the daemon named, and whether any waiting request named none. */
  readonly actIds: Set<StepUpAct>;
  /** The staged seeds waiting requests named (`add-2fa-key` is bound to one). */
  readonly subjects: Set<StepUpSubject>;
  unnamed: boolean;
  /** A person started at least one of these requests, so it may ask from off screen. */
  explicit: boolean;
}

const NOTHING_WAITING: readonly DaemonId[] = Object.freeze([]);

export class StepUpGate {
  readonly #listeners = new Set<() => void>();
  /** Machines with requests waiting, in the order they first asked. */
  readonly #waiting = new Map<DaemonId, Waiting>();
  #prompt: StepUpPrompt | null = null;
  /** The machine on screen, whose background requests may ask. `null` until the shell says. */
  #focus: DaemonId | null = null;
  #waitingIds: readonly DaemonId[] = NOTHING_WAITING;

  constructor(private readonly deps: StepUpGateDependencies) {}

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** The prompt on screen, or nothing. A stable object between changes, for `useSyncExternalStore`. */
  snapshot(): StepUpPrompt | null {
    return this.#prompt;
  }

  /**
   * Every machine with a request waiting on this gate, in the order it first asked — the machines the
   * list shows as locked. A stable array between changes, for `useSyncExternalStore`.
   */
  waitingDaemons(): readonly DaemonId[] {
    return this.#waitingIds;
  }

  /**
   * Waits for a step-up on this machine. `true` when the person confirmed and the daemon accepted it;
   * `false` when they dismissed the prompt.
   *
   * `act` is the phrase for what is being approved ("open a terminal"). Absent, the prompt says
   * {@link STEP_UP_FALLBACK_ACT} rather than leave a blank. Requests waiting on one machine share ONE
   * prompt, which names every distinct act in it.
   *
   * A `background` request for a machine that is not on screen raises nothing: it waits until that
   * machine is {@link focus}ed. Absent, the request is a person's own and asks wherever it came from.
   *
   * `subject` is the staged 2FA seed a save of it (`add-2fa-key`) is for: the passkey is bound to it, so the proof
   * can be spent on that one save and no other.
   */
  require(
    daemon: DaemonConnection,
    act: string = STEP_UP_FALLBACK_ACT,
    origin: PromptOrigin = 'explicit',
    actId?: StepUpAct,
    subject?: StepUpSubject,
  ): Promise<boolean> {
    return new Promise(resolve => {
      const explicit = origin === 'explicit';
      const waiting = this.#waiting.get(daemon.daemonId);
      if (waiting !== undefined) {
        waiting.resolvers.push(resolve);
        waiting.explicit ||= explicit;
        if (actId === undefined) waiting.unnamed = true;
        else waiting.actIds.add(actId);
        if (subject !== undefined) waiting.subjects.add(subject);
        if (!waiting.acts.includes(act)) {
          waiting.acts.push(act);
          this.#refreshActs(daemon.daemonId);
        }
        if (this.#prompt === null && this.#mayShow(waiting)) this.#show(waiting);
        return;
      }
      const entry: Waiting = {
        daemon,
        acts: [act],
        resolvers: [resolve],
        actIds: new Set(actId === undefined ? [] : [actId]),
        subjects: new Set(subject === undefined ? [] : [subject]),
        unnamed: actId === undefined,
        explicit,
      };
      this.#waiting.set(daemon.daemonId, entry);
      if (this.#prompt === null && this.#mayShow(entry)) this.#show(entry);
      else this.#set(this.#prompt);
    });
  }

  /**
   * The machine now on screen, or `null` for a page that shows none. Its waiting background requests
   * open their prompt; a background prompt for the machine just left goes back to waiting, unless the
   * person is already answering it.
   */
  focus(daemonId: DaemonId | null): void {
    if (daemonId === this.#focus) return;
    this.#focus = daemonId;
    const prompt = this.#prompt;
    const shown = prompt === null ? undefined : this.#waiting.get(prompt.daemon.daemonId);
    if (prompt !== null && !prompt.busy && shown !== undefined && !this.#mayShow(shown)) this.#prompt = null;
    if (this.#prompt === null) this.#showNext();
  }

  /** The prompt's button: runs the ceremony for the machine on screen. */
  async confirm(): Promise<void> {
    const prompt = this.#prompt;
    if (prompt === null || prompt.busy) return;
    const { failure: _cleared, ...kept } = prompt;
    this.#set({ ...kept, busy: true });
    try {
      const proof = this.#soleProof(prompt.daemon.daemonId);
      await this.deps.ceremony(prompt.daemon, proof?.act, proof?.subject);
    } catch (reason) {
      this.#set({ ...kept, busy: false, failure: this.deps.describe(reason) });
      return;
    }
    this.#settle(prompt.daemon.daemonId, true);
  }

  /** The prompt's cancel: every request waiting on this machine returns its refusal. */
  dismiss(): void {
    const prompt = this.#prompt;
    if (prompt === null || prompt.busy) return;
    this.#settle(prompt.daemon.daemonId, false);
  }

  /**
   * The ONE act this confirmation is for (and, for a save of a staged 2FA seed, the ONE stage), or nothing. A prompt
   * that several different acts share proves none of them in particular, so the proof is unstamped and an act that
   * wants its own asks again. An act bound to a subject is stamped only with exactly one subject: a request that
   * named none (the router's answer to a refusal) or two different ones is left unstamped, which the save refuses.
   */
  #soleProof(daemonId: DaemonId): { readonly act: StepUpAct; readonly subject?: StepUpSubject } | undefined {
    const waiting = this.#waiting.get(daemonId);
    if (waiting === undefined || waiting.unnamed || waiting.actIds.size !== 1) return undefined;
    const act = [...waiting.actIds][0];
    if (act === undefined) return undefined;
    if (stepUpSkippableAtMachine(act)) return { act };
    const subject = waiting.subjects.size === 1 ? [...waiting.subjects][0] : undefined;
    return subject === undefined ? undefined : { act, subject };
  }

  #mayShow(waiting: Waiting): boolean {
    return waiting.explicit || waiting.daemon.daemonId === this.#focus;
  }

  #settle(daemonId: DaemonId, stepped: boolean): void {
    const waiting = this.#waiting.get(daemonId);
    this.#waiting.delete(daemonId);
    for (const resolve of waiting?.resolvers ?? []) resolve(stepped);
    this.#prompt = null;
    this.#showNext();
  }

  /** The first waiting machine allowed to ask, or nothing on screen. */
  #showNext(): void {
    for (const waiting of this.#waiting.values())
      if (this.#mayShow(waiting)) {
        this.#show(waiting);
        return;
      }
    this.#set(null);
  }

  #show(waiting: Waiting): void {
    this.#set({
      daemon: waiting.daemon,
      acts: [...waiting.acts],
      busy: false,
      ...(waiting.subjects.size > 0 ? { bound: true as const } : {}),
    });
    const read = this.deps.scope;
    if (read !== undefined)
      void read(waiting.daemon).then(
        scope => this.#adopt(waiting, { scope }),
        () => undefined,
      );
    const first = this.deps.firstPasskey;
    if (first !== undefined)
      void first(waiting.daemon).then(
        firstPasskey => this.#adopt(waiting, { firstPasskey }),
        () => undefined,
      );
  }

  /** What the machine said about this prompt, if its prompt is still the one on screen. */
  #adopt(waiting: Waiting, said: Pick<StepUpPrompt, 'scope' | 'firstPasskey'>): void {
    const prompt = this.#prompt;
    if (prompt?.daemon.daemonId !== waiting.daemon.daemonId || this.#waiting.get(waiting.daemon.daemonId) !== waiting)
      return;
    this.#set({ ...prompt, ...said });
  }

  /** A later request on the machine already on screen adds its act to the one prompt, keeping its state. */
  #refreshActs(daemonId: DaemonId): void {
    const prompt = this.#prompt;
    if (prompt === null || prompt.daemon.daemonId !== daemonId) return;
    const waiting = this.#waiting.get(daemonId);
    this.#set({
      ...prompt,
      acts: [...(waiting?.acts ?? [])],
      ...(waiting !== undefined && waiting.subjects.size > 0 ? { bound: true as const } : {}),
    });
  }

  #set(prompt: StepUpPrompt | null): void {
    this.#prompt = prompt;
    const ids = [...this.#waiting.keys()];
    if (ids.length !== this.#waitingIds.length || ids.some((id, index) => id !== this.#waitingIds[index]))
      this.#waitingIds = ids.length === 0 ? NOTHING_WAITING : Object.freeze(ids);
    for (const listener of this.#listeners) listener();
  }
}
