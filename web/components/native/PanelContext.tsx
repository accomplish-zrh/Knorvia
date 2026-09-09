"use client";

import { createContext, useContext } from 'react';
import type { PanelTarget } from '@/lib/native-panel';

export const PanelContext = createContext<{ open: (target: PanelTarget) => void; cwd: string; folder?: string } | null>(null);
export const usePanel = () => useContext(PanelContext);
