const { ClientStatus, Connection } = require('./connection')
const { createDeserializer, createSerializer, peekPacketHeader } = require('./transforms/serializer')
const { RakClient } = require('./rak')
const { authenticate } = require('./client/auth')
const { NethernetSignal } = require('./websocket/signal')
const { NethernetJSONRPC } = require('./websocket/signal-jsonrpc')
const { createConnectError } = require('./nethernet/index')

const JWT = require('jsonwebtoken')
const crypto = require('crypto')

const steve = require("./skins/steve.json");

const { v3, v4, NIL } = require('uuid')

const PROTOCOL_STATUS_NAMES = {
    0: 'disconnected',
    1: 'transport-connecting',
    2: 'authenticating',
    3: 'initializing',
    4: 'initialized'
}

function reportDiagnostic(client, diagnostic) {
    client.options.onDiagnostic?.(diagnostic)
    client.emit('nethernet_diagnostic', diagnostic)
}

const pem = { format: 'pem', type: 'sec1' }
const identityPem = { format: 'pem', type: 'pkcs8' }
const der = { format: 'der', type: 'spki' }

class Client extends Connection {
    connection

    constructor(options) {
        super()
        this.options = { ...options }
        this.closing = false
        this.on('status', (status) => {
            const label = PROTOCOL_STATUS_NAMES[Number(status)] || `unknown(${String(status)})`
            reportDiagnostic(this, { phase: 'bedrock', message: `Protocol client state: ${label} (${String(status)}).` })
        })
        this.on('packet_sent', (packet) => {
            if (!packet?.name) return
            const prefix = packet.first ? 'First outbound Bedrock packet' : 'Outbound Bedrock packet'
            reportDiagnostic(this, { phase: 'bedrock', message: `${prefix}: ${packet.name}.` })
        })
        this.compressionAlgorithm = 'none'
        this.compressionThreshold = 512
        this.compressionLevel = options.compressionLevel

        if (this.options.transport.includes('NETHERNET')) this.nethernet = {}

        if (!options.delayedInit) this.init()
    }

    async init() {
        this.serializer = createSerializer()
        this.deserializer = createDeserializer()
        this.features = { compressorInHeader: true }

        this.ecdhKeyPair = crypto.generateKeyPairSync('ec', { namedCurve: "secp384r1" })
        this.clientX509 = this.ecdhKeyPair.publicKey.export(der).toString('base64')
        this.privateKeyPEM = this.ecdhKeyPair.privateKey.export(pem)
        this.identityPrivateKeyPEM = this.ecdhKeyPair.privateKey.export(identityPem)

        await authenticate(this, this.options)

        switch (this.options.transport) {
            case "NETHERNET":
            case "NETHERNET_JSONRPC":
                // WebRTC is a native optional transport. Loading it at module startup
                // can terminate packaged Electron Node processes before the backend
                // begins listening, even when the selected realm uses RakNet.
                const { NethernetClient } = require('./nethernet')
                this.connection = new NethernetClient({
                    networkId: this.options.networkId,
                    token: this.multiplayerToken || this.token,
                    identityPrivateKeyPEM: this.identityPrivateKeyPEM
                })
                this.connection.onDiagnostic = (diagnostic) => reportDiagnostic(this, diagnostic)
                this.connection.onConnectError = (metadata) => {
                    const error = createConnectError(metadata)
                    reportDiagnostic(this, {
                        phase: 'signaling',
                        level: 'error',
                        message: `NetherNet CONNECTERROR aborting connection: code=${metadata.code || 'unknown'} reason=${metadata.reason || 'unknown'} delivery_id=${metadata.deliveryId || 'none'}.`
                    })
                    this.emit('nethernet_error', metadata)
                    // Emit first so the owning client can surface the
                    // reason and clear its session timeout, then guarantee the
                    // transport/signaling cleanup even if no listener exists.
                    try {
                        this.emit('error', error)
                    } finally {
                        this.close(error.message)
                    }
                }

                this.batchHeader = null
                this.disableEncryption = true

                this.nethernet.signalling = this.options.transport === "NETHERNET_JSONRPC" ? new NethernetJSONRPC(this.connection.nethernet.networkId, this.options.authflow, this.options.version, this.options.networkId) : new NethernetSignal(this.connection.nethernet.networkId, this.options.authflow, this.options.version, this.options.networkId)

                this.nethernet.signalling.on("diagnostic", (diagnostic) => reportDiagnostic(this, diagnostic))

                await this.nethernet.signalling.connect()

                this.connection.nethernet.credentials = this.nethernet.signalling.credentials
                this.connection.nethernet.signalHandler = this.nethernet.signalling.write.bind(this.nethernet.signalling)

                this.nethernet.signalling.on('signal', signal => this.connection.nethernet.handleSignal(signal))
                this.nethernet.signalling.on('error', err => {
                    reportDiagnostic(this, { phase: "signaling", level: "error", message: `NetherNet signaling error: ${err?.message || String(err)}` })
                    this.emit("nethernet_error", err)
                    // Surface an exhausted signaling failure to the owning
                    // client so the caller can clear the session instead of leaving
                    // the UI stuck in a transport-open state.
                    this.emit("error", err)
                })
                break;
            case "DEFAULT":
                this.connection = new RakClient({ host: this.options.host, port: this.options.port })

                this.batchHeader = 0xfe
                this.disableEncryption = false
                break;
        }

        this.batch.updateCompressionSettings(this)

        this.emit('connect_allowed')
    }

