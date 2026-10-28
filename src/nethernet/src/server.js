const dgram = require('node:dgram')
const os = require('node:os')
const { EventEmitter } = require('node:events')
const { Connection } = require('./connection')
const { PACKET_TYPE, createDeserializer, createSerializer } = require('./serializer')
const { SignalStructure, SignalType } = require('./signalling')
const { createAssertion, createPacketData, getRandomUint64, prepareSecurePacket, processSecurePacket } = require('./util')
const { RTCPeerConnection, RTCIceCandidate } = require('@roamhq/wrtc')

const PORT = 7551

const localAddresses = () => ['127.0.0.1', ...Object.values(os.networkInterfaces()).flat().filter((i) => i.family === 'IPv4').map((i) => i.address)]

class Server extends EventEmitter {
  constructor(networkId = getRandomUint64(), options = {}) {
    super()

    this.networkId = BigInt(networkId)
    this.port = options.port ?? PORT
    this.token = options.token
    this.ecdhKeyPair = options.ecdhKeyPair
    this.maxConnections = options.maxConnections ?? Infinity
    this.credentials = []

    this.serializer = createSerializer()
    this.deserializer = createDeserializer()

    this.advertisement = Buffer.alloc(0)
    this.addresses = new Map()
    this.connections = new Map()
    this.socket = null
  }

  listen() {
    const onMessage = (buffer, rinfo) => {
      try {
        this.processPacket(buffer, rinfo)
      } catch (e) {
        this.emit('error', e)
      }
    }

    // A game on this machine also listens on 7551, over IPv6, so we reach it through IPv6 loopback
    this.socket6 = dgram.createSocket({ type: 'udp6' })
    this.socket6.on('message', onMessage)
    this.socket6.on('error', (e) => this.emit('error', e))
    this.socket6.bind(0, '::1')

    return new Promise((resolve, reject) => {
      this.socket = dgram.createSocket({ type: 'udp4', reuseAddr: true })
      this.socket.on('message', onMessage)
      this.socket.once('error', reject)
      this.socket.bind(this.port, () => {
        this.socket.setBroadcast(true)
        this.socket.off('error', reject)
        this.socket.on('error', (e) => this.emit('error', e))
        resolve()
      })
    })
  }

  send(buffer, rinfo) {
    const local = rinfo.port === this.port && localAddresses().includes(rinfo.address)
    if (local || rinfo.family === 'IPv6') {
      this.socket6.send(buffer, rinfo.port, local ? '::1' : rinfo.address)
    } else {
      this.socket.send(buffer, rinfo.port, rinfo.address)
    }
  }

  setAdvertisement(buffer) {
    this.advertisement = buffer
  }

  processPacket(buffer, rinfo) {
    const packet = processSecurePacket(buffer, this.deserializer)
    const senderId = BigInt(packet.params.sender_id)
    if (senderId === this.networkId) return

    switch (packet.name) {
      case 'discovery_request':
        if (!this.addresses.has(senderId)) this.emit('discovery', senderId, rinfo)
        this.addresses.set(senderId, rinfo)
        this.sendDiscoveryResponse(rinfo)
        break
      case 'discovery_message': {
        if (BigInt(packet.params.recipient_id) !== this.networkId) return

        const data = packet.params.data
        if (data === 'Ping') return

        this.addresses.set(senderId, rinfo)

        const signal = SignalStructure.fromString(data)
        signal.networkId = senderId
        this.handleSignal(signal, (reply) => this.sendDiscoveryMessage(senderId, reply))
        break
      }
    }
  }

  /**
   * Handle a signal from a client
   * @param {SignalStructure} signal The signal from the client
   * @param {(signal: SignalStructure) => void} reply Sends a signal back to the client over the same channel it came from
   */
  handleSignal(signal, reply) {
    const id = String(signal.connectionId)

    switch (signal.type) {
      case SignalType.ConnectRequest:
        this.handleOffer(id, signal, reply).catch((e) => {
          this.emit('error', e)
          this.connections.get(id)?.close()
          this.connections.delete(id)
          reply(new SignalStructure(SignalType.ConnectError, signal.connectionId, 1, this.networkId, signal.serverNetworkId))
        })
        break
      case SignalType.CandidateAdd: {
        const peer = this.connections.get(id)
        if (!peer) return

        if (peer.rtcConnection.remoteDescription) {
          this.addCandidate(peer.rtcConnection, signal.data)
        } else {
          peer.pendingCandidates.push(signal.data)
        }
        break
      }
      case SignalType.ConnectError:
        this.connections.get(id)?.close()
        this.connections.delete(id)
        break
    }
  }

