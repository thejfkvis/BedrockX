const dgram = require('node:dgram')
const dns = require('node:dns')
const crypto = require('node:crypto')
const { EventEmitter } = require('node:events')
const { Connection } = require('./connection')
const { PACKET_TYPE, createDeserializer, createSerializer } = require('./serializer')
const { SignalStructure, SignalType } = require('./signalling')
const { createPacketData, getRandomUint64, prepareSecurePacket, processSecurePacket } = require('./util')
const { RTCPeerConnection, RTCIceCandidate } = require('@roamhq/wrtc')
const { CompactSign, importPKCS8 } = require("jose");
const { decodeTokenMetadata } = require('../../identity')

const PORT = 7551
const BROADCAST_ADDRESS = '255.255.255.255'

class Client extends EventEmitter {
  constructor(networkId, broadcastAddress = BROADCAST_ADDRESS, token, identityPrivateKeyPEM = null) {
    super()

    this.serverNetworkId = networkId
    this.broadcastAddress = broadcastAddress
    this.token = token
    this.identityPrivateKeyPEM = identityPrivateKeyPEM
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
    this.aborted = false
    this.closed = false
    this.connectErrorReceived = false
    this.connectErrorCleanupLogged = false

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

    try {
      Promise.resolve(this.rtcConnection.addIceCandidate(new RTCIceCandidate(parsedData)))
        .then(() => {
          this.emit('diagnostic', { phase: 'rtc', message: 'Remote ICE candidate added successfully.' })
        })
        .catch((error) => {
          const message = typeof error?.message === 'string' ? error.message.slice(0, 160) : 'unknown error'
          this.emit('diagnostic', { phase: 'rtc', level: 'error', message: `ICE candidate add failed: ${message}.` })
          console.error("ICE:", error)
        })
    } catch (error) {
      const message = typeof error?.message === 'string' ? error.message.slice(0, 160) : 'unknown error'
      this.emit('diagnostic', { phase: 'rtc', level: 'error', message: `ICE candidate add failed: ${message}.` })
      console.error("ICE:", error)
    }
  }

  handleAnswer(signal) {
    if (!this.rtcConnection) return

    // Keep signaling payloads out of diagnostics; the SDP type and lifecycle
    // result are enough to troubleshoot the NetherNet handshake.
    const remoteDescription = { type: 'answer', sdp: signal.data }
    this.emit('diagnostic', { phase: 'rtc', message: 'Remote SDP received; type=answer.' })

    switch (this.rtcConnection.signalingState) {
      case "stable":
        this.emit('diagnostic', { phase: 'rtc', level: 'warn', message: 'Remote SDP not applied; signalingState=stable.' })
        console.error("Received answer in stable state, ignoring.")
        return
      case "closed":
        this.emit('diagnostic', { phase: 'rtc', level: 'warn', message: 'Remote SDP not applied; signalingState=closed.' })
        console.error("Received answer for closed connection, ignoring.")
        return
    }

    try {
      Promise.resolve(this.rtcConnection.setRemoteDescription(remoteDescription))
        .then(() => {
          const type = this.rtcConnection?.remoteDescription?.type || remoteDescription.type || 'unknown'
          this.emit('diagnostic', { phase: 'rtc', message: `Remote SDP applied successfully; type=${type}.` })
        })
        .catch((error) => {
          const message = typeof error?.message === 'string' ? error.message.slice(0, 160) : 'unknown error'
          this.emit('diagnostic', { phase: 'rtc', level: 'error', message: `Remote SDP apply failed; type=answer: ${message}.` })
          console.error("Failed to set remote description:", error)
        })
    } catch (error) {
      const message = typeof error?.message === 'string' ? error.message.slice(0, 160) : 'unknown error'
      this.emit('diagnostic', { phase: 'rtc', level: 'error', message: `Remote SDP apply failed; type=answer: ${message}.` })
      console.error("Failed to set remote description:", error)
    }
  }

