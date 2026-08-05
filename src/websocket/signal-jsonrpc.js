const { EventEmitter, once } = require('node:events')
const { WebSocket } = require('ws')
const { SignalStructure } = require('../nethernet/index')
const { v4fast: v4 } = require("uuid-1345")
const JSONBigInt = require('json-bigint')({ useNativeBigInt: true })
const { decodeTokenMetadata } = require('../identity')

const MAX_RETRIES = 5

class NethernetJSONRPC extends EventEmitter {
    constructor(networkId, authflow, version, serverNetworkId) {
        super()
        this.networkId = networkId
        this.serverNetworkId = serverNetworkId
        this.authflow = authflow
        this.version = version
        this.ws = null
        this.credentials = []
        this.candidates = []
        this.signalCandidates = []

        this.pingInterval = null
        this.retryCount = 0
        this.destroyed = false
        this.aborted = false
        this.lateCandidateIgnoredLogged = false
        this.lastLiveness = 0
        this.connectionId = null
        this.didSendCandidates = false
        this.pendingOfferRequests = new Set()
        this.pendingRequests = new Map()
        this.offerSubmitted = false
        this.wsGeneration = 0
    }

    trackRequest(id, label) {
        if (id === undefined || id === null) return
        this.pendingRequests.set(String(id), label)
    }

    traceIncoming(message) {
        const summary = summarizeIncomingMessage(message)
        const requestId = safeRequestId(message?.id)
        const pending = requestId !== 'none' ? this.pendingRequests.get(requestId) : undefined
        this.emit("diagnostic", {
            phase: "signaling",
            message: `Incoming JSON-RPC: method=${summary.method} events=${summary.events.join('|') || 'none'} id=${requestId} pending=${pending || 'none'} sdp_answer=${summary.hasSdpAnswer ? 'yes' : 'no'} remote_ice=${summary.hasRemoteIceCandidate ? 'yes' : 'no'}.`
        })
        return { summary, requestId, pending }
    }

    async connect() {
        if (this.ws?.readyState === WebSocket.OPEN) throw new Error('Already connected signaling server');
        this.destroyed = false

        await this.init()
        await Promise.race([
            once(this, "credentials"),
            new Promise((_, reject) => setTimeout(() => reject(), 15000))
        ])
    }

    async destroy(resume = false) {
        if (this.aborted) return
        if (!resume) this.aborted = true
        this.destroyed = !resume

        if (this.pingInterval) {
            clearInterval(this.pingInterval)
            this.pingInterval = null
            this.emit("diagnostic", { phase: "signaling", message: "JSON-RPC signaling ping timer stopped." })
        }

        const ws = this.ws
        this.ws = null
        this.pendingRequests.clear()
        this.pendingOfferRequests.clear()

        if (ws) {
            this.emit("diagnostic", { phase: "signaling", message: `JSON-RPC WebSocket listeners removing (generation=${this.wsGeneration}).` })
            ws.removeAllListeners("open")
            ws.removeAllListeners("close")
            ws.removeAllListeners("error")
            ws.removeAllListeners("message")
            this.emit("diagnostic", { phase: "signaling", message: `JSON-RPC WebSocket listeners removed (generation=${this.wsGeneration}).` })

            if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
                await new Promise((resolve) => {
                    const done = () => resolve()

                    ws.once("close", done)

                    try {
                        ws.close(1000, "Normal Closure")
                    } catch {
                        resolve()
                    }
                })
            }
        }

