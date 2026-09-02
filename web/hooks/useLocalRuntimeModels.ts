"use client";

import { useEffect, useState } from "react";

import type { LLMOption } from "@/lib/llm-options";
import { probeLocalRuntimeModels } from "@/lib/local-runtime-models";

/** Probe loopback Ollama/LM Studio. Stays empty and silent when ports are closed. */
export function useLocalRuntimeModels() {
  const [options, setOptions] = useState<LLMOption[]>([]);

  useEffect(() => {
    let cancelled = false;
    void probeLocalRuntimeModels()
      .then((found) => {
        if (!cancelled && found.length) setOptions(found);
      })
      .catch(() => {
        /* ports closed or CORS — stay quiet */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return options;
}
