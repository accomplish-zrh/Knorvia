export type SshHost = { id: string; revision: number; name: string; hostname: string; port: number; username: string; root: string; auth: 'agent' | 'password' | 'privateKey'; keyPath: string; fingerprint?: string; hasSecret?: boolean };
export type SshChallenge = { hostId: string; revision: number; fingerprint: string; previousFingerprint?: string; expiresAt: number };
export type SshSession = { sessionId: string; hostId: string; name: string; hostname: string; cwd: string; status: 'connecting' | 'ready' | 'failed' | 'closed' | 'disconnected' | 'exited'; cols: number; rows: number; inputSeq: number; exitCode: number | null; error: string };
export type SshRead = SshSession & { data: string; cursor: number; truncated: boolean; hasMore: boolean };
