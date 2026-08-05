const { EventEmitter } = require('events')
const { Framer } = require('./transforms/framer')

const cipher = require('./transforms/encryption')

const DIAGNOSTIC_PACKET_NAMES = new Set([
  'request_network_settings',
  'login',
  'client_to_server_handshake',
  'resource_pack_client_response',
  'request_chunk_radius',
  'serverbound_loading_screen',
  'set_local_player_as_initialized'
])

const ClientStatus = {
  Disconnected: 0,
  Connecting: 1,
  Authenticating: 2, // Handshaking
  Initializing: 3, // Authed, need to spawn
  Initialized: 4 // play_status spawn sent by server, client responded with SetPlayerInit packet
}

class Connection extends EventEmitter {
  #status = ClientStatus.Disconnected
  sendQ = []
  batch = new Framer(this)
  firstOutboundPacketName = null

  get status() {
    return this.#status
  }

  set status(val) {
    this.emit('status', val)
    this.#status = val
  }

  startEncryption(iv) {
    if (this.disableEncryption) return
    this.encryptionEnabled = true
    this.decrypt = cipher.createDecryptor(this, iv)
    this.encrypt = cipher.createEncryptor(this, iv)
  }

  write(name, params) {
    if (!this.batch?.addEncodedPacket) return

    try {
      this.batch.addEncodedPacket(this.serializer.createPacketBuffer({ name, params }))
      if (!this.firstOutboundPacketName) {
        this.firstOutboundPacketName = name
        this.emit('packet_sent', { name, first: true })
      } else if (DIAGNOSTIC_PACKET_NAMES.has(name)) {
        this.emit('packet_sent', { name })
      }
    } catch (error) {
      console.log(error)
    }

    this.encryptionEnabled ? this.sendEncryptedBatch(this.batch) : this.sendDecryptedBatch(this.batch)
  }

  sendBuffer(buffer) {
    if (!this.batch?.addEncodedPacket) return

    try {
      this.batch.addEncodedPacket(buffer)
    } catch (error) {
      console.log(error)
    }

    this.encryptionEnabled ? this.sendEncryptedBatch(this.batch) : this.sendDecryptedBatch(this.batch)
  }

  sendDecryptedBatch(batch) {
    this.sendMCPE(batch.encode(), true)
  }

  sendEncryptedBatch(batch) {
    const buf = batch.getBuffer()
    this.encrypt(buf)
  }

  sendMCPE(buffer, immediate) {
      try {
        this.connection.sendReliable(buffer, immediate)
      } finally {
        this.batch.flush()
      }
  }

  // These are callbacks called from encryption.js
  onEncryptedPacket = (buf) => {
    this.sendMCPE(this.batchHeader ? Buffer.concat([Buffer.from([this.batchHeader]), buf]) : buf)
  }

  onDecryptedPacket = (buf) => {
    const packets = Framer.getPackets(buf)
    for (let i = 0; i < packets.length; i++) this.readPacket(packets[i])
  }

  handle(buffer) { // handle encapsulated
    if (!this.batchHeader || buffer[0] === this.batchHeader) { // wrapper
      if (this.encryptionEnabled) {
        this.decrypt(buffer.slice(1))
      } else {
        const packets = Framer.decode(this, buffer)
        for (let i = 0; i < packets.length; i++) this.readPacket(packets[i])
      }
    } else {
      throw Error('Bad packet header ' + buffer[0])
    }
  }
}

module.exports = { ClientStatus, Connection }
