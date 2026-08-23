'use client'

import { useEffect } from 'react'

const IMAGE_FILE_PATTERN = /^image\/(png|jpeg|webp)$/i

/**
 * Paste reference images straight from the clipboard. Text pastes are left
 * untouched; only image files are intercepted.
 */
export function useClipboardImagePaste(onFiles: (files: File[]) => void, enabled = true) {
  useEffect(() => {
    if (!enabled) return
    const handler = (event: ClipboardEvent) => {
      const items = event.clipboardData?.files
      if (!items || !items.length) return
      const files = Array.from(items).filter(file => IMAGE_FILE_PATTERN.test(file.type))
      if (!files.length) return
      event.preventDefault()
      onFiles(files)
    }
    window.addEventListener('paste', handler)
    return () => window.removeEventListener('paste', handler)
  }, [onFiles, enabled])
}
