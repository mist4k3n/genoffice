import type { WorkbookFile } from '../../../apps/sheets/src/shared/desktop-api'
import type { HostTheme } from './theme'
import type {
  SheetsConflictEvent,
  SheetsExport,
  SheetsSavedEvent,
  SheetsSelection,
} from './host-api'

/**
 * The wire between a host page and an editor running in its own frame.
 *
 * Why a frame exists at all: Univer names its internal editor hosts with fixed
 * element ids (`__editor___INTERNAL_EDITOR__DOCS_NORMAL` and friends). Two
 * editors in one realm collide on them, so a page can mount many editors but
 * show only one at a time. A frame is a second realm, which is the only place
 * outside Univer where those ids can differ. See `FINDINGS-EMBED.md`.
 *
 * This is deliberately not a general remote-control protocol. It carries
 * exactly what `SheetsEditorProps` and `SheetsHandle` already define, so the
 * isolated component is a drop-in for the inline one and there is one host
 * contract rather than two.
 */
export const FRAME_PROTOCOL = 'genoffice-sheets-frame/1'

/** What the editor needs to open. Sent once, as the first message. */
export interface FrameConfig {
  readonly documentId: string
  readonly apiBase: string
  readonly theme: HostTheme
  readonly locale: string
  readonly readOnly: boolean
  readonly ai: boolean
  readonly visible: boolean
}

/** Props that may change without reopening the document. */
export type FrameUpdate = Partial<Pick<FrameConfig, 'theme' | 'locale' | 'visible'>>

/** `SheetsHandle`, minus `pendingEdits`, which the host answers from its own count. */
export type FrameMethod = 'save' | 'exportBytes' | 'exportCsv' | 'reload'

/** Tagged on the way out, checked on the way in; see {@link isFrameCommand}. */
export type Tagged<T> = T & { readonly protocol: typeof FRAME_PROTOCOL }

export type FrameCommandBody =
  | { readonly kind: 'open'; readonly config: FrameConfig }
  | { readonly kind: 'update'; readonly patch: FrameUpdate }
  | {
      readonly kind: 'call'
      readonly id: number
      readonly method: FrameMethod
      readonly options?: { readonly overwrite?: boolean } | undefined
    }

export type FrameCommand = Tagged<FrameCommandBody>

/**
 * Events, named for what the host does with them rather than for the callback
 * they end up in -- the mapping back to `SheetsHostEvents` happens in one
 * place, on the host side.
 */
export type FrameEvent =
  | { readonly name: 'loaded'; readonly file: WorkbookFile }
  | { readonly name: 'dirty'; readonly pendingEdits: number }
  | { readonly name: 'saved'; readonly event: SheetsSavedEvent }
  | { readonly name: 'conflict'; readonly event: SheetsConflictEvent }
  | { readonly name: 'selection'; readonly selection: SheetsSelection | null }
  | { readonly name: 'saveAs'; readonly event: SheetsExport }
  | { readonly name: 'draftRestored' }
  | { readonly name: 'error'; readonly message: string }

export type FrameMessageBody =
  | { readonly kind: 'hello' }
  | { readonly kind: 'event'; readonly event: FrameEvent }
  | {
      readonly kind: 'return'
      readonly id: number
      readonly value?: unknown
      readonly error?: string | undefined
    }

export type FrameMessage = Tagged<FrameMessageBody>

/**
 * A page receives postMessage traffic from anything that can reach it --
 * extensions, analytics, other frames. Every message is tagged and checked,
 * and both sides additionally check the sender window, so a tag alone is never
 * enough to be heard.
 */
export const isFrameCommand = (value: unknown): value is FrameCommand =>
  typeof value === 'object' &&
  value !== null &&
  (value as FrameCommand).protocol === FRAME_PROTOCOL &&
  ['open', 'update', 'call'].includes((value as FrameCommand).kind)

export const isFrameMessage = (value: unknown): value is FrameMessage =>
  typeof value === 'object' &&
  value !== null &&
  (value as FrameMessage).protocol === FRAME_PROTOCOL &&
  ['hello', 'event', 'return'].includes((value as FrameMessage).kind)

/**
 * The origin to address the frame at.
 *
 * Never `'*'`: the document's contents and its Save As bytes both travel this
 * channel, and a wildcard target hands them to whatever happens to be loaded
 * if the frame navigates.
 */
export function frameOrigin(src: string, base: string): string {
  return new URL(src, base).origin
}
