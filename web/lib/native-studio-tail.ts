import type { StudioFrameExport } from "./native-studio";

/**
 * Cancellable last-frame export runner (C17 flow; reworked per 03:01 review).
 *
 * A cancel REQUEST and a host-CONFIRMED cancel are different facts. The
 * decisive state for the outcome is the host receipt (`canceled: true`)
 * combined with the export's own terminal state:
 *   - host confirmed cancel            → "cancelled" (frame dropped)
 *   - export finished, cancel declined → "done"     (review counterexample A)
 *   - cancel RPC failed, export done   → "done"     (review counterexample B)
 *   - export failed without a confirm  → "failed"
 * Each activation owns its flags; a late response from an old cancel can
 * never alter a newer export. Repeat clicks send at most one cancel request
 * per activation until it conclusively failed or was declined (then a retry
 * is meaningful again).
 */

export type TailExportHandle = { jobId: string; index: number };
export type TailExportOutcome = "done" | "cancelled" | "failed";
export type TailCancelResult = "sent" | "already-requested" | "confirmed" | "declined" | "failed" | "inactive";

export type TailTransport = (method: string, params: Record<string, unknown>) => Promise<unknown>;

export type TailCancelReceipt = { canceled?: boolean; stopped?: number; jobId?: string; outputIndex?: number };

export function tailCancelParams(handle: TailExportHandle): { id: string; index: number } {
  // Mirrors studio/frame/export's own { id, index } parameters (same service family).
  return { id: handle.jobId, index: handle.index };
}

export class TailExportRunner {
  private active: TailExportHandle | null = null;
  private activation = 0;
  private cancelRequested = false;
  private cancelConfirmed = false;
  /** True once the export RPC reached a terminal state for this activation. */
  private exportSettled = true;

  constructor(private readonly transport: TailTransport) {}

  get activeHandle(): TailExportHandle | null {
    return this.active;
  }

  /** Host-confirmed cancellation of the current activation. */
  isCancelConfirmed(): boolean {
    return this.cancelConfirmed;
  }

  async run(jobId: string, index: number, onFrame: (frame: StudioFrameExport) => Promise<void>): Promise<TailExportOutcome> {
    if (this.active) return "failed";
    this.activation += 1;
    const activation = this.activation;
    this.active = { jobId, index };
    this.cancelRequested = false;
    this.cancelConfirmed = false;
    this.exportSettled = false;
    try {
      const frame = await this.transport("studio/frame/export", { id: jobId, index }) as StudioFrameExport;
      // The export has a terminal state from here: a cancel receipt arriving
      // later can neither overturn "done" nor pollute the next activation.
      this.exportSettled = true;
      if (activation !== this.activation) return "cancelled";
      if (this.cancelConfirmed) return "cancelled";
      await onFrame(frame);
      // The frame's side-effects already happened, so a late confirmation
      // cannot flip a published frame to "cancelled".
      return "done";
    } catch (error) {
      this.exportSettled = true;
      if (activation !== this.activation) return "cancelled";
      if (this.cancelConfirmed) return "cancelled";
      throw error;
    } finally {
      if (activation === this.activation) {
        this.active = null;
        this.cancelRequested = false;
        // cancelConfirmed is intentionally kept: UI assertions may still read
        // the activation's final state; the next run() resets it.
        this.exportSettled = true;
      }
    }
  }

  /**
   * Request cancellation of the active export. One request per activation
   * until it conclusively failed or was declined (a retry is then
   * meaningful). The returned value distinguishes request-sent,
   * already-requested, host-confirmed, host-declined, transport-failed, and
   * nothing-active.
   */
  async cancel(): Promise<TailCancelResult> {
    if (!this.active) return "inactive";
    if (this.cancelConfirmed) return "confirmed";
    if (this.cancelRequested) return "already-requested";
    // The export already has a terminal state: nothing to cancel, and a
    // stale "confirmed" receipt must not pollute the settled outcome.
    if (this.exportSettled) return "inactive";
    const activation = this.activation;
    const handle = this.active;
    this.cancelRequested = true;
    try {
      const receipt = await this.transport("studio/frame/cancel", tailCancelParams(handle)) as TailCancelReceipt | undefined;
      if (activation !== this.activation) return "already-requested";
      // Bind the receipt to THIS export: a confirmation for another job or
      // output index confirms nothing.
      if (receipt?.jobId !== undefined && receipt.jobId !== handle.jobId) {
        this.cancelRequested = false;
        return "declined";
      }
      if (receipt?.outputIndex !== undefined && receipt.outputIndex !== handle.index) {
        this.cancelRequested = false;
        return "declined";
      }
      // The export already has a terminal state: nothing to cancel, and a
      // stale "confirmed" receipt must not pollute the settled outcome.
      if (this.exportSettled) {
        this.cancelRequested = false;
        return "declined";
      }
      if (receipt?.canceled === true) {
        this.cancelConfirmed = true;
        return "confirmed";
      }
      // Host reports nothing was stopped (likely already finished). Retrying
      // is pointless; the export's own terminal state decides.
      this.cancelRequested = false;
      return "declined";
    } catch {
      if (activation !== this.activation) return "already-requested";
      // Transport failure: the request never conclusively reached the host,
      // so a retry is meaningful and the outcome stays with the export.
      this.cancelRequested = false;
      return "failed";
    }
  }
}
