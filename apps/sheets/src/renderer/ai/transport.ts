import type { DesktopApi } from '../../shared/desktop-api'
import { createIpcTransport, type AgentTransport } from '@genoffice/agent-core'
import type { AiSettings } from '@genoffice/ai-provider'
import { t } from '../i18n/locale'

/** The shared IPC transport wired to the sheets preload bridge (api). */
export function createElectronTransport(
  api: DesktopApi,
  getSettings: () => AiSettings,
): AgentTransport {
  return createIpcTransport<AiSettings>({
    onStream: (listener) => api.onAiStream(listener),
    start: (request) => api.aiStream(request),
    cancel: (requestId) => void api.aiStreamCancel(requestId),
    getSettings,
    unknownErrorText: () => t('aiUnknownError'),
    timeoutErrorText: () => t('aiTimeoutError'),
    creditsErrorText: () => t('aiCreditsExhausted'),
    networkErrorText: () => t('aiNetworkError'),
    overloadedErrorText: () => t('aiOverloadedError'),
  })
}
