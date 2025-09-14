const { ClientStatus, Connection } = require('./connection')
const { createDeserializer, createSerializer } = require('./transforms/serializer')
const { KeyExchange } = require('./handshake/keyExchange')
const { NethernetClient } = require('./nethernet')
const { RakClient } = require('./rak')
const { authenticate } = require('./client/auth')

const JWT = require('jsonwebtoken')
const { v3 } = require('uuid-1345')

class Client extends Connection {
    connection

    constructor(options) {
        super()
        this.options = { ...options }
        this.compressionAlgorithm = 'none'
        this.compressionThreshold = 512
        this.compressionLevel = options.compressionLevel

        if (this.options.transport === 'NETHERNET') this.nethernet = {}

        if (!options.delayedInit) this.init()
    }

    init() {
        this.serializer = createSerializer()
        this.deserializer = createDeserializer()
        this.features = { compressorInHeader: true }

        KeyExchange(this, null, this.options)

        switch (this.options.transport) {
            case "NETHERNET":
                this.connection = new NethernetClient({ networkId: this.options.networkId })

                this.batchHeader = null
                this.disableEncryption = true
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
        this.on('session', this._connect)
        authenticate(this, this.options)
    }

    onEncapsulated = (encapsulated) => {
        const buffer = Buffer.from(encapsulated.buffer)
        process.nextTick(() => this.handle(buffer))
    }

    _connect = async () => {
        this.connection.onConnected = () => {
            this.status = ClientStatus.Connecting
            this.write('request_network_settings', { client_protocol: this.options.protocolVersion })
        }

        this.connection.onCloseConnection = () => {
            this.close()
        }

        this.connection.onEncapsulated = this.onEncapsulated
        this.connection.connect()
    }

    sendLogin() {
        this.status = ClientStatus.Authenticating

        let payload = {
            GameVersion: this.options.version,
            ServerAddress: `${this.options.host}:${this.options.port}`,
            PersonaSkin: true,
            DeviceOS: 1,
            DeviceId: v3().replace(/-/g, ''),
            DeviceModel: 'iPhone11,8',
            CurrentInputMode: 1,
            DefaultInputMode: 1,
            PlayFabId: v3().replace(/-/g, '').slice(0, 16).toLowerCase(),
            UIProfile: 1,
            LanguageCode: 'en_US',
            MaxViewDistance: 12,
            MemoryTier: 3,
            PlatformType: 1,
            GraphicsMode: 1,
            ...this.options.skinData
        }

        this.write('login', {
            protocol_version: this.options.protocolVersion,
            tokens: {
                identity: JSON.stringify({ AuthenticationType: 0, Certificate: JSON.stringify({ chain: this.chain }), Token: "" }),
                client: JWT.sign(payload, this.ecdhKeyPair.privateKey, { algorithm: 'ES384', header: { x5u: this.clientX509 } })
            }
        })
    }

    disconnect(reason = 'Client leaving') {
        if (this.status === ClientStatus.Disconnected) return

        this.close(reason)
    }

    close() {
        if (this.status !== ClientStatus.Disconnected) this.emit('close') // Emit close once
        this.batch = null;
        this.connection?.close()
        this.removeAllListeners()
        this.status = ClientStatus.Disconnected
    }

    readPacket(packet) {
        try {
            var des = this.deserializer.parsePacketBuffer(packet) // eslint-disable-line
        } catch (e) {
            // Dump information about the packet only if user is not handling error event.
            if (this.listenerCount('error') === 0) this.deserializer.dumpFailedBuffer(packet)
            this.emit('error', e)
            return
        }

        // Abstract some boilerplate before sending to listeners
        switch (des.data.name) {
            case 'server_to_client_handshake':
                this.emit('client.server_handshake', des.data.params)
                break
            case 'network_settings':
                this.compressionAlgorithm = packet.compression_algorithm || 'deflate'
                this.compressionThreshold = packet.compression_threshold
                this.compressionReady = true
                this.batch.updateCompressionSettings(this)

                this.sendLogin()
                break
            case 'disconnect': // Client kicked
                this.emit('kick', des.data.params)
                this.close()
                break
            case 'item_registry':
                des.data.params.itemstates?.forEach(state => {
                    if (state.name === 'minecraft:shield') {
                        this.serializer.proto.setVariable('ShieldItemID', state.runtime_id)
                        this.deserializer.proto.setVariable('ShieldItemID', state.runtime_id)
                    }
                })
                break
            case 'play_status':
                if (this.status === ClientStatus.Authenticating) this.status = ClientStatus.Initializing
                break
            default:
                break
        }

        this.emit(des.data.name, des.data.params)
    }
}

module.exports = { Client }