    connect() {
        if (!this.connection) throw new Error('Connect not currently allowed')
        reportDiagnostic(this, { phase: 'bedrock', message: 'BedrockX protocol client.connect() called.' })
        return this._connect()
    }

    onEncapsulated = (encapsulated) => {
        if (this.closing) return
        this.handle(Buffer.from(encapsulated.buffer))
    }

    _connect = async () => {
        this.connection.onConnected = () => {
            this.status = ClientStatus.Connecting
            this.emit('transport_open', this.connection)
            this.write('request_network_settings', { client_protocol: this.options.protocolVersion })
            reportDiagnostic(this, { phase: 'bedrock', message: 'request_network_settings sent: yes.' })
        }

        this.connection.onCloseConnection = (reason) => {
            this.close(reason)
        }

        this.connection.onEncapsulated = this.onEncapsulated
        try {
            await this.connection.connect()
        } catch (error) {
            this.emit('error', error)
        }
    }

    sendLogin() {
        this.status = ClientStatus.Authenticating

        let payload = {
            GameVersion: this.options.version,
            PersonaSkin: true,
            DeviceOS: 2,
            DeviceId: v3(v4(), NIL).replace(/-/g, '').toUpperCase(),
            DeviceModel: 'iPhone14,3',
            CurrentInputMode: 2,
            DefaultInputMode: 2,
            SelfSignedId: v3(v4(), NIL),
            GUIScale: 0,
            UIProfile: 1,
            LanguageCode: 'en_US',
            MaxViewDistance: 12,
            MemoryTier: 4,
            PlatformType: 1,
            GraphicsMode: 1,
            TrustedSkin: true,
            OverrideSkin: false,
            ...steve,
            ...this.options.skinData
        }

        const PlayFabId = this.tokenData.mid.toLowerCase() || "";

        // Persona skins use the account-specific geometry identifier. Custom
        // PNG and .mcpack skins explicitly set PersonaSkin=false and must keep
        // their pack SkinId and geometry identifiers intact in the login JWT.
        if (this.options.skinData?.PersonaSkin !== false) {
            const updPFID = (data) => btoa(atob(data).replaceAll(`aed7e8a4d485a49a-5`, `${PlayFabId}-5`));
            payload.SkinId = `persona-${PlayFabId || ""}-5`;
            payload.SkinGeometryData = updPFID(payload.SkinGeometryData);
            payload.SkinResourcePatch = updPFID(payload.SkinResourcePatch);
        }

        const identityChain = [this.clienttoken, ...(Array.isArray(this.chain) ? this.chain : [])].filter(Boolean)
        reportDiagnostic(this, {
            phase: 'identity',
                message: `Bedrock login identity payload: certificate_chain_entries=${identityChain.length} client_certificate=${this.clienttoken ? 'present' : 'missing'} multiplayer_token=${(this.multiplayerToken || this.token) ? 'present' : 'missing'}.`
        })

        this.write('login', {
            protocol_version: this.options.protocolVersion,
            tokens: {
                identity: JSON.stringify({ AuthenticationType: 0, Certificate: JSON.stringify({ chain: identityChain }), Token: this.multiplayerToken || this.token }),
                client: JWT.sign(payload, this.ecdhKeyPair.privateKey, { algorithm: 'ES384', header: { x5u: this.clientX509 } })
            }
        })
    }