        if (resume) return this.reconnectWithBackoff()
    }

    async reconnectWithBackoff() {
        if (this.retryCount >= MAX_RETRIES) {
            this.emit("error", new Error("Signal reconnection failed after max retries"));
            return;
        }

        await new Promise((r) => setTimeout(r, 15000));

        try {
            await this.init();
        } catch (e) { }
    }

    async init() {
        const xbl = await this.authflow.getMinecraftBedrockServicesToken({ version: this.version })
        const tokenMetadata = decodeTokenMetadata(xbl?.mcToken)
        const authDiagnostics = this.authflow.getIdentityDiagnostics?.() || {}
        this.emit("diagnostic", {
            phase: "identity",
            message: `NetherNet signaling authentication: authorization=${tokenMetadata.present ? 'present' : 'missing'} source=${authDiagnostics.minecraftServices?.source || 'unknown'} expiry=${tokenMetadata.expiry} audience=${tokenMetadata.audience} xuid=${authDiagnostics.minecraftServices?.xuid || 'unknown'} relying_party=${authDiagnostics.minecraftServices?.relyingParty || 'unknown'}.`
        })

        const address = `https://signal.franchise.minecraft-services.net/ws/v1.0/messaging/connect`;
        this.emit("diagnostic", { phase: "identity", message: "NetherNet signaling WebSocket auth fields: authorization=present session-id=present request-id=present." })

        try {
            const ws = new WebSocket(address, { headers: { Authorization: xbl.mcToken, "session-id": v4(), "request-id": v4() } })
            this.ws = ws
            this.lastLiveness = Date.now()
            this.wsGeneration += 1
            const generation = this.wsGeneration

            ws.on("open", () => this.onOpen())
            ws.on("close", (code, reason) => this.onClose(code, reason.toString()))
            ws.on("error", (err) => this.onError(err))
            ws.on("message", (data) => this.onMessage(data))
            this.emit("diagnostic", { phase: "signaling", message: `JSON-RPC WebSocket listeners attached (generation=${generation}).` })

            if (!this.pingInterval) {
                this.pingInterval = setInterval(() => {
                    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return

                    const requestId = v4()
                    this.trackRequest(requestId, "System_Ping_v1_0")
                    this.ws.send(JSON.stringify({ params: {}, jsonrpc: "2.0", method: "System_Ping_v1_0", id: requestId }))

                    if (Date.now() - this.lastLiveness > 60000) {
                        try {
                            this.ws.terminate?.()
                        } catch { }
                    }
                }, 2000)
            }
        } catch (error) {
            this.emit("error", error)
        }
    }

    onOpen() {
        this.retryCount = 0
        this.lastLiveness = Date.now()
        this.emit("diagnostic", { phase: "signaling", message: "JSON-RPC signaling WebSocket opened." })
        const requestId = v4()
        this.trackRequest(requestId, "Signaling_TurnAuth_v1_0")
        this.ws.send(JSON.stringify({
            params: {},
            jsonrpc: "2.0",
            method: "Signaling_TurnAuth_v1_0",
            id: requestId
        }))
    }

    onError(err) {
        const message = typeof err?.message === "string" ? err.message.slice(0, 160) : "unknown error"
        this.emit("diagnostic", { phase: "signaling", level: "error", message: `JSON-RPC signaling WebSocket error: ${message}.` })
        this.emit("error", err instanceof Error ? err : new Error(message))
    }

    async onClose(code, reason) {
        this.emit("diagnostic", { phase: "signaling", level: "warn", message: `JSON-RPC signaling WebSocket closed (${code}${reason ? `: ${String(reason).slice(0, 160)}` : ""}).` })
        if (this.ws === null && this.pingInterval) {
            clearInterval(this.pingInterval)
            this.pingInterval = null
        }

        if (this.destroyed) return

        // 1006 closure
        // 1011 error
        // 4401 unauthorized
        const retryable = [1000, 1006, 1011, 4401].includes(code) || code === 0

        if (retryable && this.retryCount < MAX_RETRIES) {
            this.retryCount++
            await this.destroy(true)
        } else {
            await this.destroy(false)
            this.emit("error", new Error(`Signal closed: ${code} ${reason}`))
        }
    }

    onMessage(res) {
        if (this.destroyed) return
        this.lastLiveness = Date.now()

        let message = null

        try {
            if (typeof res === "string") {
                message = JSON.parse(res)
            } else if (Buffer.isBuffer(res)) {
                message = JSON.parse(res.toString("utf8"))
            } else {
                if (this.offerSubmitted) this.emit("diagnostic", { phase: "signaling", level: "warn", message: "Incoming JSON-RPC message ignored: unsupported data type." })
                return
            }
        } catch (error) {
            if (this.offerSubmitted) this.emit("diagnostic", { phase: "signaling", level: "error", message: "Incoming JSON-RPC message: parse_failed handled=no." })
            this.emit("diagnostic", { phase: "signaling", level: "error", message: "JSON-RPC signaling message could not be parsed." })
            return
        }

        const trace = this.offerSubmitted ? this.traceIncoming(message) : null
        const requestId = safeRequestId(message?.id)
        const pending = requestId !== 'none' ? this.pendingRequests.get(requestId) : undefined
        if (pending) this.pendingRequests.delete(requestId)
        let handled = Boolean(pending)

        if (pending === 'offer') {
            this.pendingOfferRequests.delete(requestId)
            const rpcError = message.error
            const errorCode = rpcError?.code !== undefined ? ` code=${String(rpcError.code)}` : ""
            const errorMessage = typeof rpcError?.message === "string" ? `: ${rpcError.message.slice(0, 160)}` : ""
            this.emit("diagnostic", {
                phase: "signaling",
                level: rpcError ? "error" : "info",
                message: rpcError
                    ? `JSON-RPC offer response: error${errorCode}${errorMessage}.`
                    : "JSON-RPC offer response: ok."
            })
        }

        try {
            if (Array.isArray(message.result?.TurnAuthServers)) {
                this.credentials = parseTurnServers(JSON.stringify(message.result))
                this.emit("credentials", this.credentials)
                handled = true
            }

            switch (message.method) {
                case "System_Pong_v1_0":
                    this.ws.send(JSON.stringify({ id: message.id, result: null, jsonrpc: "2.0" }))
                    handled = true
                    break
                case "Signaling_ReceiveMessage_v1_0": {
                    this.ws.send(JSON.stringify({ id: message.id, result: null, jsonrpc: "2.0" }))
                    handled = true
                    const params = Array.isArray(message.params) ? message.params : message.params ? [message.params] : []
                    for (const param of params) {
                        const rawDeliveryId = param?.Id ?? param?.id ?? param?.delivery_id ?? param?.deliveryId
                        const deliveryId = safeRequestId(rawDeliveryId)
                        this.sendDeliveryNotification(param?.From ?? param?.from, rawDeliveryId)
                        let signalMessage = param?.Message
                        let nestedMethod = 'raw'
                        try {
                            const parsed = JSON.parse(param.Message)
                            nestedMethod = typeof parsed?.method === 'string' ? parsed.method : 'unknown'

                            switch (parsed.method) {
                                case "Signaling_WebRtc_v1_0":
                                    if (parsed.params?.message) signalMessage = parsed.params.message
                                    break
                                case "Signaling_DeliveryNotification_V1_0":
                                    this.emit("diagnostic", { phase: "signaling", message: `Incoming signaling event: method=${nestedMethod} delivery_id=${deliveryId} signal=none handled=no reason=delivery_notification.` })
                                    continue
                            }
                        } catch (error) {
                            this.emit("diagnostic", { phase: "signaling", level: "error", message: `Incoming signaling event parse exception: delivery_id=${deliveryId} error=${safeErrorMessage(error)}.` })
                            console.error(error)
                        }

                        const signalType = signalTypeFromMessage(signalMessage)
                        if (signalMessage && typeof signalMessage.includes === 'function' && signalMessage.includes("could not be delivered")) {
                            this.emit("diagnostic", { phase: "signaling", message: `Incoming signaling event: method=${nestedMethod} delivery_id=${deliveryId} signal=${signalType || 'unknown'} handled=no reason=delivery_failure.` })
                            continue
                        }

                        try {
                            let signal = SignalStructure.fromString(signalMessage)
                            signal.connectionId = BigInt(signal.connectionId)
                            signal.networkId = this.networkId
                            signal.serverNetworkId = param?.From ?? this.serverNetworkId
                            signal.deliveryId = deliveryId
                            signal.signalingPath = `Signaling_ReceiveMessage_v1_0.params[].Message -> ${nestedMethod}.params.message -> SignalStructure.data`

                            if (signal.type === "CANDIDATEADD") {
                                signal.data += " network-cost 10"

                                if (!this.didSendCandidates) {
                                    this.signalCandidates.push(signal)
                                    this.emit("diagnostic", { phase: "signaling", message: `Incoming signaling event: method=${nestedMethod} delivery_id=${deliveryId} signal=CANDIDATEADD handled=queued reason=awaiting_connect_response; dispatch=continue.` })
                                    continue
                                }
                            }

                            if (
                                signal.type === "CONNECTRESPONSE" &&
                                signal.connectionId === this.connectionId &&
                                !this.didSendCandidates
                            ) {
                                for (const candidate of this.candidates) {
                                    this.write(candidate)
                                }

                                for (const signalCandidate of this.signalCandidates) {
                                    this.emit("signal", signalCandidate)
                                }

                                this.didSendCandidates = true
                            }

                            this.emit("signal", signal)
                            this.emit("diagnostic", { phase: "signaling", message: `Incoming signaling event: method=${nestedMethod} delivery_id=${deliveryId} signal=${signal.type || signalType || 'unknown'} handled=dispatched.` })
                            if (signal.type === "CONNECTERROR") break
                        } catch (error) {
                            this.emit("diagnostic", { phase: "signaling", level: "error", message: `Incoming signaling dispatch exception: method=${nestedMethod} delivery_id=${deliveryId} signal=${signalType || 'unknown'} error=${safeErrorMessage(error)}.` })
                            console.error(error)
                            if (signalType === "CONNECTERROR") break
                        }
                    }
                    break
                }
                default:
                    break
            }
        } catch (error) {
            this.emit("diagnostic", { phase: "signaling", level: "error", message: `Incoming JSON-RPC dispatch exception: method=${trace?.summary?.method || message.method || 'unknown'} id=${requestId} error=${safeErrorMessage(error)}.` })
            console.error(error)
        }

        if (this.offerSubmitted) {
            this.emit("diagnostic", { phase: "signaling", message: `Incoming JSON-RPC dispatch: method=${trace?.summary?.method || message.method || 'unknown'} id=${requestId} pending=${pending || 'none'} handled=${handled ? 'yes' : 'no'}.` })
        }
    }

    write(signal) {
        const isCandidate = signal?.type === "CANDIDATEADD"
        const websocketOpen = this.ws?.readyState === WebSocket.OPEN
        if (this.aborted || this.destroyed || (isCandidate && !websocketOpen)) {
            if (isCandidate && !this.lateCandidateIgnoredLogged) {
                this.lateCandidateIgnoredLogged = true
                this.emit("diagnostic", { phase: "signaling", message: "Late ICE candidate ignored; signaling WebSocket is not OPEN." })
            }
            return
        }

        if (!this.ws) throw new Error('WebSocket not connected')

        let uuidv4 = v4()

        if (signal.type === "CANDIDATEADD" && !this.candidates.includes(signal)) {
            this.candidates.length === 0 ? signal.data += " network-cost 50" : signal.data += " network-cost 10"

            if (signal.data.includes("tcp") || signal.data.includes("::1") || signal.data.includes("127.0.0.1")) return;

            this.candidates.push(signal)
            // Don't write yet, just store for later, and then we will write them after connectrequest
            return
        }

        if (signal.type === "CONNECTREQUEST") this.connectionId = signal.connectionId

        const message = JSONBigInt.stringify({
            params: {
                toPlayerId: String(signal.serverNetworkId ?? this.serverNetworkId),
                messageId: uuidv4,
                message: JSONBigInt.stringify({
                    params: {
                        netherNetId: String(signal.networkId),
                        message: signal.toString(),
                    },
                    jsonrpc: "2.0",
                    method: "Signaling_WebRtc_v1_0",
                })
            },
            jsonrpc: "2.0",
            method: "Signaling_SendClientMessage_v1_0",
            id: uuidv4
        })

        if (signal.type === "CONNECTREQUEST") {
            this.pendingOfferRequests.add(uuidv4)
            this.trackRequest(uuidv4, 'offer')
            this.offerSubmitted = true
            this.emit("diagnostic", { phase: "signaling", message: "JSON-RPC Signaling_WebRtc_v1_0 offer fields: netherNetId=present toPlayerId=present messageId=present signal=CONNECTREQUEST message=present." })
            this.emit("diagnostic", { phase: "signaling", message: "JSON-RPC offer submission sent." })
        } else {
            this.trackRequest(uuidv4, signal.type === "CANDIDATEADD" ? 'candidate' : 'signal')
        }

        try {
            this.ws.send(message)
        } catch (error) {
            this.pendingRequests.delete(uuidv4)
            if (signal.type === "CONNECTREQUEST") this.pendingOfferRequests.delete(uuidv4)
            const message = typeof error?.message === "string" ? error.message.slice(0, 160) : "unknown error"
            this.emit("diagnostic", { phase: "signaling", level: "error", message: `JSON-RPC offer submission failed: ${message}.` })
            throw error
        }
    }

    sendDeliveryNotification(toPlayerId, messageId) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return

        const uuidv4 = v4()
        this.trackRequest(uuidv4, 'delivery-notification')
        const message = JSONBigInt.stringify({
            params: {
                toPlayerId,
                messageId: uuidv4,
                message: JSONBigInt.stringify({
                    params: {
                        messageId
                    },
                    jsonrpc: "2.0",
                    method: "Signaling_DeliveryNotification_V1_0"
                })
            },
            jsonrpc: "2.0",
            method: "Signaling_SendClientMessage_v1_0",
            id: uuidv4
        })

        this.ws.send(message)
    }
}

