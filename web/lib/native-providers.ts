import type { NativeModelProvider } from './knorvia-native-types';

type Translate = (zh: string, en: string) => string;
export function providerLabel(provider: NativeModelProvider | undefined, t: Translate) {
  return !provider || (provider.id === 'default' && provider.name === 'Default provider')
    ? t('默认提供商', 'Default provider') : provider.name;
}

export function providerError(error: unknown, t: Translate) {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('while tasks are active')) return t('还有任务正在运行，请等任务结束后再切换。配置仍然保留。', 'Wait for running tasks to finish before switching. Your configurations are still saved.');
  if (message.includes('changed in another window')) return t('这项配置已在其他窗口更新。请重新读取后再保存，避免覆盖新内容。', 'This provider changed in another window. Reload before saving to keep the latest changes.');
  if (message.includes('update is already') || message.includes('engine is restarting')) return t('正在切换提供商，请稍候再试。', 'The provider is switching. Please try again shortly.');
  if (message.includes('Secure storage is unavailable')) return t('系统安全存储暂时不可用，配置尚未更改。', 'System secure storage is unavailable. No configurations were changed.');
  if (message.includes('previous connection was restored')) return t('新连接未能启动，已恢复原来的提供商。', 'The new connection could not start. The previous provider was restored.');
  return message;
}
