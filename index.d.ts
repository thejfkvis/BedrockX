/// <reference types="node" />

import { EventEmitter } from 'node:events'
import type { Authflow, ServerDeviceCodeResponse } from './src/authentication'

export type Transport = 'DEFAULT' | 'NETHERNET' | 'NETHERNET_JSONRPC'

export interface ClientOptions {
  host: string
  port?: number
  version?: '1.26.40' | string
  protocolVersion?: number
  transport?: Transport
  /** Retained as an alias for callers that used the older option name. */
  protocol?: Transport
  username?: string
  profilesFolder?: string
  authflow?: Authflow
  authTitle?: string
  onMsaCode?: (code: ServerDeviceCodeResponse) => void
  networkId?: string | bigint
  skinData?: Record<string, unknown>
  compressionLevel?: number
  delayedInit?: boolean
  onDiagnostic?: (diagnostic: Record<string, unknown>) => void
  [key: string]: unknown
}

export class Connection extends EventEmitter {
  write(name: string, params: Record<string, unknown>): void
  sendBuffer(buffer: Buffer): void
}

export class Client extends Connection {
  constructor(options: ClientOptions)
  readonly options: ClientOptions
  readonly status: number
  connect(): Promise<void>
  disconnect(reason?: string): void
  close(reason?: string): void
}

export function createClient(options: ClientOptions): Client

export { Authflow, Titles }
export type { ServerDeviceCodeResponse }

export class Relay extends EventEmitter {}
export class Server extends EventEmitter {}
