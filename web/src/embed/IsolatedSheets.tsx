import { useEffect, useImperativeHandle, useRef, useState } from 'react'

import {
  FRAME_PROTOCOL,
  frameOrigin,
  isFrameMessage,
  type FrameCommandBody,
  type FrameConfig,
  type FrameEvent,
  type FrameMethod,
  type FrameUpdate,
} from './frame-protocol'
import type { SheetsEditorProps, SheetsExport, SheetsHandle } from './host-api'

/**
 * The same editor, in its own realm.
 *
 * Props and ref are `SheetsEditor`'s, unchanged -- a host swaps one for the
 * other and nothing else moves. What changes is where the renderer runs: this
 * mounts a frame and speaks `frame-protocol.ts` to the copy inside it.
 *
 * Use it when two editors must be **visible at the same time** (a compare
 * view, a split). Several editors with one visible at a time work inline and
 * should stay inline -- a frame costs a second copy of the bundle and a second
 * React tree, which is real memory on a page holding a 30MB workbook.
 */
export function IsolatedSheets(props: SheetsEditorProps): React.JSX.Element {
  const {
    documentId,
    apiBase,
    theme = 'system',
    locale = 'en',
    visible = true,
    readOnly = false,
    ai = false,
    frameSrc = DEFAULT_FRAME_SRC,
  } = props

  const frameRef = useRef<HTMLIFrameElement>(null)
  const handlers = useRef(props)
  handlers.current = props

  // Mirrors the frame's dirty count, so `pendingEdits()` can still answer
  // synchronously -- a host reading it inside a beforeunload or a close prompt
  // has no opportunity to await.
  const pendingEditsRef = useRef(0)
  const calls = useRef(new Map<number, Deferred>())
  const nextCallId = useRef(1)
  // Config for the current document. Re-sent verbatim if the frame reloads,
  // which is what makes `reload()` and a crashed frame recover the same way.
  const configRef = useRef<FrameConfig | null>(null)
  const [origin] = useState(() => frameOrigin(frameSrc, window.location.href))

  const post = (command: FrameCommandBody): void => {
    const target = frameRef.current?.contentWindow
    if (!target) return
    target.postMessage({ protocol: FRAME_PROTOCOL, ...command }, origin)
  }

  useEffect(() => {
    configRef.current = { documentId, apiBase, theme, locale, readOnly, ai, visible }
    const onMessage = (event: MessageEvent): void => {
      // Three checks, and all three matter: the right window, the right
      // origin, and our own tag. A page hears postMessage from extensions,
      // analytics and sibling frames.
      if (event.source !== frameRef.current?.contentWindow) return
      if (event.origin !== origin) return
      if (!isFrameMessage(event.data)) return
      const message = event.data
      if (message.kind === 'hello') {
        // Sent whenever the frame's script starts, so a reload re-opens the
        // document without the host noticing.
        if (configRef.current) post({ kind: 'open', config: configRef.current })
        return
      }
      if (message.kind === 'event') {
        deliver(message.event, handlers.current, pendingEditsRef)
        return
      }
      const pending = calls.current.get(message.id)
      if (!pending) return
      calls.current.delete(message.id)
      if (message.error !== undefined) pending.reject(new Error(message.error))
      else pending.resolve(message.value)
    }
    window.addEventListener('message', onMessage)
    return () => {
      window.removeEventListener('message', onMessage)
      for (const pending of calls.current.values()) {
        pending.reject(new Error('The editor was closed.'))
      }
      calls.current.clear()
      configRef.current = null
    }
    // `theme`, `locale` and `visible` ride the update effect below rather than
    // reopening the document; the rest identify it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [documentId, apiBase, readOnly, ai, origin])

  useEffect(() => {
    const config = configRef.current
    if (config) configRef.current = { ...config, theme, locale, visible }
    const patch: FrameUpdate = { theme, locale, visible }
    post({ kind: 'update', patch })
  }, [theme, locale, visible])

  useImperativeHandle(
    props.ref,
    (): SheetsHandle => ({
      save: (options) => call('save', options) as Promise<void>,
      exportBytes: () => call('exportBytes') as Promise<SheetsExport>,
      exportCsv: () => call('exportCsv') as Promise<void>,
      reload: () => call('reload') as Promise<void>,
      pendingEdits: () => pendingEditsRef.current,
    }),
    [],
  )

  function call(method: FrameMethod, options?: { overwrite?: boolean }): Promise<unknown> {
    if (!frameRef.current?.contentWindow) {
      return Promise.reject(new Error('The editor is not mounted.'))
    }
    const id = nextCallId.current++
    return new Promise<unknown>((resolve, reject) => {
      calls.current.set(id, { resolve, reject })
      post({ kind: 'call', id, method, options })
    })
  }

  return (
    <iframe
      ref={frameRef}
      src={frameSrc}
      title={documentId}
      // The frame is the editor; the host sizes it like any other child.
      // `flex: 1` as well as `height: 100%` because a host that lays this out
      // with flexbox gives its wrapper no definite height, and a percentage
      // against `auto` collapses -- measured at 703px inside a full-height
      // pane, with the grid clipped and black below it.
      style={{ border: 'none', display: 'block', flex: 1, width: '100%', height: '100%', minWidth: 0, minHeight: 0 }}
      // Deliberately no `sandbox`. The frame runs this package's own code from
      // the origin that served the bundle, so the only attribute set that
      // would let it work at all is `allow-scripts allow-same-origin` -- which
      // the platform itself warns is equivalent to no sandbox, because the
      // frame can reach through and remove the attribute. An attribute that
      // restricts nothing and prints a security warning is worse than none.
    />
  )
}

interface Deferred {
  resolve(value: unknown): void
  reject(error: Error): void
}

/**
 * Where the frame's page lives.
 *
 * Relative, so it resolves against whatever the host serves the bundle from.
 * A host that puts it elsewhere passes `frameSrc`; a host that serves it from
 * another origin must also send its session cookie with `SameSite=None`,
 * because the frame makes its own API calls.
 */
const DEFAULT_FRAME_SRC = 'sheets-frame.html'

/** One place where the frame's vocabulary becomes the host's callbacks. */
function deliver(
  event: FrameEvent,
  handlers: SheetsEditorProps,
  pendingEdits: React.RefObject<number>,
): void {
  switch (event.name) {
    case 'loaded':
      handlers.onLoaded?.(event.file)
      return
    case 'dirty':
      pendingEdits.current = event.pendingEdits
      handlers.onDirtyChange?.(event.pendingEdits)
      return
    case 'saved':
      handlers.onSaved?.(event.event)
      return
    case 'conflict':
      handlers.onConflict?.(event.event)
      return
    case 'selection':
      handlers.onSelectionChange?.(event.selection)
      return
    case 'saveAs':
      handlers.onSaveAsRequest?.(event.event)
      return
    case 'draftRestored':
      handlers.onDraftRestored?.()
      return
    case 'error':
      // Errors do not survive structured clone as Errors, so the frame sends
      // the message and this rebuilds one -- a host catching on `instanceof`
      // should not have to care which side of the boundary it came from.
      handlers.onError?.(new Error(event.message))
      return
  }
}
