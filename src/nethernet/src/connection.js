class Connection {
  constructor(nethernet, address, rtcConnection) {
    this.nethernet = nethernet
    this.address = address
    this.rtcConnection = rtcConnection
    this.reliable = null
    this.unreliable = null
    this.promisedSegments = 0
    this.buf = Buffer.allocUnsafe(0)
    this.sendQueue = []
  }

  setChannels(reliable, unreliable) {
    if (reliable) {
      this.reliable = reliable
      this.reliable.onMessage((msg) => this.handleMessage(msg))
      this.reliable.onOpen(() => this.flushQueue())
    }

    if (unreliable) this.unreliable = unreliable
  }

  handleMessage(data) {
    if (typeof data === 'string' || data instanceof ArrayBuffer) data = Buffer.from(data)

    if (data.length < 2) throw new Error('Unexpected EOF')

    const segments = data[0]
    data = data.subarray(1)

    if (this.promisedSegments > 0 && this.promisedSegments - 1 !== segments) throw new Error(`Invalid promised segments: expected ${this.promisedSegments - 1}, got ${segments}`)

    this.promisedSegments = segments
    this.buf = this.buf ? Buffer.concat([this.buf, data]) : data

    if (this.promisedSegments > 0) return

    this.nethernet.emit('encapsulated', this.buf, this.address)
    this.buf = null
  }

  send(data) {
    if (typeof data === 'string') data = Buffer.from(data)

    if (!this.reliable || this.reliable.readyState === 'connecting') {
      this.sendQueue.push(data)
      return 0
    }

    switch (this.reliable.readyState) {
      case "closing":
      case "closed":
        throw new Error('Reliable channel is not open')
    }

    return this.sendNow(data)
  }

  sendNow(data) {
    let n = 0
    const MAX_MESSAGE_SIZE = this.nethernet.MAX_MESSAGE_SIZE
    let totalSegments = Math.ceil(data.length / MAX_MESSAGE_SIZE)

    for (let i = 0; i < data.length; i += MAX_MESSAGE_SIZE) {
      const remainingSegments = totalSegments - ~~(i / MAX_MESSAGE_SIZE) - 1
      const end = Math.min(i + MAX_MESSAGE_SIZE, data.length)
      const fragLength = end - i

      const message = Buffer.allocUnsafe(1 + fragLength)
      message[0] = remainingSegments
      data.copy(message, 1, i, end)

      this.reliable.sendMessageBinary(message)
      n += fragLength
    }

    return n
  }

  flushQueue() {
    while (this.sendQueue.length > 0) {
      const data = this.sendQueue.shift()
      this.sendNow(data)
    }
  }

  close() {
    if (this.reliable) this.reliable.close()
    if (this.unreliable) this.unreliable.close()
    if (this.rtcConnection) this.rtcConnection.close()
  }
}

module.exports = { Connection }