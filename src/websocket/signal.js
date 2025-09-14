
const { WebSocket } = require('ws')
const { stringify } = require('json-bigint')
const { once, EventEmitter } = require('node:events')
const { SignalStructure } = require('../nethernet/index')

const MessageType = {
  RequestPing: 0,
  Signal: 1,
  Credentials: 2
}

class NethernetSignal extends EventEmitter {
  constructor(networkId, authflow, version) {
    super()

    this.networkId = networkId

    this.authflow = authflow

    this.version = version

    this.ws = null

    this.credentials = null

    this.pingInterval = null

    this.retryCount = 0
  }

  async connect() {
    if (this.ws?.readyState === WebSocket.OPEN) throw new Error('Already connected signaling server')
    
    await this.init()

    await once(this, 'credentials')
  }

  async destroy(resume = false) {
    if (this.pingInterval) {
      clearInterval(this.pingInterval)
      this.pingInterval = null
    }

    if (this.ws) {
      this.ws.onmessage = null
      this.ws.onclose = null

      const shouldClose = this.ws.readyState === WebSocket.OPEN

      if (shouldClose) {
        let outerResolve

        const promise = new Promise((resolve) => outerResolve = resolve)

        this.ws.onclose = outerResolve

        this.ws.close(1000, 'Normal Closure')

        await promise
      }

      this.ws.onerror = null
    }

    if (resume) return this.init()
  }

  async init() {
    const xbl = await this.authflow.getMinecraftBedrockServicesToken({ version: this.version })
    const address = `wss://signal.franchise.minecraft-services.net/ws/v1.0/signaling/${this.networkId}`

    const ws = new WebSocket(address, {
      headers: { Authorization: xbl.mcToken }
    })

    this.pingInterval = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ Type: MessageType.RequestPing }))
    }, 2000)

    ws.onclose = (event) => {
      console.log(event)
      this.onClose(event.code, event.reason)
    }

    ws.onerror = (event) => {
      console.log(event)
    }

    ws.onmessage = (event) => {
      this.onMessage(event.data)
    }

    this.ws = ws
  }

  onClose(code, reason) {
    console.log(code, reason)
    if (code === 1006) {
      if (this.retryCount < 5) {
        this.retryCount++
        this.destroy(true)
      } else {
        this.destroy()
        throw new Error('Signal Connection Closed Unexpectedly')
      }
    }
  }

  onMessage(res) {
    if (!(typeof res === 'string')) return console.log(res)

    const message = JSON.parse(res)

    switch (message.Type) {
      case MessageType.Credentials: {
        if (message.From !== 'Server') return

        this.credentials = parseTurnServers(message.Message)

        this.emit('credentials', this.credentials)
        break
      }
      case MessageType.Signal: {
        const signal = SignalStructure.fromString(message.Message)

        signal.networkId = message.From

        this.emit('signal', signal)
        break
      }
    }
  }

  write(signal) {
    if (!this.ws) throw new Error('WebSocket not connected')

    const message = stringify({ Type: MessageType.Signal, To: signal.networkId, Message: signal.toString() })

    this.ws.send(message)
  }
}

module.exports = { NethernetSignal }

function parseTurnServers(dataString) {
  const servers = []
  const data = JSON.parse(dataString)

  if (!data.TurnAuthServers) return servers

  for (let i = 0; i < data.TurnAuthServers.length; i++) {
    const server = data.TurnAuthServers[i];

    if (!server.Urls) continue;

    // Assuming server.Urls is an array
    for (let j = 0; j < server.Urls.length; j++) {
      const url = server.Urls[j];
      const match = url.match(/(stun|turn):([^:]+):(\d+)/);

      if (match) {
        servers.push({
          hostname: match[2],
          port: parseInt(match[3], 10),
          username: server.Username || undefined,
          password: server.Password || undefined,
        });
      }
    }
  }

  return servers
}