import type { AppPreferences, RequestIdentity } from './ports'
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
}

export type ChannelHandler = (context: ChannelContext) => Promise<unknown>

export type ChannelTable = Readonly<Record<string, ChannelHandler>>
