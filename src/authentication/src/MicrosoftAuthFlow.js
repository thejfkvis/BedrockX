const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const Titles = require('./common/Titles')
const { createHash } = require('./common/Util')
const { Endpoints } = require('./common/Constants')
const FileCache = require('./common/cache/FileCache')

const LiveTokenManager = require('./TokenManagers/LiveTokenManager')
const XboxTokenManager = require('./TokenManagers/XboxTokenManager')
const BedrockTokenManager = require('./TokenManagers/MinecraftBedrockTokenManager')
const PlayfabTokenManager = require('./TokenManagers/PlayfabTokenManager')
const MinecraftServicesTokenManager = require('./TokenManagers/MinecraftBedrockServicesManager')

async function retry(methodFn, beforeRetry, times) {
  while (times--) {
    if (times !== 0) {
      try { return await methodFn() } catch (e) { if (e instanceof URIError) { throw e } else { console.debug(safeAuthError(e)) } }
      await new Promise(resolve => setTimeout(resolve, 2000))
      await beforeRetry()
    } else {
      return await methodFn()
    }
  }
}

const CACHE_IDS = ['msal', 'live', 'sisu', 'xbl', 'bed', 'mca', 'mcs', 'pfb']

class MicrosoftAuthFlow {
  constructor(username = '', cache = __dirname, options, codeCallback) {
    this.username = username

    if (options && !options.flow) throw new Error("Missing 'flow' argument in options. See docs for more information.")

    this.options = options || { flow: 'live', authTitle: Titles.MinecraftNintendoSwitch }
    this.identityDiagnostics = {}

    this.initTokenManagers(username, cache, options?.forceRefresh)

    this.codeCallback = codeCallback
  }

  getIdentityDiagnostics() {
    return JSON.parse(JSON.stringify(this.identityDiagnostics))
  }

  recordIdentityDiagnostic(name, value) {
    this.identityDiagnostics[name] = { ...value }
  }

  initTokenManagers(username, cache, forceRefresh) {
    if (typeof cache !== 'function') {
      let cachePath = cache

      try {
        if (!fs.existsSync(cachePath)) fs.mkdirSync(cachePath, { recursive: true })
      } catch (e) {
        console.log('Failed to open cache dir', e, ' ... will use current dir')
        cachePath = __dirname
      }

      cache = ({ cacheName, username }) => {
        if (!CACHE_IDS.includes(cacheName)) throw new Error(`Cannot instantiate cache for unknown ID: '${cacheName}'`)

        const hash = createHash(username)
        const result = new FileCache(path.join(cachePath, `./${hash}_${cacheName}-cache.json`))

        if (forceRefresh) result.reset()

        return result
      }
    }

    if (this.options.flow === 'live' || this.options.flow === 'sisu') {
      if (!this.options.authTitle) throw new Error(`Please specify an "authTitle" in Authflow constructor when using ${this.options.flow} flow`)

      this.msa = new LiveTokenManager(this.options.authTitle, ['service::user.auth.xboxlive.com::MBI_SSL'], cache({ cacheName: this.options.flow, username }))

      this.doTitleAuth = true
    } else {
      throw new Error(`Unknown flow: ${this.options.flow} (expected "live", or "sisu")`)
    }

    const keyPair = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' })
    this.xbl = new XboxTokenManager(keyPair, cache({ cacheName: 'xbl', username }))
    this.mba = new BedrockTokenManager(cache({ cacheName: 'bed', username }))
    this.mcs = new MinecraftServicesTokenManager(cache({ cacheName: 'mcs', username }))
    this.pfb = new PlayfabTokenManager(cache({ cacheName: 'pfb', username }))
  }

  async getMsaToken() {
    if (await this.msa.verifyTokens()) {
      this.recordIdentityDiagnostic('msa', { source: 'cache', expiry: 'unknown' })
      const { token } = await this.msa.getAccessToken()

      return token
    } else {
      const ret = await this.msa.authDeviceCode((response) => {
        if (this.codeCallback) return this.codeCallback(response)

        console.info('[msa] First time signing in. Please authenticate now:')

        console.info(response.message)
      })

      console.info('[msa] Signed in with Microsoft')

      this.recordIdentityDiagnostic('msa', { source: 'fresh', expiry: 'unknown' })

      return ret.accessToken
    }
  }

