const { Client, Server, SignalStructure } = require('./nethernet/index')

class NethernetClient {
  constructor(options = {}) {
    this.connected = false
    this.onConnected = () => {}
    this.onCloseConnection = () => {}
    this.onEncapsulated = () => {}

    this.nethernet = new Client(options.networkId, "255.255.255.255", options.token, options.ecdhKeyPair)

    this.nethernet.on('connected', (client) => {
      if (this.connected) return

      this.onConnected(client)
      this.connected = true
    });

    this.nethernet.on('disconnect', (_id, reason) => {
      this.onCloseConnection(reason)
      this.connected = false
    });

    this.nethernet.on('encapsulated', (buffer) => {
      this.onEncapsulated({ buffer })
    });
  }

  async connect() {
    await this.nethernet.connect()
  }

  sendReliable(data) {
    this.nethernet.send(data)
  }

  set credentials(value) {
    this.nethernet.credentials = value
  }

  get credentials() {
    return this.nethernet.credentials
  }

  set signalHandler(handler) {
    this.nethernet.signalHandler = handler
  }

  handleSignal(signal) {
    this.nethernet.handleSignal(signal)
  }

  close() {
    this.connected = false
    this.nethernet.close()
  }
}

class NethernetServer {
  constructor(options = {}, server) {
    this.onOpenConnection = () => {}
    this.onCloseConnection = () => {}
    this.onEncapsulated = () => {}
    this.onClose = () => {}

    // Optional online signalling, such as NethernetJSONRPC, LAN discovery is always on
    this.signalling = options.signalling

    // LAN discovery always uses port 7551, so the RakNet port option doesn't apply
    this.nethernet = new Server(options.networkId, {
      token: options.token,
      ecdhKeyPair: options.ecdhKeyPair,
      maxConnections: options.maxPlayers
    })

    this.updateAdvertisement = () => {
      this.nethernet.setAdvertisement(server.getAdvertisement().toBuffer())
    }

    this.nethernet.on('openConnection', (connection) => {
      connection.sendReliable = (buffer) => connection.send(buffer)
      this.onOpenConnection(connection)
    })

    this.nethernet.on('closeConnection', (connection, reason) => {
      this.onCloseConnection(connection, reason)
    })

    this.nethernet.on('encapsulated', (buffer, address) => {
      this.onEncapsulated(buffer, address)
    })

    this.nethernet.on('error', (e) => console.error('NetherNet server error:', e))
  }

  get networkId() {
    return this.nethernet.networkId
  }

  async listen() {
    this.updateAdvertisement()
    await this.nethernet.listen()

    if (this.signalling) {
      await this.signalling.connect?.()
      this.nethernet.credentials = this.signalling.credentials ?? []

      this.signalling.on('signal', (signal) => {
        this.nethernet.handleSignal(signal, (reply) => {
          // Send back to whoever sent the offer
          this.signalling.write(new SignalStructure(reply.type, reply.connectionId, reply.data, this.nethernet.networkId, signal.serverNetworkId))
        })
      })
    }
  }

  close() {
    this.signalling?.destroy?.()
    this.nethernet.close()
  }
}

module.exports = { NethernetClient, NethernetServer }