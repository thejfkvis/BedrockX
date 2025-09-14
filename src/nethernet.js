const { Client } = require('./nethernet/index')

class NethernetClient {
  constructor(options = {}) {
    this.connected = false
    this.onConnected = () => { }
    this.onCloseConnection = () => { }
    this.onEncapsulated = () => { }

    this.nethernet = new Client(options.networkId)

    this.nethernet.on('connected', (client) => {
      this.connected = true
      this.onConnected(client)
    })

    this.nethernet.on('disconnect', (reason) => {
      this.connected = false
      this.onCloseConnection(reason)
    })

    this.nethernet.on('encapsulated', (buffer) => {
      this.onEncapsulated({ buffer })
    })
  }

  connect() {
    this.nethernet.connect()
  }

  sendReliable(data) {
    this.nethernet.send(data)
  }

  close() {
    this.connected = false
    this.nethernet.close()
  }
}

module.exports = { NethernetClient }