  async getPlayfabLogin() {
    const cache = await this.pfb.getCachedAccessToken()

    if (cache?.valid) {
      this.recordIdentityDiagnostic('playfab', {
        source: 'cache',
        expiry: cache.until?.toISOString?.() || 'unknown',
        relyingParty: Endpoints.PlayfabRelyingParty
      })
      return cache.data
    }

    const xsts = await this.getXboxToken(Endpoints.PlayfabRelyingParty)

    const playfab = await this.pfb.getAccessToken(xsts)

    this.recordIdentityDiagnostic('playfab', {
      source: 'fresh',
      expiry: playfab?.EntityToken?.TokenExpiration || 'unknown',
      relyingParty: Endpoints.PlayfabRelyingParty
    })

    return playfab
  }

  async getMinecraftBedrockServicesToken({ version = '1.26.40' } = {}) {
    version = normalizeGameVersion(version)
    const cache = await this.mcs.getCachedAccessToken(version)

    if (cache.valid) {
      this.recordIdentityDiagnostic('minecraftServices', {
        source: 'cache',
        expiry: cache.until?.toISOString?.() || 'unknown',
        gameVersion: cache.data?.gameVersion || version,
        audience: getJwtAudience(cache.data?.mcToken),
        xuid: getJwtXuid(cache.data?.mcToken),
        xuidKey: getJwtXuidKey(cache.data?.mcToken),
        relyingParty: Endpoints.PlayfabRelyingParty,
        tokenPresent: Boolean(cache.data?.mcToken)
      })
      return cache.data
    }

    const playfab = await this.getPlayfabLogin()

    if (!playfab?.SessionTicket) return playfab

    const mcs = await this.mcs.getAccessToken(playfab.SessionTicket, { version })

    this.recordIdentityDiagnostic('minecraftServices', {
      source: 'fresh',
      expiry: mcs?.validUntil || 'unknown',
      gameVersion: mcs?.gameVersion || version,
      audience: getJwtAudience(mcs?.mcToken),
      xuid: getJwtXuid(mcs?.mcToken),
      xuidKey: getJwtXuidKey(mcs?.mcToken),
      relyingParty: Endpoints.PlayfabRelyingParty,
      tokenPresent: Boolean(mcs?.mcToken)
    })

    return mcs
  }

  async getXboxToken(relyingParty = this.options.relyingParty || Endpoints.XboxRelyingParty, forceRefresh = false) {
    const options = { ...this.options, relyingParty }

    const { xstsToken, userToken, deviceToken, titleToken } = await this.xbl.getCachedTokens(relyingParty)

    if (xstsToken.valid && !forceRefresh) {
      this.recordIdentityDiagnostic('xsts', {
        source: 'cache',
        relyingParty,
        expiry: xstsToken.data?.expiresOn || 'unknown',
        xuid: redactXuid(xstsToken.data?.userXUID),
        xuidKey: identityKey(xstsToken.data?.userXUID)
      })
      return xstsToken.data
    }

    if (options.flow === "sisu" && !(await this.msa.verifyTokens())) {
      const dt = await this.xbl.getDeviceToken(options)

      await this.xbl.SisuAuthenticate(options, dt)
    }

    const result = await retry(async () => {
      const msaToken = await this.getMsaToken()

      // sisu flow generates user and title tokens differently to other flows and should also be used to refresh them if they are invalid
      if (options.flow === 'sisu' && (!userToken.valid || !deviceToken.valid || !titleToken.valid)) {
        const dt = await this.xbl.getDeviceToken(options)

        const sisu = await this.xbl.SisuAuthorize(msaToken, dt, options)

        return sisu
      }

      const ut = userToken.token ?? await this.xbl.getUserToken(msaToken)
      const dt = deviceToken.token ?? await this.xbl.getDeviceToken(options)
      const tt = titleToken.token ?? (this.doTitleAuth ? await this.xbl.getTitleToken(msaToken, dt) : undefined)

      const xsts = await this.xbl.getXSTSToken({ userToken: ut, deviceToken: dt, titleToken: tt }, options)

      return xsts
    }, () => { this.msa.forceRefresh = true }, 2)

    this.recordIdentityDiagnostic('xsts', {
      source: 'fresh',
      relyingParty,
      expiry: result?.expiresOn || 'unknown',
      xuid: redactXuid(result?.userXUID),
      xuidKey: identityKey(result?.userXUID)
    })
    return result
  }

