/**
 * The columns every meter on a login shares — its 5h/Week quota bars and its spend budget bars — so the bars
 * start and end in the same place: a label column, the bar, and a words column of one fixed width (words
 * longer than it wrap inside it rather than shortening the bar).
 */
export const METER_LABEL = 'w-12 shrink-0 whitespace-nowrap text-muted';
export const METER_WORDS = 'w-48 shrink-0 text-right text-muted';
