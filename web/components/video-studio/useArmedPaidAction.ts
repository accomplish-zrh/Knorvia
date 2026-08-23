'use client'

import { useCallback, useEffect, useState } from 'react'
import { nextArmedPaidAction, type ArmedPaidAction } from '@/lib/video-studio/studio-logic'

/**
 * Two-step paid-action guard (§Phase C5 also uses it for reroll buttons):
 * the first click arms the button, the second click (within the window)
 * fires the paid call. The armed record pins the guard key it was armed
 * under, so a stale "armed" state can never authorize a different request
 * after the shot, prompt, or node changes.
 */
export function useArmedPaidAction(key: string) {
  const [armedState, setArmed] = useState<ArmedPaidAction | null>(null)
  useEffect(() => {
    if (!armedState) return
    const timer = window.setTimeout(() => setArmed(null), 6000)
    return () => window.clearTimeout(timer)
  }, [armedState])
  const arm = useCallback((id: string) => {
    setArmed(current => nextArmedPaidAction(current, id, key).next)
  }, [key])
  const armed = useCallback(
    (id: string) => armedState !== null && armedState.id === id && armedState.key === key,
    [armedState, key]
  )
  const disarm = useCallback(() => setArmed(null), [])
  return { arm, armed, disarm }
}