    disconnect(reason = 'Client leaving') {
        if (this.status === ClientStatus.Disconnected) return

        this.close(reason)
    }

    close(reason) {
        if (this.closing) return
        this.closing = true
        if (this.status !== ClientStatus.Disconnected) this.emit('close', reason) // Emit close once
        this.batch = null;
        const signalling = this.nethernet?.signalling
        // Mark signaling aborted before closing WebRTC so any queued ICE
        // callback observes a closed writer instead of racing teardown.
        if (signalling) signalling.destroy()
        this.connection?.close()
        this.removeAllListeners()
        this.status = ClientStatus.Disconnected
        if (!this.options.transport.includes("NETHERNET")) return
        this.nethernet = null
    }

    readPacket(packet) {
        try {
            var des = this.deserializer.parsePacketBuffer(packet) // eslint-disable-line
        } catch (e) {
            const packetHeader = peekPacketHeader(packet)
            const packetLabel = packetHeader
                ? `packet=${packetHeader.name}, packet_id=${packetHeader.packetId}, sender_subclient=${packetHeader.senderSubclient}, target_subclient=${packetHeader.targetSubclient}`
                : 'packet=unknown'
            const originalMessage = e?.message || String(e)
            const decodeMessage = `Packet decode failed (${packetLabel}): ${originalMessage}`
            if (e instanceof Error) {
                e.message = decodeMessage
                e.packet_id = packetHeader?.packetId
                e.packet_name = packetHeader?.name
            }
            reportDiagnostic(this, {
                phase: 'bedrock',
                level: 'error',
                message: decodeMessage
            })
            if (this.closing) return
            this.emit('error', e)
            return
        }

        // Abstract some boilerplate before sending to listeners
        switch (des.data.name) {
            case 'network_settings':
                this.compressionAlgorithm = des.data.params.compression_algorithm || 'deflate'
                this.compressionThreshold = des.data.params.compression_threshold
                this.compressionReady = true
                this.batch.updateCompressionSettings(this)

                this.sendLogin()
                break
            case 'server_to_client_handshake':
                const [header, payload] = des.data.params.token.split('.', 2).map(part => JSON.parse(Buffer.from(part, 'base64url').toString()))

                if (!this.disableEncryption) {
                    this.secretKeyBytes = crypto.createHash('sha256').update(Buffer.from(payload.salt, 'base64')).update(crypto.diffieHellman({ privateKey: this.ecdhKeyPair.privateKey, publicKey: crypto.createPublicKey({ key: Buffer.from(header.x5u, 'base64'), ...der }) })).digest()
                    this.startEncryption(this.secretKeyBytes.slice(0, 16))
                }

                this.write('client_to_server_handshake', {})
                this.status = ClientStatus.Initializing
                break
            case 'disconnect': // Client kicked
                this.emit('kick', des.data.params)
                this.close()
                break
            case 'item_registry':
                this.itemRegistry = new Map()
                des.data.params.itemstates?.forEach(state => {
                    this.itemRegistry.set(Number(state.runtime_id), state.name)
                    if (state.name === 'minecraft:shield') {
                        this.serializer.proto.setVariable('ShieldItemID', state.runtime_id)
                        this.deserializer.proto.setVariable('ShieldItemID', state.runtime_id)
                    }
                })
                break
            case 'play_status':
                if (this.status === ClientStatus.Authenticating) this.status = ClientStatus.Initializing
                break
            case 'start_game':
                this.status = ClientStatus.Initialized
                break
            default:
                break
        }

        this.emit(des.data.name, des.data.params)
    }
}

module.exports = { Client }
