'use strict';

// C19: public revocation RPC for the scoped media-preview capabilities.
// The service itself lives in D's workspace-media-preview module; this file
// owns the C-side registration contract so the renderer (PanelPreview close,
// scope switch) can revoke a capability through the standard native request
// path. Tokens are opaque 64-hex capabilities issued by the service; invalid
// or foreign input fails the request without touching other capabilities.

const METHODS = ['preview/revoke', 'preview/revokeScope'];
const TOKEN_PATTERN = /^[0-9a-f]{64}$/;

function createPreviewRevocationHandlers(mediaPreview) {
  if (!mediaPreview || typeof mediaPreview.revoke !== 'function' || typeof mediaPreview.revokeScope !== 'function') {
    throw new Error('preview revocation requires a media preview service with revoke/revokeScope');
  }
  const handlers = {
    // Panel close / file switch: revoke exactly this capability.
    'preview/revoke': async (params) => {
      const token = typeof params?.token === 'string' ? params.token.toLowerCase() : '';
      if (!TOKEN_PATTERN.test(token)) throw Object.assign(new Error('preview token 无效'), { rpc: { code: -32602, message: 'preview token 无效' } });
      const revoked = mediaPreview.revoke(token);
      return { revoked: revoked === true };
    },
    // Workspace or thread switch: revoke every capability in that scope.
    'preview/revokeScope': async (params) => {
      const workspaceId = typeof params?.workspaceId === 'string' && params.workspaceId.length <= 200 ? params.workspaceId : undefined;
      const threadId = typeof params?.threadId === 'string' && params.threadId.length <= 200 ? params.threadId : undefined;
      if (!workspaceId && !threadId) throw Object.assign(new Error('需要 workspaceId 或 threadId'), { rpc: { code: -32602, message: '需要 workspaceId 或 threadId' } });
      return { revoked: mediaPreview.revokeScope({ workspaceId, threadId }) || 0 };
    },
  };
  return { methods: METHODS, handlers };
}

module.exports = { createPreviewRevocationHandlers, METHODS, TOKEN_PATTERN };
