/**
 * Chat composer file-drop policy (LM Studio / Cherry style).
 *
 * Dropping homework PDFs, images, or docs onto the current composer attaches
 * them to THIS turn only. They are never auto-ingested into a knowledge base.
 * Knowledge-base import stays on the Knowledge Center drop zone.
 */

export const COMPOSER_DROP_MODE = 'turn-only' as const;

export type FileDropTarget = 'composer' | 'knowledge';

export const COMPOSER_DROP_TITLE = 'Attach to this turn only';
export const COMPOSER_DROP_HINT =
  'Not added to a knowledge base. Clear the chips after you ask.';

export function isKnowledgeIngestDrop(target: FileDropTarget): boolean {
  return target === 'knowledge';
}

export function composerDropAcceptsIngest(target: FileDropTarget): boolean {
  return target === 'composer' ? false : isKnowledgeIngestDrop(target);
}
