import EventEmitter from 'events'
import { Authflow, ServerDeviceCodeResponse, Titles } from 'prismarine-auth'

declare module 'bedrockx' {
    type Version = '1.26.20'

    export interface Options {
        // The version of Minecraft Bedrock Edition (Current is v1.26.20, and you must always stay up to date!)
        version: Version,
        // IP address of the server to connect to
        host: string,
        // Port number of the server to connect to
        port: number,
        // Transport protocol to use, DEFAULT is raknet, Both NETHERNET | NETHERNET_JSONRPC is for worlds/realms.
        protocol: 'DEFAULT' | 'NETHERNET' | 'NETHERNET_JSONRPC',
        // If using NETHERNET | NETHERNET_JSONRPC protocol, you must provide a networkId
        networkId?: string | bigint,
        // Compression level (0-9, default: 7)
        compressionLevel?: number,
        // The Minecraft Protocol Version to use.
        protocolVersion?: number
    }

    export interface ClientOptions extends Options {
        // Username field, used for prismarine-auth
        username?: string,
        // Authflow to authenticate the user
        authflow: Authflow,
        // AuthTitles to specify the title to authenticate with, default is MinecraftNintendoSwitch
        authTitle?: String,
        // Profiles folder to store cached profiles, default is .minecraft
        profilesFolder?: string,
        // Called when microsoft authorization is needed when not provided it will the information log to the console instead
        onMsaCode?: (code: ServerDeviceCodeResponse) => void,
        // Skin Data
        skinData: Object
    }

    export class Connection extends EventEmitter {
        // Send a packet to the server
        write(name: string, params: object): void
        // Send a buffer to the server
        sendBuffer(buffer: Buffer): void
    }

    export class Client extends Connection {
        constructor(options: ClientOptions)

        // Connect to the server
        connect(): Promise<void>

        // Disconnect from the server
        disconnect(reason?: string): void

        // Close the client
        close(): void
    }

    export function createClient(options: ClientOptions): Client
}