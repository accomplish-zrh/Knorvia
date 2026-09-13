import { createContext, useContext, useEffect, useState } from 'react';

const Context = createContext<any>(null);
const pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }[]>();
export const history = { routes: [] as string[], workspaces: [] as string[], reads: [] as string[], errors: [] as string[] };
let update: ((value: any) => void) | null = null;
let stateValue: any;
const readThread = (id: string) => {
  history.reads.push(id);
  return new Promise((resolve, reject) => { const queue = pending.get(id) || []; queue.push({ resolve, reject }); pending.set(id, queue); });
};
const setWorkspaceId = (id: string) => { history.workspaces.push(id); update?.((state: any) => ({ ...state, workspaceId: id })); };
const setError = (error: string) => { history.errors.push(error); update?.((state: any) => ({ ...state, error })); };
const router = { push(route: string) { history.routes.push(route); update?.((state: any) => ({ ...state, pathname: route })); } };

export function FixtureProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState({ pathname: '/workbench', workspaceId: 'workspace-home', error: '', threads: [] });
  update = setState; stateValue = state;
  useEffect(() => () => { update = null; }, []);
  return <Context.Provider value={{ ...state, router, t: (_zh: string, en: string) => en, locale: 'en', connection: 'connected', errorKind: 'generic', notice: '', recovery: null, setError, setWorkspaceId, readThread, setNotice() {}, toggleLocale() {}, reconnect: async () => {}, clearRecovery() {} }}>{children}</Context.Provider>;
}
export const useWorkbench = () => useContext(Context);
export const errorText = (error: unknown) => String(error);
export const usePathname = () => useContext(Context).pathname;
export const useRouter = () => useContext(Context).router;
export const fixture = {
  history,
  resolve(id: string, workspaceId = `workspace-${id}`, overrides = {}) {
    const request = pending.get(id)?.shift();
    if (!request) throw new Error(`No pending read for ${id}`);
    request.resolve({ id, workspaceId, title: id, status: 'active', items: [], turns: [], pendingApprovals: [], activeTurn: null, ...overrides });
  },
  reject(id: string) { const request = pending.get(id)?.shift(); if (!request) throw new Error(`No pending read for ${id}`); request.reject(new Error('Task deleted')); },
  navigate(pathname: string) { update?.((state: any) => ({ ...state, pathname })); },
  rerender() { update?.((state: any) => ({ ...state, threads: [...state.threads] })); },
  setCached(id: string) { update?.((state: any) => ({ ...state, threads: [{ id, workspaceId: 'old-project', title: id, status: 'active' }] })); },
  state() { return stateValue; },
};