  async handleOffer(id, signal, reply) {
    if (this.connections.has(id)) return
    if (this.connections.size >= this.maxConnections) {
      reply(new SignalStructure(SignalType.ConnectError, signal.connectionId, 1, this.networkId, signal.serverNetworkId))
      return
    }

    const rtcConnection = new RTCPeerConnection({ iceServers: this.credentials, bundlePolicy: 'max-bundle' })
    const connection = new Connection({ emit: (event, buffer) => this.emit(event, buffer, id) }, id, rtcConnection)
    connection.pendingCandidates = []
    this.connections.set(id, connection)

    rtcConnection.ondatachannel = ({ channel }) => {
      switch (channel.label) {
        case 'ReliableDataChannel':
          connection.setChannels(channel, null)
          channel.onopen = () => {
            connection.flushQueue()
            this.emit('openConnection', connection)
          }
          break
        case 'UnreliableDataChannel':
          connection.setChannels(null, channel)
          break
      }
    }

    rtcConnection.onicecandidate = (event) => {
      if (!event.candidate) return

      const candidate = event.candidate.candidate
      if (candidate.includes('tcp') || candidate.includes('::1') || candidate.includes('127.0.0.1')) return

      reply(new SignalStructure(SignalType.CandidateAdd, signal.connectionId, candidate, this.networkId, signal.serverNetworkId))
    }

    rtcConnection.onconnectionstatechange = () => {
      const state = rtcConnection.connectionState

      switch (state) {
        case 'closed':
        case 'disconnected':
        case 'failed':
          if (this.connections.get(id) !== connection) return
          this.connections.delete(id)
          connection.close()
          this.emit('closeConnection', connection, state)
          break
      }
    }

    // The identity assertion is for us to check, the WebRTC stack doesn't understand it
    const offer = String(signal.data).replace(/^a=identity:.*\r?\n/m, '')
    await rtcConnection.setRemoteDescription({ type: 'offer', sdp: offer })

    for (const candidate of connection.pendingCandidates) this.addCandidate(rtcConnection, candidate)
    connection.pendingCandidates = []

    const answer = await rtcConnection.createAnswer()
    let sdp = answer.sdp.replace(/^o=.*$/m, `o=- ${this.networkId} 2 IN IP4 127.0.0.1`)

    const fingerprint = sdp.match(/^a=fingerprint:sha-256\s+(.*)$/m)
    if (fingerprint && this.token && this.ecdhKeyPair) {
      const assertion = await createAssertion(fingerprint[1], this.token, this.ecdhKeyPair)
      sdp = sdp.replace(/^(a=fingerprint:sha-256\s+.*)$/m, `$1\na=identity:${assertion}`)
    }

    await rtcConnection.setLocalDescription({ type: 'answer', sdp })

    reply(new SignalStructure(SignalType.ConnectResponse, signal.connectionId, sdp, this.networkId, signal.serverNetworkId))
  }

  addCandidate(rtcConnection, candidate) {
    rtcConnection.addIceCandidate(new RTCIceCandidate({ candidate: String(candidate).replace(/^a=/, ''), sdpMid: '0', sdpMLineIndex: 0 }))
      .catch((e) => this.emit('error', e))
  }

  sendDiscoveryResponse(rinfo) {
    const packetData = createPacketData('discovery_response', PACKET_TYPE.DISCOVERY_RESPONSE, this.networkId, {
      data: this.advertisement.toString('hex')
    })

    this.send(prepareSecurePacket(this.serializer, packetData), rinfo)
  }

  sendDiscoveryMessage(recipientId, signal) {
    const rinfo = this.addresses.get(recipientId)
    if (!rinfo || !this.socket) return

    const packetData = createPacketData('discovery_message', PACKET_TYPE.DISCOVERY_MESSAGE, this.networkId, {
      recipient_id: recipientId,
      data: signal.toString()
    })

    this.send(prepareSecurePacket(this.serializer, packetData), rinfo)
  }

  close() {
    for (const connection of this.connections.values()) connection.close()
    this.connections.clear()
    this.socket?.close()
    this.socket6?.close()
    this.socket = null
  }
}

module.exports = { Server }