  async getMinecraftBedrockChain(publicKey) {
    if (!publicKey) throw new Error('Need to specifiy a ECDH x509 URL encoded public key')

    const chain = await retry(async () => {
      const xsts = await this.getXboxToken(Endpoints.BedrockXSTSRelyingParty)

      const token = await this.mba.getAccessToken(publicKey, xsts)
      // If we want to auth with a title ID, make sure there's a TitleID in the response
      const body = JSON.parse(Buffer.from(token.chain[1].split('.')[1], 'base64').toString())

      if (!body.extraData.titleId && this.doTitleAuth) throw Error('missing titleId in response')

      return token.chain
    }, () => { this.xbl.forceRefresh = true }, 2)

    this.recordIdentityDiagnostic('bedrockChain', {
      source: 'fresh',
      relyingParty: Endpoints.BedrockXSTSRelyingParty,
      expiry: getJwtExpiry(chain?.[0]),
      xuid: getChainXuid(chain),
      xuidKey: getChainXuidKey(chain)
    })
    return chain
  }

  async getMinecraftBedrockMultiplayerToken(publicKey, options = {}) {
    const services = await this.getMinecraftBedrockServicesToken({ version: options.version || this.options.version })
    if (!services?.mcToken) throw new Error('Failed to obtain Minecraft Bedrock services token')

    const token = await this.mcs.getMultiplayerToken(services.mcToken, publicKey)
    this.recordIdentityDiagnostic('multiplayer', {
      source: 'fresh',
      endpoint: 'https://authorization.franchise.minecraft-services.net/api/v1.0/multiplayer/session/start',
      relyingParty: Endpoints.PlayfabRelyingParty,
      tokenPresent: Boolean(token),
      publicKeyPresent: Boolean(publicKey)
    })
    return token
  }

  async getMinecraftBedrockToken(publicKey, options = {}) {
    const chain = await this.getMinecraftBedrockChain(publicKey)
    const token = await this.getMinecraftBedrockMultiplayerToken(publicKey, options)
    return { chain, token }
  }
}

function redactXuid(value) {
  if (value === null || value === undefined || value === '') return null
  const text = String(value)
  return text.length <= 4 ? `...${text}` : `...${text.slice(-4)}`
}

function normalizeGameVersion(version) {
  const text = String(version || '1.26.40').trim()
  return text.startsWith('1.') ? text : `1.${text}`
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

function identityKey(value) {
  if (value === null || value === undefined || value === '') return null
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 16)
}

function getJwtExpiry(token) {
  if (typeof token !== 'string') return 'unknown'
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'))
    if (payload?.exp === undefined) return 'unknown'
    return new Date(Number(payload.exp) * 1000).toISOString()
  } catch {
    return 'unknown'
  }
}

function getJwtAudience(token) {
  if (typeof token !== 'string') return 'unknown'
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'))
    const audience = payload?.aud ?? payload?.audience
    if (Array.isArray(audience)) return audience.join(',').slice(0, 160)
    return audience ? String(audience).replace(/[\r\n]/g, '').slice(0, 160) : 'unknown'
  } catch {
    return 'unknown'
  }
}

function getJwtXuid(token) {
  if (typeof token !== 'string') return null
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'))
    const value = payload?.extraData?.XUID || payload?.xuid || payload?.xid
    return redactXuid(value)
  } catch {
    return null
  }
}

function getJwtXuidKey(token) {
  if (typeof token !== 'string') return null
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'))
    const value = payload?.extraData?.XUID || payload?.xuid || payload?.xid
    return identityKey(value)
  } catch {
    return null
  }
}

function getChainXuid(chain) {
  if (!Array.isArray(chain)) return null
  for (const token of chain) {
    try {
      const payload = JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8'))
      const value = payload?.extraData?.XUID || payload?.xuid || payload?.xid
      if (value !== undefined && value !== null) return redactXuid(value)
    } catch {}
  }
  return null
}

function getChainXuidKey(chain) {
  if (!Array.isArray(chain)) return null
  for (const token of chain) {
    try {
      const payload = JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8'))
      const value = payload?.extraData?.XUID || payload?.xuid || payload?.xid
      if (value !== undefined && value !== null) return identityKey(value)
    } catch {}
  }
  return null
}

module.exports = MicrosoftAuthFlow
