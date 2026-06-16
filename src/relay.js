const { Client } = require('./client')
const { Server } = require('./server')
const { Player } = require('./serverPlayer')

class RelayPlayer extends Player {
    constructor(server, conn) {
        super(server, conn)

        this.startRelaying = false
        this.once('join', () => { // The client has joined our proxy
            this.startRelaying = true
        })

        this.upInLog = (...msg) => { }
        this.upOutLog = (...msg) => { }
        this.downInLog = (...msg) => { }
        this.downOutLog = (...msg) => { }

        this.outLog = this.downOutLog
        this.inLog = this.downInLog
        this.chunkSendCache = []
        this.sentStartGame = false

        this.pendingUpstreamPackets = []
        this.player_unique_id = -1;
    }

    forwardToUpstream(data) {
        switch (data.name) {
            case 'client_cache_status':
                this.upstream.write('client_cache_status', { enabled: this.enableChunkCaching })
                return
            case 'set_local_player_as_initialized':
                this.status = 3
                break;
        }

        this.upstream.write(data.name, data.params)
    }

    // Called when we get a packet from backend server (Backend -> PROXY -> Client)
    readUpstream(packet) {
        let des
        try {
            des = this.server.deserializer.parsePacketBuffer(packet)
        } catch (e) {
            console.log('Upstream parse failed for', this.connection.address, '— forwarding raw buffer. id=0x' + packet[0]?.toString(16), e?.message)

            try {
                this.sendBuffer(packet)
            } catch (sendErr) {
                console.log('Failed to forward raw upstream packet:', sendErr?.message)
            }
            return
        }

        const name = des.data.name
        const params = des.data.params

        if (name === 'play_status' && params.status === 'login_success') return // Already sent this, this needs to be sent ASAP or client will disconnect

        this.emit('clientbound', des.data, des)

        if (!des.canceled) {
            switch (name) {
                case 'start_game':
                    this.player_unique_id = params.entity_id;
                    this.sentStartGame = true
                    break
                case 'level_chunk':
                    this.chunkSendCache.push(params)
                    return
                case 'creative_content':
                    this.sendBuffer(packet)
                    return
                case 'update_player_game_type':
                    if (this.player_unique_id) {
                        if (params.player_unique_id != this.player_unique_id) break;

                        this.write("set_player_game_type", {
                            gamemode: params.gamemode
                        })
                    }
                    break
            }

            this.write(name, params)
        }

        const chunkLen = this.chunkSendCache.length
        if (chunkLen > 0 && this.sentStartGame) {
            for (let i = 0; i < chunkLen; i++) this.write("level_chunk", this.chunkSendCache[i]);

            this.chunkSendCache = [];
        }
    }

    // Called when the server gets a packet from the downstream player (Client -> PROXY -> Backend)
    readPacket(packet) {
        if (this.startRelaying) {
            let des
            try {
                des = this.server.deserializer.parsePacketBuffer(packet)
            } catch (e) {
                console.log('Downstream parse failed for', this.connection.address, '— forwarding raw buffer. id=0x' + packet[0]?.toString(16), e?.message)

                if (this.upstream) {
                    try {
                        this.upstream.sendBuffer(packet)
                    } catch (sendErr) {
                        console.log('Failed to forward raw downstream packet:', sendErr?.message)
                    }
                }
                return
            }

            this.emit('serverbound', des.data, des)
            if (des.canceled) return

            if (!this.upstream) {
                this.pendingUpstreamPackets.push(des.data)
                return
            }

            this.forwardToUpstream(des.data)
        } else {
            super.readPacket(packet)
        }
    }

    close(reason) {
        super.close(reason)
        this.upstream?.close(reason)
    }
}

class Relay extends Server {
    /**
     * Creates a new non-transparent proxy connection to a destination server
     * @param {Options} options
     */
    constructor(options) {
        super(options)
        this.RelayPlayer = options.relayPlayer || RelayPlayer
        this.forceSingle = options.forceSingle
        this.upstreams = new Map()
        this.conLog = console.log
        this.enableChunkCaching = options.enableChunkCaching
    }

    async openUpstreamConnection(ds, clientAddr) {
        const options = {
            authTitle: this.options.authTitle,
            flow: this.options.flow,
            deviceType: this.options.deviceType,
            username: ds.profile?.name || undefined,
            version: this.options.version,
            host: this.options.destination.host,
            port: this.options.destination.port,
            transport: this.options.destination.transport,
            networkId: this.options.destination.networkId,
            authflow: this.options.authflow,
            protocolVersion: this.options.protocolVersion,
            onMsaCode: (code) => {
                if (this.options.onMsaCode) {
                    this.options.onMsaCode(code, ds)
                } else {
                    ds.disconnect("It's your first time joining. Please sign in and reconnect to join this server:\n\n" + code.message)
                }
            },
            profilesFolder: this.options.profilesFolder,
            autoInitPlayer: false
        }

        const client = new Client(options)

        client.connect()

        client.once('resource_packs_info', (params) => {
            client.write('client_cache_status', { enabled: false })

            ds.upstream = client

            console.log('Connected to upstream server')

            const data = { name: 'resource_packs_info', params }
            ds.emit('clientbound', data, { canceled: false })
            ds.write('resource_packs_info', params)

            const len = ds.pendingUpstreamPackets.length
            if (len > 0) {
                for (let i = 0; i < len; i++) ds.forwardToUpstream(ds.pendingUpstreamPackets[i]);

                ds.pendingUpstreamPackets = [];
            }

            client.readPacket = (packet) => ds.readUpstream(packet)

            this.emit('join', ds, client)
        })

        client.on('error', (err) => {
            console.log(err, "upstream client")

            ds.disconnect('Server error: ' + err.message)

            this.upstreams.delete(clientAddr.hash)
        })

        client.on('close', (reason) => {
            const cascading = ds.status === undefined || ds.status === 0 /* Disconnected */

            console.log('>>> upstream Client emitted CLOSE for', clientAddr, '— reason:', reason, cascading ? '(cascading from local close — ds.disconnect will no-op)' : '(upstream-initiated)')

            ds.disconnect(reason ? `Backend server closed connection (${reason})` : 'Backend server closed connection')

            this.upstreams.delete(clientAddr.hash)
        })

        this.upstreams.set(clientAddr.hash, client)
    }

    closeUpstreamConnection(clientAddr) {
        const up = this.upstreams.get(clientAddr.hash)
        if (!up) throw Error(`unable to close non-open connection ${clientAddr.hash}`)
        up.close()

        this.upstreams.delete(clientAddr.hash)
    }

    onOpenConnection = (conn) => {
        this.clientCount++

        const player = new this.RelayPlayer(this, conn)
        this.clients[conn.address] = player

        this.emit('connect', player)

        player.on('login', () => {
            console.log('Received login from', conn.address)
            this.openUpstreamConnection(player, conn.address)
        })

        player.on('close', (reason) => {
            console.log('player disconnected', conn.address, reason)
            this.clientCount--
            delete this.clients[conn.address]
        })
    }

    close(...a) {
        for (const [, v] of this.upstreams) {
            v.close(...a)
        }

        super.close(...a)
    }
}

module.exports = { Relay }