  async createAssertion(fingerprint, token) {
    let pkcs8Key = this.identityPrivateKeyPEM
    let keySource = 'bedrock-client'
    if (!pkcs8Key) {
      const generated = crypto.generateKeyPairSync("ec", { namedCurve: "P-384", privateKeyEncoding: { type: "pkcs8", format: "pem" } })
      pkcs8Key = generated.privateKey
      keySource = 'generated-fallback'
    }

    const payload = JSON.stringify({ fingerprint: [{ algorithm: "sha-256", digest: fingerprint }] });

    const ecPrivateKey = await importPKCS8(pkcs8Key, "ES384");
    const encoder = new TextEncoder();

    const jws = await new CompactSign(encoder.encode(payload)).setProtectedHeader({ alg: "ES384" }).sign(ecPrivateKey);

    const parts = jws.split(".");
    const fingerprints = `${parts[0]}..${parts[2]}`;

    const data = {
      assertion: JSON.stringify({
        fingerprints,
        token
      }),
      idp: {
        domain: "https://authorization.franchise.minecraft-services.net/",
        protocol: "default",
      }
    }

    return {
      encoded: Buffer.from(JSON.stringify(data)).toString('base64'),
      keySource
    }
  }

  async createOffer() {
    this.emit('diagnostic', { phase: 'rtc', message: 'Creating NetherNet WebRTC offer.' })
    const tokenMetadata = decodeTokenMetadata(this.token)
    this.emit('diagnostic', {
      phase: 'identity',
      message: `NetherNet identity context: realm_network_id=${this.serverNetworkId || 'unknown'} local_network_id=${String(this.networkId)} connection_id=${String(this.connectionId)} token_present=${tokenMetadata.present ? 'yes' : 'no'} token_expiry=${tokenMetadata.expiry} token_audience=${tokenMetadata.audience} token_xuid=${tokenMetadata.xuid || 'unknown'}.`
    })
    void this.logIceServerDiagnostics()
    this.rtcConnection = new RTCPeerConnection({ iceServers: this.credentials, bundlePolicy: 'max-bundle' })
    this.connection = new Connection(this, this.connectionId, this.rtcConnection)
    this.localIceCandidateCount = 0
    this.iceGatheringSummaryLogged = false

    const reliable = this.rtcConnection.createDataChannel('ReliableDataChannel', { ordered: true })
    const unreliable = this.rtcConnection.createDataChannel('UnreliableDataChannel', { ordered: false, maxRetransmits: 0 })
    this.connection.setChannels(reliable, unreliable)

    const rtcStates = new Map()
    const reportRtcState = (name, value) => {
      const state = value || 'unknown'
      if (rtcStates.get(name) === state) return
      rtcStates.set(name, state)
      const level = ['failed', 'disconnected', 'closed'].includes(state) ? 'warn' : 'info'
      this.emit('diagnostic', { phase: 'rtc', level, message: `RTC ${name}: ${state}.` })
    }

    const reportIceGatheringSummary = () => {
      if (this.iceGatheringSummaryLogged) return
      this.iceGatheringSummaryLogged = true
      const state = this.rtcConnection?.iceGatheringState || 'unknown'
      const count = this.localIceCandidateCount || 0
      this.emit('diagnostic', {
        phase: 'rtc',
        message: `Final ICE gathering state: ${state}; local candidates=${count}; produced=${count > 0 ? 'yes' : 'no'}.`
      })
    }
    this.reportIceGatheringSummary = reportIceGatheringSummary

    this.rtcConnection.onsignalingstatechange = () => reportRtcState('signalingState', this.rtcConnection?.signalingState)
    this.rtcConnection.onicegatheringstatechange = () => {
      const state = this.rtcConnection?.iceGatheringState
      reportRtcState('iceGatheringState', state)
      if (state === 'complete') reportIceGatheringSummary()
    }
    this.rtcConnection.oniceconnectionstatechange = () => reportRtcState('iceConnectionState', this.rtcConnection?.iceConnectionState)
    this.rtcConnection.onconnectionstatechange = () => {
      const state = this.rtcConnection?.connectionState
      reportRtcState('connectionState', state)

      switch (state) {
        case "closed":
        case "disconnected":
        case "failed":
          this.emit('disconnect', this.connectionId, state)
          break;
      }
    }

    this.rtcConnection.onicecandidate = (event) => {
      if (this.aborted || this.connectErrorReceived || !this.running) return

      if (!event.candidate) {
        if (this.rtcConnection?.iceGatheringState === 'complete') reportIceGatheringSummary()
        return
      }

      this.localIceCandidateCount += 1

      if (event.candidate.candidate.includes("tcp") || event.candidate.candidate.includes("::1") || event.candidate.candidate.includes("127.0.0.1")) return;

      this.signalHandler(new SignalStructure(SignalType.CandidateAdd, this.connectionId, event.candidate.candidate, this.networkId, this.serverNetworkId))
    }

    this.rtcConnection.onicecandidateerror = (event) => {
      const endpoint = parseIceEndpoint(event?.url)
      const hostname = endpoint?.hostname || 'unknown'
      const address = event?.address || 'unknown'
      const port = event?.port ?? 'unknown'
      const code = event?.errorCode !== undefined ? ` code=${String(event.errorCode)}` : ''
      const text = typeof event?.errorText === 'string' ? `: ${event.errorText.replace(/\s+/g, ' ').slice(0, 160)}` : ''
      this.emit('diagnostic', { phase: 'rtc', level: 'error', message: `ICE candidate error: url_hostname=${hostname} address=${address} port=${port}${code}${text}.` })
    }

    const offer = await this.rtcConnection.createOffer()
    const baseSdp = offer.sdp ?? ''
    this.emit('diagnostic', { phase: 'rtc', message: `Local SDP created; type=${offer.type || 'unknown'}.` })

    const fingerprint = baseSdp.match(/^a=fingerprint:sha-256\s+(.*)$/m);
    const fingerprintValue = fingerprint?.[1] || '';

    let sdp = baseSdp.replace(/^o=.*$/m, `o=- ${this.networkId} 2 IN IP4 127.0.0.1`);

    if (fingerprintValue) {
      const assertion = await this.createAssertion(fingerprintValue, this.token);

      sdp = sdp.replace(/^(a=fingerprint:sha-256\s+.*)$/m, `$1\na=identity:${assertion.encoded}`);
      this.emit('diagnostic', {
        phase: 'identity',
        message: `NetherNet offer identity fields: idp_domain=present idp_protocol=default fingerprint=present assertion=present assertion_token=${tokenMetadata.present ? 'present' : 'missing'} assertion_key_source=${assertion.keySource} assertion_key_matches_session_public_key=${assertion.keySource === 'bedrock-client' ? 'yes' : 'no'} token_expiry=${tokenMetadata.expiry} token_audience=${tokenMetadata.audience}.`
      })
    } else {
      this.emit('diagnostic', { phase: 'identity', level: 'error', message: 'NetherNet offer identity fields: fingerprint=missing assertion=not-created.' })
    }

    const localDescription = { type: offer.type, sdp }

    await this.rtcConnection.setLocalDescription(localDescription);
    this.emit('diagnostic', { phase: 'rtc', message: `Local SDP applied; type=${this.rtcConnection.localDescription?.type || localDescription.type || 'unknown'}.` })
    this.emit('diagnostic', { phase: 'rtc', message: 'Submitting local SDP offer via NetherNet signaling.' })
    this.emit('diagnostic', { phase: 'signaling', message: `NetherNet CONNECTREQUEST fields: connection_id=present network_id=present server_network_id=present message=present.` })

    if (this.aborted || this.closed) return
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
    if (this.aborted || this.connectErrorReceived) return

    switch (signal.type) {
      case SignalType.ConnectResponse:
        this.handleAnswer(signal)
        break
      case SignalType.CandidateAdd:
        if (signal.networkId === this.serverNetworkId) signal.networkId = this.networkId
        
        this.handleCandidate(signal)
        break
      case SignalType.ConnectError: {
        this.connectErrorReceived = true
        // Stop producers before notifying higher layers; queued ICE callbacks
        // must not reach the signaling writer during error propagation.
        this.aborted = true
        const metadata = decodeConnectError(signal)
        const summary = formatConnectErrorMetadata(metadata)
        this.emit('diagnostic', {
          phase: 'signaling',
          level: 'error',
          message: `NetherNet CONNECTERROR received: ${summary}.`
        })
        // The wrapper/client listener turns this into a caller-visible error and
        // destroys the signaling/WebRTC resources. Keep a local fallback so a
        // low-level client used without the wrapper still stops immediately.
        try {
          this.emit('connect_error', metadata)
        } finally {
          this.close(metadata.reason || 'NetherNet CONNECTERROR')
        }
        break
      }
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
    this.emit('diagnostic', { phase: 'rtc', message: 'Starting NetherNet WebRTC negotiation.' })

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
    if (this.closed) return
    this.closed = true
    this.aborted = true

    const hadResources = this.running || Boolean(this.pingInterval) || Boolean(this.connection) || Boolean(this.socket)
    this.reportIceGatheringSummary?.()
    if (this.connectErrorReceived && !this.connectErrorCleanupLogged) {
      this.connectErrorCleanupLogged = true
      this.emit('diagnostic', { phase: 'signaling', message: 'CONNECTERROR cleanup: discovery ping stopped; WebRTC channels and peer connection closing.' })
    }
    if (this.pingInterval) {
      clearInterval(this.pingInterval)
      this.pingInterval = null
    }
    // @roamhq/wrtc can deliver an already-queued ICE callback after close().
    // Detach it before closing the peer connection so it cannot signal a stale
    // candidate into a torn-down WebSocket.
    if (this.rtcConnection) {
      this.rtcConnection.onicecandidate = null
      this.rtcConnection.onicecandidateerror = null
      this.rtcConnection.onsignalingstatechange = null
      this.rtcConnection.onicegatheringstatechange = null
      this.rtcConnection.oniceconnectionstatechange = null
      this.rtcConnection.onconnectionstatechange = null
    }
    this.connection?.close()
    try {
      this.socket?.close()
    } catch {}
    this.connection = null
    this.running = false
    if (hadResources) this.removeAllListeners()
  }
}

const CONNECT_ERROR_ALIASES = {
  code: new Set(['code', 'errorcode', 'error_code', 'statuscode', 'status_code']),
  reason: new Set(['reason', 'message', 'error', 'errormessage', 'error_message', 'description']),
  retryable: new Set(['retryable', 'retry', 'canretry', 'can_retry', 'isretryable', 'is_retryable']),
  protocol: new Set(['protocol', 'requiredprotocol', 'protocolrequired', 'protocol_requirement', 'protocolrequirement']),
  version: new Set(['version', 'protocolversion', 'requiredversion', 'requiredprotocolversion', 'minimumversion', 'minversion', 'minimumprotocolversion', 'minprotocolversion', 'maximumversion', 'maxversion', 'maximumprotocolversion', 'maxprotocolversion'])
}

// Standard NetherNet CONNECTERROR data is the numeric error-code field. Keep
// this diagnostic-only map local; it does not alter the Bedrock protocol.
const NETHERNET_CONNECT_ERROR_REASONS = new Map([
  [0, 'None'],
  [1, 'Destination not logged in'],
  [2, 'Negotiation timeout'],
  [3, 'Wrong transport version'],
  [4, 'Failed to create peer connection'],
  [5, 'ICE failure'],
  [6, 'Connect request failed'],
  [7, 'Connect response failed'],
  [8, 'Candidate add failed'],
  [9, 'Inactivity timeout'],
  [10, 'Failed to create offer'],
  [11, 'Failed to create answer'],
  [12, 'Failed to set local description'],
  [13, 'Failed to set remote description'],
  [14, 'Negotiation timeout waiting for response'],
  [15, 'Negotiation timeout waiting for accept'],
  [16, 'Incoming connection ignored'],
  [17, 'Signaling parsing failure'],
  [18, 'Signaling unknown error'],
  [19, 'Signaling unicast message delivery failed'],
  [20, 'Signaling broadcast delivery failed'],
  [21, 'Signaling message delivery failed'],
  [22, 'Signaling TURN auth failed'],
  [23, 'Signaling fallback to best-effort delivery'],
  [24, 'No signaling channel'],
  [25, 'Not logged in'],
  [26, 'Signaling failed to send'],
  [37, 'Identity verification failed']
])

function decodeConnectError(signal) {
  const raw = typeof signal?.data === 'string' ? signal.data.trim() : ''
  let root = null
  let format = 'text'

  if (raw) {
    try {
      root = JSON.parse(raw)
      format = 'json'
    } catch {
      root = parseConnectErrorText(raw)
    }
  }

  if (typeof root === 'number' && Number.isFinite(root)) {
    root = { code: root }
    format = 'numeric-code'
  } else if (typeof root === 'string' && /^\d+$/.test(root.trim())) {
    root = { code: Number(root.trim()) }
    format = 'numeric-code'
  } else if (/^\d+(?:\s+.+)?$/.test(raw)) {
    const [, code, message] = raw.match(/^(\d+)(?:\s+(.+))?$/) || []
    root = { code: Number(code), ...(message ? { message } : {}) }
    format = 'numeric-code'
  }

  if (typeof root === 'string') root = { message: root }
  if (!root || typeof root !== 'object') root = { message: raw }

  const codeMatch = findMetadataValue(root, CONNECT_ERROR_ALIASES.code)
  const reasonMatch = findMetadataValue(root, CONNECT_ERROR_ALIASES.reason)
  const retryMatch = findMetadataValue(root, CONNECT_ERROR_ALIASES.retryable)
  const protocolMatch = findMetadataValue(root, CONNECT_ERROR_ALIASES.protocol)
  const versionMatch = findMetadataValue(root, CONNECT_ERROR_ALIASES.version)
  const statusMatch = findMetadataNode(root, new Set(['status', 'statusinfo', 'status_info', 'statusdetails', 'status_details']))

  const statusFields = statusMatch
    ? collectMetadataFields(statusMatch.value, 'status', 0)
    : []
  const requirementFields = []
  if (protocolMatch) requirementFields.push(`protocol=${safeMetadataScalar(protocolMatch.value)}`)
  if (versionMatch) requirementFields.push(`version=${safeMetadataScalar(versionMatch.value)}`)

  const numericCode = Number(codeMatch?.value)
  const knownReason = Number.isInteger(numericCode) ? NETHERNET_CONNECT_ERROR_REASONS.get(numericCode) : ''
  const reason = safeMetadataText(reasonMatch?.value, 240) || knownReason || 'Unknown CONNECTERROR reason'
  const metadata = {
    code: safeMetadataScalar(codeMatch?.value) || 'unknown',
    reason,
    statusFields,
    requirementFields,
    retryable: parseRetryable(retryMatch?.value),
    deliveryId: safeMetadataText(signal?.deliveryId, 80) || 'none',
    schemaPath: safeMetadataText(signal?.signalingPath, 180) || 'SignalStructure.data',
    schema: format === 'numeric-code' ? 'CONNECTERROR <connectionId> <errorCode>' : format === 'json' ? 'CONNECTERROR <connectionId> <metadata>' : 'CONNECTERROR <connectionId> <errorData>',
    format
  }

  // Keep a bounded, non-sensitive metadata object. Never retain the original
  // CONNECTERROR data after parsing.
  return metadata
}

function formatConnectErrorMetadata(metadata) {
  const fields = [
    `schema=${metadata.schema}`,
    `path=${metadata.schemaPath}`,
    `delivery_id=${metadata.deliveryId}`,
    `code=${metadata.code}`,
    `reason=${metadata.reason}`
  ]
  fields.push(metadata.statusFields.length ? `status=${metadata.statusFields.join(',')}` : 'status=none')
  fields.push(metadata.requirementFields.length ? metadata.requirementFields.join(' ') : 'requirements=none')
  fields.push(`retryable=${metadata.retryable === null ? 'unknown' : metadata.retryable ? 'yes' : 'no'}`)
  return fields.join(' ')
}

function parseConnectErrorText(raw) {
  const parsed = {}
  const pairPattern = /(?:^|\s)([A-Za-z][\w.-]*)\s*[:=]\s*("[^"]*"|'[^']*'|[^\s]+)/g
  let match
  while ((match = pairPattern.exec(raw))) {
    const key = match[1]
    const value = match[2].replace(/^("|')|("|')$/g, '')
    parsed[key] = value
  }
  if (!Object.keys(parsed).length) parsed.message = raw
  return parsed
}

function findMetadataValue(root, aliases) {
  const node = findMetadataNode(root, aliases)
  if (!node) return null
  if (typeof node.value === 'object' && node.value !== null) return findMetadataValue(node.value, aliases)
  if (node.value === null) return null
  return node
}

function findMetadataNode(root, aliases) {
  const seen = new Set()
  const visit = (value, path, depth) => {
    if (value === null || value === undefined || depth > 4) return null
    if (typeof value !== 'object') return null
    if (seen.has(value)) return null
    seen.add(value)

    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index++) {
        const found = visit(value[index], `${path}[${index}]`, depth + 1)
        if (found) return found
      }
      return null
    }

    for (const [key, child] of Object.entries(value)) {
      const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '')
      const childPath = path ? `${path}.${key}` : key
      if (aliases.has(normalized)) return { value: child, path: childPath }
      const found = visit(child, childPath, depth + 1)
      if (found) return found
    }
    return null
  }

