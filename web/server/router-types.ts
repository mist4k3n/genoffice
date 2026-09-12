import type { ExportStore } from './exports'
import type { AppPreferences, DraftAdapter, RequestIdentity, StorageAdapter } from './ports'
import type { PushHub } from './push'
import type { SessionRegistry } from './sessions'
import type { SidecarPool } from './sidecar/pool'

/** What a channel handler is given. Deliberately small. */
export interface ChannelContext {
  /** Positional arguments, exactly as the renderer passed them to invoke(). */
  readonly args: readonly unknown[]
  readonly identity: RequestIdentity
  readonly registry: SessionRegistry
  readonly pool: SidecarPool
  readonly locale: string
  readonly preferences: AppPreferences
  /** For handlers whose effect other viewers of the document must see. */
  readonly push: PushHub
  readonly storage: StorageAdapter
  /** Scratch space for work that must land on disk before it reaches storage. */
  readonly scratchDir: string
  /** Save As parks its assembled bytes here for the host to fetch once. */
  readonly exports: ExportStore
  /** Unsaved work between saves. Absent when the host supplies no draft store. */
  readonly drafts: DraftAdapter | undefined
}

export type ChannelHandler = (context: ChannelContext) => Promise<unknown>

export type ChannelTable = Readonly<Record<string, ChannelHandler>>
