"use client";

import { useEffect, useRef, useState } from "react";
import type { LibraryRequest } from "@/lib/native-library";
import { readStudioOutput, type StudioJob, type StudioOutput } from "@/lib/native-studio";
import { mediaReadPool } from "@/lib/native-media-read-pool";
import type { MediaSlot } from "@/lib/native-media-review";

type Owner = { controller: AbortController; attempt: number };

/** Names are local to one immutable job/output manifest (the reader's key). */
export function useMediaOutputs(request: LibraryRequest, job: Pick<StudioJob, "id" | "outputs">, desired: StudioOutput[]) {
  const [slots, setSlots] = useState<Record<string, MediaSlot>>({});
  const slotsRef = useRef<Record<string, MediaSlot>>({});
  const owners = useRef(new Map<string, Owner>());
  const [attempts, setAttempts] = useState<Record<string, number>>({});
  const publish = (next: Record<string, MediaSlot>) => { slotsRef.current = next; setSlots(next); };
  const key = JSON.stringify(desired.map(output => [output.name, attempts[output.name] ?? 0]));

  useEffect(() => {
    const keep = new Set(desired.map(output => output.name));
    const next = { ...slotsRef.current };
    for (const [name, owner] of owners.current) {
      if (keep.has(name) && owner.attempt === (attempts[name] ?? 0)) continue;
      owner.controller.abort();
      owners.current.delete(name);
      if (next[name]?.url) URL.revokeObjectURL(next[name].url!);
      delete next[name];
    }
    for (const output of desired) {
      if (owners.current.has(output.name)) continue;
      const owner = { controller: new AbortController(), attempt: attempts[output.name] ?? 0 };
      owners.current.set(output.name, owner);
      next[output.name] = { status: "loading" };
      const isCurrent = () => !owner.controller.signal.aborted && owners.current.get(output.name) === owner;
      void mediaReadPool.run(owner.controller.signal, () => readStudioOutput(request, job as StudioJob, job.outputs.indexOf(output), owner.controller.signal)).then(blob => {
        if (!isCurrent()) return;
        publish({ ...slotsRef.current, [output.name]: { status: "ready", url: URL.createObjectURL(blob) } });
      }).catch(cause => {
        if (isCurrent()) publish({ ...slotsRef.current, [output.name]: { status: "error", error: cause instanceof Error ? cause.message : String(cause) } });
      });
    }
    publish(next);
    // Surviving reads keep their individual owners when the other pane changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, request]);

  useEffect(() => () => {
    for (const owner of owners.current.values()) owner.controller.abort();
    owners.current.clear();
    for (const slot of Object.values(slotsRef.current)) if (slot.url) URL.revokeObjectURL(slot.url);
    slotsRef.current = {};
  }, []);

  return {
    slots,
    retry: (name: string) => setAttempts(current => ({ ...current, [name]: (current[name] ?? 0) + 1 })),
    patch: (name: string, url: string | undefined, patch: Partial<MediaSlot>) => {
      const slot = slotsRef.current[name];
      if (slot?.status === "ready" && url && slot.url === url) publish({ ...slotsRef.current, [name]: { ...slot, ...patch } });
    },
  };
}
