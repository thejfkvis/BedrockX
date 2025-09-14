const { EventEmitter } = require('events')
const { Client, PacketPriority, PacketReliability } = require('./raknet/index');

class RakClient extends EventEmitter {
  constructor(options) {
    super()
    this.connected = false
    this.onConnected = () => { }
    this.onCloseConnection = () => { }
    this.onEncapsulated = () => { }

    this.raknet = new Client(options.host, options.port, { protocolVersion: 11 })

    this.raknet.on('encapsulated', (buffer) => {
      this.onEncapsulated(buffer)
    })

    this.raknet.on('connect', () => {
      this.connected = true
      this.onConnected()
    })

    this.raknet.on('disconnect', ({ reason }) => {
      this.connected = false
      this.onCloseConnection(reason)
    })
  }

  connect() {
    this.raknet.connect()
  }

  close() {
    this.connected = false
    this.raknet.close()
  }

  sendReliable(buffer, immediate) {
    if (this.connected) return this.raknet.send(buffer, immediate ? PacketPriority.IMMEDIATE_PRIORITY : PacketPriority.MEDIUM_PRIORITY, PacketReliability.RELIABLE_ORDERED, 0)
  }
}

module.exports = { RakClient }