  return visit(root, '', 0)
}

function collectMetadataFields(value, prefix, depth) {
  if (value === null || value === undefined || depth > 2) return []
  if (typeof value !== 'object') {
    const scalar = safeMetadataScalar(value)
    return scalar ? [`${prefix}=${scalar}`] : []
  }

  const fields = []
  const allowed = new Set([
    'code', 'errorcode', 'reason', 'message', 'state', 'status', 'retryable',
    'retry', 'canretry', 'protocol', 'version', 'requiredprotocol',
    'requiredversion', 'requiredprotocolversion', 'minversion', 'maxversion',
    'minimumprotocolversion', 'minprotocolversion', 'maximumprotocolversion',
    'maxprotocolversion'
  ])
  for (const [key, child] of Object.entries(value)) {
    const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '')
    const path = `${prefix}.${key}`
    if (allowed.has(normalized) && typeof child !== 'object') {
      const scalar = safeMetadataScalar(child)
      if (scalar) fields.push(`${path}=${scalar}`)
    } else if (typeof child === 'object') {
      fields.push(...collectMetadataFields(child, path, depth + 1))
    }
  }
  return fields.slice(0, 12)
}

function parseRetryable(value) {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  if (typeof value !== 'string') return null
  const normalized = value.trim().toLowerCase()
  if (['true', 'yes', 'y', '1', 'retry'].includes(normalized)) return true
  if (['false', 'no', 'n', '0', 'fatal', 'nonretryable'].includes(normalized)) return false
  return null
}