module.exports = { NethernetJSONRPC }

function safeRequestId(value) {
    if (value === undefined || value === null || value === '') return 'none'
    return String(value).slice(0, 80)
}

function safeErrorMessage(error) {
    if (typeof error?.message !== 'string') return 'unknown error'
    return error.message.replace(/\s+/g, ' ').slice(0, 160)
}

function signalTypeFromMessage(value) {
    if (typeof value !== 'string') return null
    const type = value.trim().split(/\s+/, 1)[0]
    return type || null
}

function summarizeIncomingMessage(message) {
    const events = []
    const signalTypes = []
    const addEvent = (value) => {
        if (typeof value === 'string' && value && !events.includes(value)) events.push(value)
    }
    const addSignal = (value) => {
        const type = signalTypeFromMessage(value)
        if (type && !signalTypes.includes(type)) signalTypes.push(type)
    }

    addEvent(typeof message?.method === 'string' ? message.method : message?.error ? 'JSON-RPC_ERROR' : 'JSON-RPC_RESPONSE')
    if (message?.method === 'Signaling_WebRtc_v1_0') {
        addSignal(message.params?.message)
    }

    const params = Array.isArray(message?.params) ? message.params : message?.params ? [message.params] : []
    for (const param of params) {
        if (typeof param?.Message !== 'string') continue
        try {
            const parsed = JSON.parse(param.Message)
            addEvent(parsed?.method)
            if (parsed?.method === 'Signaling_WebRtc_v1_0') addSignal(parsed.params?.message)
        } catch {
            addSignal(param.Message)
        }
    }

    return {
        method: typeof message?.method === 'string' ? message.method : message?.error ? 'JSON-RPC_ERROR' : 'JSON-RPC_RESPONSE',
        events,
        hasSdpAnswer: signalTypes.includes('CONNECTRESPONSE'),
        hasRemoteIceCandidate: signalTypes.includes('CANDIDATEADD')
    }
}

