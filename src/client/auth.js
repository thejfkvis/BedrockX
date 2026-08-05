const { Authflow } = require('../authentication/index')
const { translateUUID } = require('../utils/Util.js')
const { decodeTokenMetadata, identityKey, sameIdentity } = require('../identity')

const JWT = require('jsonwebtoken')

async function authenticate(client, options) {
  try {
    options.onDiagnostic?.({ phase: 'authentication', message: 'Requesting Minecraft Services token.' })
    options.authflow ??= new Authflow(options.username, options.profilesFolder, options, options.onMsaCode)

    const loginData = await options.authflow.getMinecraftBedrockToken(client.clientX509, { version: client.options.version })
    const chains = Array.isArray(loginData) ? loginData : loginData?.chain
    const signedToken = Array.isArray(loginData) ? '' : loginData?.token
    if (!Array.isArray(chains) || !signedToken) throw new Error('Minecraft authentication did not return a multiplayer token and Bedrock chain')

    const tokenMetadata = decodeTokenMetadata(signedToken)
    client.tokenData = decodeJwtPayload(signedToken) || {}
    options.onDiagnostic?.({ phase: 'authentication', message: 'Bedrock chain tokens acquired.' })

    const Mjwt = chains[0]
    const jwt = chains[1]
    const [h, payload] = jwt.split('.').map(k => Buffer.from(k, 'base64')) // eslint-disable-line
    const [Mh, Mpayload] = Mjwt.split('.').map(k => Buffer.from(k, 'base64'))
    const xboxProfile = JSON.parse(String(payload))
    const mojangPayload = JSON.parse(String(Mpayload))
    const mojangHeader = JSON.parse(String(Mh))

    const clientpayload = {
      certificateAuthority: true,
      exp: mojangPayload.exp,
      identityPublicKey: mojangHeader.x5u,
      nbf: mojangPayload.nbf,
    }

    const clienttoken = JWT.sign(clientpayload, client.privateKeyPEM, { algorithm: 'ES384', noTimestamp: true, header: { x5u: xboxProfile.identityPublicKey, alg: 'ES384', typ: undefined } })

    client.profile = xboxProfile?.extraData
    client.profile.uuid = translateUUID(client.profile.identity)
    client.chain = chains
    client.clienttoken = clienttoken
    client.token = signedToken
    client.multiplayerToken = signedToken

    const authDiagnostics = options.authflow.getIdentityDiagnostics?.() || {}
    const chainXuid = client.profile?.XUID || null
    const multiplayerXuid = extractXuid(client.tokenData)
    const accountXuid = options.accountXuid || null
    const identityKeys = [
      identityKey(accountXuid),
      identityKey(chainXuid),
      identityKey(multiplayerXuid),
      authDiagnostics.minecraftServices?.xuidKey,
      authDiagnostics.xsts?.xuidKey
    ].filter(Boolean)

    options.onDiagnostic?.({
      phase: 'identity',
      message: `Minecraft identity tokens: msa_source=${authDiagnostics.msa?.source || 'unknown'} playfab_source=${authDiagnostics.playfab?.source || 'unknown'} mcs_source=${authDiagnostics.minecraftServices?.source || 'unknown'} mcs_game_version=${authDiagnostics.minecraftServices?.gameVersion || client.options.version || 'unknown'} mcs_expiry=${authDiagnostics.minecraftServices?.expiry || 'unknown'} mcs_audience=${authDiagnostics.minecraftServices?.audience || tokenMetadata.audience} mcs_relying_party=${authDiagnostics.minecraftServices?.relyingParty || 'unknown'} bedrock_source=${authDiagnostics.bedrockChain?.source || 'unknown'} bedrock_expiry=${authDiagnostics.bedrockChain?.expiry || 'unknown'} multiplayer_source=${authDiagnostics.multiplayer?.source || 'unknown'} multiplayer_expiry=${tokenMetadata.expiry} multiplayer_audience=${tokenMetadata.audience} multiplayer_present=${tokenMetadata.present ? 'yes' : 'no'}.`
    })
    options.onDiagnostic?.({
      phase: 'identity',
      message: `Minecraft identity XUIDs: account=${redactXuid(accountXuid) || 'unknown'} mcs=${authDiagnostics.minecraftServices?.xuid || 'unknown'} chain=${redactXuid(chainXuid) || 'unknown'} multiplayer=${tokenMetadata.xuid || redactXuid(multiplayerXuid) || 'unknown'} xsts=${authDiagnostics.xsts?.xuid || 'unknown'} match=${sameIdentity(identityKeys)}.`
    })
    options.onDiagnostic?.({
      phase: 'identity',
      message: `Minecraft identity payloads: realm_id=${options.realmId || 'unknown'} realm_network_id=${options.realmNetworkId || 'unknown'} services_authorization=${authDiagnostics.minecraftServices?.tokenPresent ? 'present' : 'missing'} bedrock_auth.identityPublicKey=present multiplayer_session_start.publicKey=present same_public_key=yes multiplayer_session_start.signedToken=${tokenMetadata.present ? 'present' : 'missing'} bedrock_chain_entries=${chains.length} client_certificate=${clienttoken ? 'present' : 'missing'} relying_party_bedrock=${authDiagnostics.bedrockChain?.relyingParty || 'unknown'}.`
    })
    options.onDiagnostic?.({ phase: 'authentication', message: 'Xbox/Minecraft authentication completed.' })
    client.emit('session', xboxProfile)
  } catch (err) {
    // Initialization callers must observe authentication failures. Emitting an
    // EventEmitter `error` here can terminate the process when no listener has
    // been attached yet, while swallowing the error leaves the client looking
    // connected without a valid session.
    options.onDiagnostic?.({ phase: 'authentication', level: 'error', message: `Authentication failed: ${safeAuthError(err)}.` })
    throw err
  }
}

function decodeJwtPayload(token) {
  if (typeof token !== 'string') return null
  try {
    return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'))
  } catch {
    return null
  }
}

function extractXuid(value, depth = 0) {
  if (value === null || value === undefined || depth > 4) return null
  if (typeof value !== 'object') return null
  for (const [key, child] of Object.entries(value)) {
    const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '')
    if (['xuid', 'xid', 'userxuid'].includes(normalized) && child !== null && child !== undefined && child !== '') return String(child)
    const nested = extractXuid(child, depth + 1)
    if (nested) return nested
  }
  return null
}

function redactXuid(value) {
  if (value === null || value === undefined || value === '') return null
  const text = String(value)
  return text.length <= 4 ? `...${text}` : `...${text.slice(-4)}`
}

function safeAuthError(error) {
  const message = typeof error?.message === 'string' ? error.message : String(error || 'unknown error')
  return message
    .replace(/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted-token]')
    .replace(/XBL3\.0\s+[^\s]+/gi, '[redacted-xbox-token]')
    .replace(/\b(?:Bearer|Basic)\s+[^\s]+/gi, '[redacted-auth]')
    .replace(/\b(?:access[_-]?token|authorization|credential|password|secret)\s*[:=]\s*[^,\s}]+/gi, '$1=[redacted]')
    .replace(/[\r\n]/g, ' ')
    .slice(0, 240)
}

module.exports = { authenticate }
