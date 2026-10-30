import {
  AGENDA_SCHEMA_VERSION,
  type AgendaItem,
  type AgendaResponse,
  type BoardResult,
  type BoardTaskView,
  boardErr,
  boardOk,
  type LaneSet,
} from '@ferretry/protocol';
import { DaemonAgendaStore } from '../../../src/lib/agenda-store.ts';
import type { BoardActions } from '../../../src/lib/board-actions.ts';
import { DaemonBoardStore } from '../../../src/lib/board-store.ts';
import { daemonSessionScope } from '../../../src/lib/daemon-scope.ts';
import type { BoardAgenda, BoardDetailProps } from '../../../src/features/board/detail/board-detail.tsx';
import { interact, must } from '../../support/dom.ts';
import { card, fakeEnvironment, fakePort, laneSetFor, laptop } from '../board-support.ts';

export const NOW = Date.parse('2026-08-01T10:04:00.000Z');
export const LEAD = 'mvuc7tsf-0c3d50df';
export const HELPER = 'mvudnuly-ec442385';

export const names = (sessionId: string): string => (sessionId === LEAD ? 'Denisha' : sessionId.slice(0, 6));

export const refusal = (message: string, boardCode: 'owner-gate' | null = null) =>
  boardErr({ status: 409, message, boardCode });

type Mutation = BoardResult<BoardTaskView, { status: number; message: string; boardCode: 'owner-gate' | null }>;

/** Every board verb recorded as `verb:json`; each answers its override, or the card as it was. */
export const fakeActions = (
  overrides: Partial<Record<keyof BoardActions, (...args: never[]) => Promise<unknown>>> = {},
): BoardActions & { readonly calls: string[] } => {
  const calls: string[] = [];
  const done = async (): Promise<Mutation> => boardOk(card('F1'));
  const verb =
    (name: keyof BoardActions) =>
    async (...args: unknown[]) => {
      calls.push(`${name}:${JSON.stringify(args.slice(1))}`);
      const custom = overrides[name];
      return custom === undefined ? await done() : await (custom as (...rest: unknown[]) => Promise<unknown>)(...args);
    };
  const actions = {
    moveTask: verb('moveTask'),
    reopen: verb('reopen'),
    depend: verb('depend'),
    undepend: verb('undepend'),
    note: verb('note'),
    link: verb('link'),
    drop: verb('drop'),
    reparent: verb('reparent'),
    editField: verb('editField'),
    create: verb('create'),
    answer: async (...args: unknown[]) => {
      calls.push(`answer:${JSON.stringify(args.slice(1))}`);
      const custom = overrides.answer;
      return custom === undefined
        ? boardOk(undefined)
        : await (custom as (...rest: unknown[]) => Promise<unknown>)(...args);
    },
  } as unknown as BoardActions;
  return Object.assign(actions, { calls });
};

const machine = { connection: laptop, name: 'laptop' };

export interface DetailHarness {
  readonly props: BoardDetailProps;
  readonly actions: ReturnType<typeof fakeActions>;
  readonly agendaStore: DaemonAgendaStore;
  readonly closed: { count: number };
  readonly navigated: string[];
  readonly sent: { sessionId: string; message: string }[];
  readonly responses: AgendaResponse[];
}

export interface DetailOptions {
  readonly task?: BoardTaskView | null;
  readonly laneSet?: LaneSet | null;
  readonly taskId?: string;
  readonly actions?: ReturnType<typeof fakeActions>;
  readonly phone?: boolean;
  readonly siblings?: BoardDetailProps['siblings'];
  readonly sendMessage?: (sessionId: string, message: string) => Promise<void>;
  readonly readFails?: boolean;
  readonly hold?: boolean;
  readonly agendaItems?: readonly AgendaItem[];
}

/** A detail wired to a real board store over a fake port and a real agenda store. */
export const detailProps = (options: DetailOptions = {}): DetailHarness => {
  const task = options.task === undefined ? card('F1', { laneId: 'implement' }) : options.task;
  const laneSet = options.laneSet === undefined ? laneSetFor() : options.laneSet;
  const port = fakePort({
    task: async () => {
      if (options.hold === true) return await new Promise(() => undefined);
      if (options.readFails === true) throw new Error('the machine is down');
      return task === null ? null : { task, laneSet };
    },
  });
  const store = new DaemonBoardStore(port, fakeEnvironment());
  const agendaStore = new DaemonAgendaStore();
  const responses: AgendaResponse[] = [];
  const agenda: BoardAgenda = {
    hydrate: async () => undefined,
    respond: (async (_daemon: unknown, _scope: unknown, _id: string, response: AgendaResponse) => {
      responses.push(response);
    }) as unknown as BoardAgenda['respond'],
    store: agendaStore,
  };
  if (options.agendaItems !== undefined) {
    const ok = agendaStore.applySnapshot(daemonSessionScope(laptop, LEAD), {
      v: AGENDA_SCHEMA_VERSION,
      sessionId: LEAD,
      items: options.agendaItems,
      resolved: [],
      count: options.agendaItems.length,
      parseErrors: 0,
      updatedAt: '2026-08-01T10:00:00.000Z',
    });
    if (!ok) throw new Error('the agenda fixture did not parse');
  }
  const actions = options.actions ?? fakeActions();
  const closed = { count: 0 };
  const navigated: string[] = [];
  const sent: DetailHarness['sent'] = [];
  const props: BoardDetailProps = {
    store,
    agenda,
    actions,
    machine,
    taskId: options.taskId ?? 'F1',
    names,
    now: NOW,
    projectName: () => 'ferretry',
    siblings: options.siblings ?? [],
    ports: {
      sendMessage: async (_daemon, sessionId, message) => {
        sent.push({ sessionId, message });
        await options.sendMessage?.(sessionId, message);
      },
    },
    phone: options.phone ?? false,
    onClose: () => {
      closed.count += 1;
    },
    onNavigate: to => void navigated.push(to),
  };
  return { props, actions, agendaStore, closed, navigated, sent, responses };
};

export const click = (root: ParentNode, selector: string) =>
  interact(() => must(root.querySelector<HTMLElement>(selector), selector).click());

export const buttonNamed = (root: ParentNode, label: string): HTMLButtonElement =>
  must(
    [...root.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.includes(label)),
    `the "${label}" button`,
  );

export const clickNamed = (root: ParentNode, label: string) => interact(() => buttonNamed(root, label).click());

type Field = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;

export const fill = async (field: Field, value: string): Promise<void> => {
  const prototype =
    field instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : field instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(field, value);
  const type = field instanceof HTMLSelectElement ? 'change' : 'input';
  await interact(() => field.dispatchEvent(new Event(type, { bubbles: true })));
};

export const fillLabelled = (root: ParentNode, label: string, value: string) =>
  fill(must(root.querySelector<Field>(`[aria-label="${label}"]`), label), value);

export const submit = (form: Element) =>
  interact(() => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));

export const text = (root: ParentNode, selector: string): string | undefined =>
  root.querySelector(selector)?.textContent ?? undefined;
