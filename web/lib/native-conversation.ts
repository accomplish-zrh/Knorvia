import { itemText, type Item } from './native-workbench-state';
import { goalConversationInput } from './native-goals';

export function conversationMessages(items: Item[], goalId?: string | null) {
  return items.filter(item => item.kind === 'userMessage' || item.kind === 'agentMessage').map(item => ({
    id: item.id, user: item.kind === 'userMessage',
    text: item.kind === 'userMessage' ? goalConversationInput(itemText(item), goalId)?.input ?? itemText(item) : itemText(item),
  }));
}
export function conversationMatches(items: ReturnType<typeof conversationMessages>, query: string) {
  const needle = query.trim().toLocaleLowerCase();
  return needle ? items.filter(item => item.text.toLocaleLowerCase().includes(needle)) : [];
}
