const { Client } = require('./nethernet/index')

class NethernetClient {
  constructor(options = {}) {
    this.connected = false
    this.onConnected = () => {}
    this.onCloseConnection = () => {}
    this.onConnectError = () => {}
    this.onEncapsulated = () => {}
    this.onDiagnostic = () => {}

    this.nethernet = new Client(
      options.networkId,
      "255.255.255.255",
      options.token,
      options.identityPrivateKeyPEM
    )

    this.nethernet.on('connected', (client) => {
      if (this.connected) return

      this.onConnected(client)
      this.connected = true
    });

    this.nethernet.on('disconnect', (_id, reason) => {
      this.onCloseConnection(reason)
      this.connected = false
    });

    this.nethernet.on('connect_error', (metadata) => {
      this.onConnectError(metadata)
      this.connected = false
    });

    this.nethernet.on('encapsulated', (buffer) => {
      this.onEncapsulated({ buffer })
    });

    this.nethernet.on('diagnostic', (diagnostic) => {
      this.onDiagnostic(diagnostic)
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

module.exports = { NethernetClient }
