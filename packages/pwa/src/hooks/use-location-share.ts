/**
 * The one-shot location reader the entry point created (`main.tsx`). `null` where none was provided
 * — a test, the component harness, a page mounted without one — and the composer then offers no
 * "Share my location" action at all rather than one that cannot work.
 */

import { createContext, useContext } from 'react';
import type { LocationShareHost } from '../lib/location-share.ts';

export const LocationShareContext = createContext<LocationShareHost | null>(null);

export const useLocationShareHost = (): LocationShareHost | null => useContext(LocationShareContext);
