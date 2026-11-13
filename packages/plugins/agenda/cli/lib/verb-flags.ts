import type { VerbInvocation } from '@ferretry/kernel/manifest';
import type {
  AgendaAddOptions,
  AgendaEditOptions,
  AgendaLogOptions,
  AgendaPatchOptions,
  AgendaResolveOptions,
  AgendaRestOptions,
  AgendaSnoozeOptions,
  AgendaSplitOptions,
  AgendaStepOptions,
  AgendaSurfaceOptions,
} from './controller.ts';

/** Every flag any item verb reads, as the controller's options name them: a verb reads only the ones it knows. */
export type Flags = AgendaAddOptions &
  AgendaEditOptions &
  AgendaSplitOptions &
  AgendaResolveOptions &
  AgendaSnoozeOptions &
  AgendaSurfaceOptions &
  AgendaLogOptions &
  AgendaRestOptions &
  AgendaPatchOptions &
  AgendaStepOptions;

/**
 * Every flag any `fy agenda` item verb takes, once: the camelCase name the controller's options use, the long flag, the
 * short one v4 spelled, and whether it is a word, a repeated word, or a switch. One table, so a flag means the same on
 * every verb that takes it (`--why` on add, rest and surface; `--now` on edit, patch and surface).
 *
 * The shell's argument reader cannot know which flag takes a value, so a switch followed by a word reads the word as
 * its value (`agenda add --todo "do it"`). A switch given a word here is on, and the word goes back to the positionals.
 */
type Kind = 'text' | 'list' | 'switch';
interface Flag {
  readonly name: string;
  readonly long: string;
  readonly short?: string;
  readonly kind: Kind;
}

const text = (name: string, long: string, short?: string): Flag => ({
  name,
  long,
  kind: 'text',
  ...(short === undefined ? {} : { short }),
});
const list = (name: string, long: string, short?: string): Flag => ({
  name,
  long,
  kind: 'list',
  ...(short === undefined ? {} : { short }),
});
const on = (name: string, long: string): Flag => ({ name, long, kind: 'switch' });

const FLAGS: readonly Flag[] = [
  text('title', 'title', 't'),
  text('ask', 'ask'),
  text('summary', 'summary'),
  text('kind', 'kind', 'k'),
  text('up', 'up'),
  text('upWhy', 'up-why'),
  text('task', 'task'),
  text('related', 'related'),
  text('new', 'new'),
  text('why', 'why', 'w'),
  text('resolve', 'resolve', 'r'),
  text('recommend', 'recommend'),
  text('recommendWhy', 'recommend-why'),
  text('urgency', 'urgency'),
  text('willBlock', 'will-block'),
  text('by', 'by'),
  text('confirms', 'confirms'),
  text('stage', 'stage'),
  text('detail', 'detail'),
  text('bodyFile', 'body-file'),
  text('whereFile', 'where-file'),
  text('jsonFile', 'json-file'),
  text('questionAnswer', 'question-answer'),
  text('moveCards', 'move-cards'),
  text('reply', 'reply'),
  text('rest', 'rest'),
  text('message', 'message'),
  text('note', 'note', 'n'),
  text('reason', 'reason'),
  text('choice', 'choice'),
  text('clarify', 'clarify'),
  text('answer', 'answer'),
  text('other', 'other'),
  text('for', 'for'),
  text('until', 'until'),
  text('file', 'file', 'f'),
  text('tab', 'tab'),
  list('option', 'option', 'o'),
  list('optionDetail', 'option-detail'),
  list('field', 'field'),
  list('premise', 'premise'),
  list('context', 'context', 'c'),
  list('decided', 'decided'),
  list('stillOpen', 'still-open'),
  list('term', 'term'),
  list('question', 'question', 'q'),
  list('impact', 'impact'),
  list('link', 'link', 'l'),
  list('step', 'step'),
  list('where', 'where'),
  list('tabFile', 'tab-file'),
  list('renameTab', 'rename-tab'),
  list('moveTab', 'move-tab'),
  list('removeTab', 'remove-tab'),
  on('json', 'json'),
  on('offerClose', 'offer-close'),
  on('todo', 'todo'),
  on('blocking', 'blocking'),
  on('notBlocking', 'not-blocking'),
  on('clearWillBlock', 'clear-will-block'),
  on('clearBy', 'clear-by'),
  on('clearQuestionAnswer', 'clear-question-answer'),
  on('now', 'now'),
  on('undo', 'undo'),
  on('yaml', 'yaml'),
  on('approve', 'approve'),
  on('reject', 'reject'),
  on('yes', 'yes'),
  on('no', 'no'),
  on('good', 'good'),
];

const asList = (value: string | boolean | readonly string[]): string[] =>
  typeof value === 'string' ? [value] : Array.isArray(value) ? [...value] : [];

/** The flags an item verb was given, as the controller's options; and the positionals, with any word a switch swallowed. */
export function readFlags(invocation: VerbInvocation): {
  readonly flags: Flags;
  readonly args: readonly string[];
} {
  const flags: Record<string, string | boolean | readonly string[]> = {};
  const swallowed: string[] = [];
  for (const flag of FLAGS) {
    const given = [
      invocation.options[flag.long],
      flag.short === undefined ? undefined : invocation.options[flag.short],
    ];
    const present = given.filter((value): value is string | boolean | readonly string[] => value !== undefined);
    if (present.length === 0) continue;
    if (flag.kind === 'switch') {
      const value = present[present.length - 1] as string | boolean | readonly string[];
      if (value === false || value === 'false') continue;
      flags[flag.name] = true;
      if (typeof value === 'string' && value !== 'true') swallowed.push(value);
      else if (Array.isArray(value)) swallowed.push(...(value as readonly string[]).filter(word => word !== 'true'));
    } else if (flag.kind === 'list') flags[flag.name] = present.flatMap(asList);
    else {
      const last = present[present.length - 1] as string | boolean | readonly string[];
      const value = asList(last).pop();
      if (value !== undefined) flags[flag.name] = value;
    }
  }
  // `--session`, `-s` and `--ferret` all name the board to act on.
  const board = [invocation.options.session, invocation.options.s, invocation.options.ferret]
    .flatMap(value => (value === undefined ? [] : asList(value)))
    .filter(value => value.trim() !== '');
  const [session] = board.slice(-1);
  if (session !== undefined) flags.session = session;
  return { flags: flags as unknown as Flags, args: [...swallowed, ...invocation.args] };
}