function safeMetadataScalar(value) {
  if (value === null || value === undefined) return ''
  if (typeof value === 'object') return ''
  return safeMetadataText(value, 120)
}

function safeMetadataText(value, limit = 160) {
  if (value === null || value === undefined) return ''
  const text = String(value).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()
  if (!text) return ''
  // Error metadata may be echoed by a service; avoid carrying obvious secrets
  // or an SDP-looking value into diagnostics/UI logs.
  if (/^(?:eyJ|v=0\s|-----BEGIN|Bearer\s)/i.test(text) || /(?:token|password|credential|authorization|access[_ -]?token|jwt|sdp)\s*[:=]/i.test(text)) return '[redacted]'
  return text.slice(0, limit)
}

function createConnectError(metadata) {
  const error = new Error(`NetherNet CONNECTERROR: ${metadata.reason || 'Unknown reason'} (code=${metadata.code || 'unknown'})`)
  error.name = 'NethernetConnectError'
  error.code = metadata.code
  error.reason = metadata.reason
  error.statusFields = metadata.statusFields
  error.requirementFields = metadata.requirementFields
  error.retryable = metadata.retryable
  error.deliveryId = metadata.deliveryId
  error.schemaPath = metadata.schemaPath
  return error
}

function parseIceEndpoint(rawUrl) {
  if (typeof rawUrl !== 'string') return null

  const match = rawUrl.trim().match(/^(?<scheme>stuns?|turns?):(?:(?:\/\/)?)(?<authority>[^\/?#]+)/i)
  if (!match?.groups) return null

  const scheme = match.groups.scheme.toLowerCase()
  let authority = match.groups.authority
  const atIndex = authority.lastIndexOf('@')
  if (atIndex >= 0) authority = authority.slice(atIndex + 1)

  let hostname = authority
  let port = 'unspecified'
  if (authority.startsWith('[')) {
    const closeIndex = authority.indexOf(']')
    if (closeIndex > 0) {
      hostname = authority.slice(1, closeIndex)
      if (authority[closeIndex + 1] === ':' && /^\d+$/.test(authority.slice(closeIndex + 2))) {
        port = Number(authority.slice(closeIndex + 2))
      }
    }
  } else {
    const colonIndex = authority.lastIndexOf(':')
    if (colonIndex > 0 && /^\d+$/.test(authority.slice(colonIndex + 1))) {
      hostname = authority.slice(0, colonIndex)
      port = Number(authority.slice(colonIndex + 1))
    }
  }

  return { scheme, hostname: hostname || 'unknown', port }
}

async function lookupIceFamily(hostname, family) {
  if (!hostname || hostname === 'unknown') return 'invalid-hostname'

  try {
    const entries = await dns.promises.lookup(hostname, { all: true, family, verbatim: true })
    const addresses = entries.map((entry) => entry.address).filter(Boolean)
    return addresses.length ? addresses.join(',') : 'no-address'
  } catch (error) {
    return `error=${error?.code || 'unknown'}`
  }
}

Client.prototype.logIceServerDiagnostics = async function logIceServerDiagnostics() {
  const servers = Array.isArray(this.credentials) ? this.credentials : []
  const endpoints = []
  const seen = new Set()

  for (const server of servers) {
    const urls = Array.isArray(server?.urls) ? server.urls : [server?.urls]
    for (const rawUrl of urls) {
      const endpoint = parseIceEndpoint(rawUrl)
      const key = endpoint ? `${endpoint.scheme}|${endpoint.hostname}|${endpoint.port}` : 'unknown|unknown|unknown'
      const safeEndpoint = endpoint || { scheme: 'unknown', hostname: 'unknown', port: 'unknown' }
      this.emit('diagnostic', {
        phase: 'rtc',
        message: `ICE server configured: scheme=${safeEndpoint.scheme} hostname=${safeEndpoint.hostname} port=${safeEndpoint.port}.`
      })
      if (seen.has(key)) continue
      seen.add(key)
      endpoints.push(safeEndpoint)
    }
  }

  await Promise.all(endpoints.map(async (endpoint) => {
    const [ipv4, ipv6] = await Promise.all([
      lookupIceFamily(endpoint.hostname, 4),
      lookupIceFamily(endpoint.hostname, 6)
    ])
    this.emit('diagnostic', { phase: 'rtc', message: `ICE DNS IPv4 lookup: hostname=${endpoint.hostname} result=${ipv4}.` })
    this.emit('diagnostic', { phase: 'rtc', message: `ICE DNS IPv6 lookup: hostname=${endpoint.hostname} result=${ipv6}.` })
  }))
}

module.exports = { Client, decodeConnectError, createConnectError, formatConnectErrorMetadata }
