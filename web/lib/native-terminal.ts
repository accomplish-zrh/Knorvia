export type TerminalSession = {
  sessionId: string; threadId: string; cwd: string; shell: string; pid: number;
  status: 'running' | 'closing' | 'exited'; exitCode: number | null;
  cols: number; rows: number; inputSeq: number; platform: string; windowsBuild: number;
};
export type TerminalRead = TerminalSession & { data: string; cursor: number; truncated: boolean; hasMore: boolean };
