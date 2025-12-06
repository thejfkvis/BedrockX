const MAX_MESSAGE_SIZE = 262143;

const ensureBuffer = (data) => {
  if (Buffer.isBuffer(data)) return data
  if (typeof data === 'string') return Buffer.from(data)
  if (data instanceof ArrayBuffer) return Buffer.from(data)
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength)

  throw new Error('Unsupported data type for RTC message')
}

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
      this.reliable.binaryType = 'arraybuffer'

      this.reliable.onmessage = (event) => this.handleMessage(event.data)

      this.reliable.onopen = () => this.flushQueue()
    }

    if (unreliable) {
      this.unreliable = unreliable
      this.unreliable.binaryType = 'arraybuffer'
    }
  }

  handleMessage(data) {
    const payload = ensureBuffer(data)

    if (payload.length < 2) throw new Error('Unexpected EOF')

    const segments = payload[0]
    const body = payload.subarray(1)

    if (this.promisedSegments > 0 && this.promisedSegments - 1 !== segments) throw new Error(`Invalid promised segments: expected ${this.promisedSegments - 1}, got ${segments}`)

    this.promisedSegments = segments
    this.buf = this.buf ? Buffer.concat([this.buf, body]) : body

    if (this.promisedSegments > 0) return

    this.nethernet.emit('encapsulated', this.buf, this.address)
    this.buf = null
  }

  send(data) {
    const payload = ensureBuffer(data)

    if (!this.reliable || this.reliable.readyState === 'connecting') {
      this.sendQueue.push(payload)
      return 0
    }

    if (this.reliable.readyState === 'closed' || this.reliable.readyState === 'closing') throw new Error('Reliable channel is not open')

    return this.sendNow(payload)
  }

  sendNow(data) {
    let n = 0
    let segments = Math.ceil(data.length / MAX_MESSAGE_SIZE)

    for (let i = 0; i < data.length; i += MAX_MESSAGE_SIZE) {
      const remainingSegments = segments - ~~(i / MAX_MESSAGE_SIZE) - 1
      const end = Math.min(i + MAX_MESSAGE_SIZE, data.length)
      const fragLength = end - i

      const message = Buffer.allocUnsafe(1 + fragLength)
      message[0] = remainingSegments
      data.copy(message, 1, i, end)

      this.reliable?.send(message)
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
    this.reliable?.close()
    this.unreliable?.close()
    this.rtcConnection?.close()
  }
}

module.exports = { Connection }