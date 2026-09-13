'use client';
// C03 acceptance shim: SshFilesPanel is rendered unmodified, but the
// workbench provider context is replaced with this minimal stand-in whose
// `request` proxies to the local bridge, which fronts the real desktop
// ssh-session module. This keeps the browser harness free of the full
// workbench provider (labeled as partial verification in the evidence).
import { createContext, useContext } from 'react';

export type WorkbenchShimValue = {
  request: (method: string, params?: unknown) => Promise<any>;
  t: (zh: string, en: string) => string;
  workspaceId?: string;
  workspaces: { id: string; title: string }[];
  connection?: string;
  theme?: string;
};

const WorkbenchContext = createContext<WorkbenchShimValue | null>(null);

export function useWorkbench(): WorkbenchShimValue {
  const value = useContext(WorkbenchContext);
  if (!value) throw new Error('workbench shim provider missing');
  return value;
}

export const errorText = (error: unknown) => {
  const e = error as { rpc?: { message?: string }; message?: string };
  return e?.rpc?.message || e?.message || String(error);
};

export function WorkbenchProvider({ value, children }: { value: WorkbenchShimValue; children: React.ReactNode }) {
  return <WorkbenchContext.Provider value={value}>{children}</WorkbenchContext.Provider>;
}