function parseTurnServers(dataString) {
    const iceServers = []
    const TurnAuthServers = JSON.parse(dataString)?.TurnAuthServers ?? []

    for (const server of TurnAuthServers) {
        const urls = server?.Urls ?? []
        const username = typeof server?.Username === "string" ? server.Username : undefined
        const credential = typeof server?.Password === "string" ? server.Password : (typeof server?.Credential === "string" ? server.Credential : undefined)

        for (const rawUrl of urls) {
            const parsedUrl = parseIceUrl(rawUrl)
            if (!parsedUrl) continue

            const urlCandidates = new Set([formatIceUrl(parsedUrl)])

            if (parsedUrl.isTurn) {
                if (parsedUrl.transport !== "tcp") urlCandidates.add(formatIceUrl({ ...parsedUrl, transport: "udp" }))
                if (parsedUrl.scheme !== "turns") urlCandidates.add(formatIceUrl({ ...parsedUrl, scheme: "turns", port: 5349, transport: "udp" }))
            }

            for (const url of urlCandidates) {
                parsedUrl.isTurn ? iceServers.push({ urls: url, username, credential }) : iceServers.push({ urls: url })
            }
        }
    }

    return iceServers
}

function parseIceUrl(url) {
    const match = url.trim().match(/^(?<scheme>stuns?|turns?)(?::\/\/|:)?(?<host>[^:?\s]+)(?::(?<port>\d+))?(?:\?(?<query>.*))?$/i)
    if (!match || !match.groups) return null

    const scheme = match.groups.scheme.toLowerCase()
    const hostname = match.groups.host
    const port = match.groups.port ? parseInt(match.groups.port, 10) : defaultPortForScheme(scheme)

    if (!hostname || Number.isNaN(port)) return null

    const isTurn = scheme.startsWith("turn")

    let transport
    if (scheme === "turns") transport = "tcp"

    if (isTurn) transport = match.groups.query?.split("&").find(param => param.startsWith("transport="))?.split("=")[1] ?? "udp"
    if (!transport) transport = "udp"

    return { scheme, hostname, port, transport, isTurn }
}

function formatIceUrl(parsed) {
    const protocol = parsed.scheme
    const base = `${protocol}:${parsed.hostname}:${parsed.port}`

    if (!parsed.isTurn) return base

    return `${base}?transport=${parsed.transport ?? "udp"}`
}

function defaultPortForScheme(scheme) {
    return scheme === "stuns" ? 3478 : 5349
}
