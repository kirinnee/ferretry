/**
 * The folder of the instruction items. They are `config/instructions/<name>.yaml` (a `text:` document, Runtimes' `INSTRUCTION_ITEMS`),
 * never `<name>.md`; listed here for ownership only, and nothing in 5.0 reads a `.md` there.
 */
export const INSTRUCTION_ITEMS_FOLDER = 'instructions' as const;
