/**
 * THE CHAT THE READER CAME FROM, for the Board page.
 *
 * The shell remembers the last session page it showed and provides it here, so opening the Board from a
 * chat starts on that ferret's cards instead of every card on every machine. It is a provided value, not a
 * store: the shell owns the fact, the Board page only reads it.
 */

import { createContext, useContext } from 'react';
import type { FerretScope } from '../lib/machine.ts';

const BoardOriginContext = createContext<FerretScope | null>(null);

export const BoardOriginProvider = BoardOriginContext.Provider;

export const useBoardOrigin = (): FerretScope | null => useContext(BoardOriginContext);
