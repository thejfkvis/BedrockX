const dgram = require('node:dgram')
const { EventEmitter } = require('node:events')
const { Connection } = require('./connection')
const { PACKET_TYPE, createDeserializer, createSerializer } = require('./serializer')
const { SignalStructure, SignalType } = require('./signalling')
const { createPacketData, getRandomUint64, prepareSecurePacket, processSecurePacket } = require('./util')
const { RTCPeerConnection, RTCIceCandidate } = require('@roamhq/wrtc')

const PORT = 7551
const BROADCAST_ADDRESS = '255.255.255.255'

class Client extends EventEmitter {
  constructor(networkId, broadcastAddress = BROADCAST_ADDRESS) {
    super()

    this.serverNetworkId = networkId
    this.broadcastAddress = broadcastAddress
    this.networkId = getRandomUint64()
    this.connectionId = getRandomUint64()
    this.socket = dgram.createSocket('udp4')
    this.socket.on('message', (buffer, rinfo) => this.processPacket(buffer, rinfo))
    this.socket.bind(() => this.socket.setBroadcast(true))

    this.serializer = createSerializer()
    this.deserializer = createDeserializer()

    this.responses = new Map()
    this.addresses = new Map()
    this.credentials = []
    this.signalHandler = this.sendDiscoveryMessage

    this.running = false

    this.sendDiscoveryRequest()

    this.pingInterval = setInterval(() => this.sendDiscoveryRequest(), 2000);
  }

  handleCandidate(signal) {
    const rawData = typeof signal.data === 'string' ? signal.data : signal.data.candidate;

    const parts = rawData.replace(/^candidate:/, "").trim().split(" ");

    const parsedData = {
      candidate: signal.data,
      foundation: parts[0],
      component: parseInt(parts[1]),
      protocol: parts[2],
      priority: parseInt(parts[3]),
      address: parts[4],
      port: parseInt(parts[5]),
      type: parts[7],
      sdpMid: signal.data.sdpMid || "0",
      sdpMLineIndex: signal.data.sdpMLineIndex ?? 0
    };

    if (parts[8] === "raddr") parsedData.relatedAddress = parts[9];
    if (parts[10] === "rport") parsedData.relatedPort = parseInt(parts[11]);

    const ufragIndex = parts.indexOf("ufrag");
    if (ufragIndex !== -1) parsedData.usernameFragment = parts[ufragIndex + 1];

    this.rtcConnection.addIceCandidate(new RTCIceCandidate(parsedData)).catch(e => console.error("ICE:", e));
  }

  handleAnswer(signal) {
    this.rtcConnection.setRemoteDescription({ type: 'answer', sdp: signal.data })
  }

  async createOffer() {
    this.rtcConnection = new RTCPeerConnection({ iceServers: this.credentials })
    this.connection = new Connection(this, this.connectionId, this.rtcConnection)

    const reliable = this.rtcConnection.createDataChannel('ReliableDataChannel', { ordered: true })
    const unreliable = this.rtcConnection.createDataChannel('UnreliableDataChannel', { ordered: false, maxRetransmits: 0 })
    this.connection.setChannels(reliable, unreliable)

    this.rtcConnection.onicecandidate = (event) => {
      if (!event.candidate) return

      if (event.candidate.candidate.includes("tcp") || event.candidate.candidate.includes("::1") || event.candidate.candidate.includes("127.0.0.1")) return;

      this.signalHandler(new SignalStructure(SignalType.CandidateAdd, this.connectionId, event.candidate.candidate, this.networkId, this.serverNetworkId))
    }

    this.rtcConnection.onconnectionstatechange = () => {
      switch (this.rtcConnection?.connectionState) {
        case "connected":
          this.emit('connected', this.connection)
          break;
        case "closed":
        case "disconnected":
        case "failed":
          this.emit('disconnect', this.connectionId, 'disconnected')
      }
    }

    const offer = await this.rtcConnection.createOffer()
    const baseSdp = offer.sdp ?? ''
    const sdp = baseSdp.replace(/^o=.*$/m, `o=- ${this.networkId} 2 IN IP4 127.0.0.1`)
    const localDescription = { type: offer.type, sdp }

    await this.rtcConnection.setLocalDescription(localDescription);

    this.signalHandler(new SignalStructure(SignalType.ConnectRequest, this.connectionId, sdp, this.networkId, this.serverNetworkId))
  }

  processPacket(buffer, rinfo) {
    const parsedPacket = processSecurePacket(buffer, this.deserializer)

    switch (parsedPacket.name) {
      case 'discovery_request':
        break
      case 'discovery_response':
        this.handleResponse(parsedPacket, rinfo)
        break
      case 'discovery_message':
        this.handleMessage(parsedPacket)
        break
      default:
        throw new Error('Unknown packet type')
    }
  }

  handleResponse(packet, rinfo) {
    const senderId = BigInt(packet.params.sender_id)
    this.addresses.set(senderId, rinfo)
    this.responses.set(senderId, packet.params)
    this.emit('pong', packet.params)
  }

  handleMessage(packet) {
    const data = packet.params.data
    if (data === 'Ping') return

    const signal = SignalStructure.fromString(data)
    signal.networkId = BigInt(packet.params.sender_id)

    this.handleSignal(signal)
  }

  handleSignal(signal) {
    switch (signal.type) {
      case SignalType.ConnectResponse:
        this.handleAnswer(signal)
        break
      case SignalType.CandidateAdd:
        if (signal.networkId === this.serverNetworkId) signal.networkId = this.networkId
        
        this.handleCandidate(signal)
        break
    }
  }

  sendDiscoveryRequest() {
    const packetData = createPacketData('discovery_request', PACKET_TYPE.DISCOVERY_REQUEST, this.networkId)
    const packetToSend = prepareSecurePacket(this.serializer, packetData)
    this.socket.send(packetToSend, PORT, this.broadcastAddress)
  }

  sendDiscoveryMessage(signal) {
    const rinfo = this.addresses.get(BigInt(signal.networkId))
    if (!rinfo) return

    const packetData = createPacketData('discovery_message', PACKET_TYPE.DISCOVERY_MESSAGE, this.networkId, {
      recipient_id: BigInt(signal.networkId),
      data: signal.toString()
    })

    const packetToSend = prepareSecurePacket(this.serializer, packetData)
    this.socket.send(packetToSend, rinfo.port, rinfo.address)
  }

  async connect() {
    this.running = true

    await this.createOffer()
  }

  send(buffer) {
    this.connection.send(buffer)
  }

  ping() {
    this.running = true

    this.sendDiscoveryRequest()
  }

  close(reason) {
    if (!this.running) return
    clearInterval(this.pingInterval)
    this.connection?.close()
    this.socket.close()
    this.connection = null
    this.running = false
    this.removeAllListeners()
  }
}

module.exports = { Client }