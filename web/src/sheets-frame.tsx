import { useEffect, useRef, useState } from 'react'
import ReactDOM from 'react-dom/client'

import { InlineSheets } from './embed/SheetsEditor'
import {
  FRAME_PROTOCOL,
  isFrameCommand,
  type FrameConfig,
  type FrameEvent,
  type FrameMessageBody,
} from './embed/frame-protocol'
import type { SheetsHandle } from './embed/host-api'

/**
 * One editor, alone in a frame, driven entirely by its parent.
 *
 * This page has no UI and no URL parameters: everything arrives over
 * postMessage, so the document id and the API base never appear in a URL that
 * a referrer header or a browser history could carry somewhere else.
 *
 * The listener is installed before React mounts, and the frame announces
 * itself with `hello`. That ordering is what makes a frame reload invisible to
 * the host -- the parent answers every `hello` with the config it holds, so a
 * reloaded frame reopens the same document without being asked to.
 */

let parentOrigin: string | null = null

function send(body: FrameMessageBody): void {
  if (parentOrigin === null) return
  window.parent.postMessage({ protocol: FRAME_PROTOCOL, ...body }, parentOrigin)
}

const emit = (event: FrameEvent): void => send({ kind: 'event', event })

function Frame(): React.JSX.Element | null {
  const [config, setConfig] = useState<FrameConfig | null>(null)
  const handle = useRef<SheetsHandle>(null)

  useEffect(() => {
    const onMessage = (event: MessageEvent): void => {
      // Only ever the embedder, and only ever our own messages.
      if (event.source !== window.parent) return
      if (!isFrameCommand(event.data)) return
      // The first accepted message fixes the origin every reply is addressed
      // to, so a later navigation cannot start receiving this document.
      parentOrigin ??= event.origin
      if (event.origin !== parentOrigin) return
      const command = event.data
      if (command.kind === 'open') {
        setConfig(command.config)
        return
      }
      if (command.kind === 'update') {
        setConfig((current) => (current ? { ...current, ...command.patch } : current))
        return
      }
      const { id, method, options } = command
      const editor = handle.current
      if (!editor) {
        send({ kind: 'return', id, error: 'The editor is not mounted.' })
        return
      }
      const invoke = method === 'save' ? editor.save(options) : editor[method]()
      void invoke.then(
        (value) => send({ kind: 'return', id, value }),
        (error: unknown) => {
          send({
            kind: 'return',
            id,
            error: error instanceof Error ? error.message : String(error),
          })
        },
      )
    }
    window.addEventListener('message', onMessage)
    // Said after the listener exists, and said again on every reload -- which
    // is what makes a frame reload invisible to the host.
    //
    // The only message addressed to `*`, and the only one that can be: the
    // frame does not know its embedder's origin until the embedder speaks.
    // It carries nothing but the fact that a sheets frame is here, which the
    // embedder already knows because it created the frame.
    window.parent.postMessage({ protocol: FRAME_PROTOCOL, kind: 'hello' }, '*')
    return () => window.removeEventListener('message', onMessage)
  }, [])

  if (!config) return null
  return (
    <InlineSheets
      ref={handle}
      documentId={config.documentId}
      apiBase={config.apiBase}
      theme={config.theme}
      locale={config.locale}
      visible={config.visible}
      readOnly={config.readOnly}
      ai={config.ai}
      onLoaded={(file) => emit({ name: 'loaded', file })}
      onDirtyChange={(pendingEdits) => emit({ name: 'dirty', pendingEdits })}
      onSaved={(event) => emit({ name: 'saved', event })}
      onConflict={(event) => emit({ name: 'conflict', event })}
      onSelectionChange={(selection) => emit({ name: 'selection', selection })}
      onSaveAsRequest={(event) => emit({ name: 'saveAs', event })}
      onDraftRestored={() => emit({ name: 'draftRestored' })}
      onError={(error) => emit({ name: 'error', message: error.message })}
    />
  )
}

const root = document.getElementById('sheets-frame-root')
if (!root) throw new Error('Missing frame root.')
ReactDOM.createRoot(root).render(<Frame />)
