const { Endpoints } = require('../common/Constants')
const { checkStatus } = require('../common/Util')

const { v4fast: v4 } = require("uuid-1345")

const verData = require("../../../ext/data.json");

class MinecraftBedrockServicesTokenManager {
  constructor (cache) {
    this.cache = cache
  }

  async getCachedAccessToken (expectedVersion = null) {
    const { mcs: token } = await this.cache.getCached()

    if (!token) return { valid: false }

    const expires = new Date(token.validUntil)
    const remainingMs = expires - Date.now()
    const normalizedExpectedVersion = normalizeGameVersion(expectedVersion)
    const normalizedCachedVersion = normalizeGameVersion(token.gameVersion)
    const versionMatches = normalizedExpectedVersion === null || normalizedCachedVersion === normalizedExpectedVersion
    const valid = remainingMs > 1000 && versionMatches

    return { valid, until: expires, token: token.mcToken, data: token, versionMatches }
  }

  async setCachedToken (data) {
    await this.cache.setCachedPartial(data)
  }

  async getAccessToken (sessionTicket, options = {}) {
    const gameVersion = normalizeGameVersion(options.version) || verData.version
    const response = await fetch(Endpoints.MinecraftServicesSessionStart, {
      method: 'post',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        device: {
          applicationType: options.applicationType ?? 'MinecraftPE',
          capabilities: ["VibrantVisuals"],
          gameVersion,
          hardwareMemoryTier: 1,
          id: options.deviceId ?? v4().replace(/-/g, ""),
          // All of this for it to be blank.. sad
          integrityToken: "eyJhbGciOiJBMjU2S1ciLCJlbmMiOiJBMjU2R0NNIn0.e2JO8NSO2w4eu40Oixqj_PhJJTzUN1qh5gH7DZNPalaiQReb4A6zAA.t4Oil-_QR_k5UjYP.E2c15h925-UGW_jNFXqVQekoyVwY-IXdf2Ode4WiWSTQChd-y2_exybn4Cbrt26rhffg2aqE8NtOoTPGN9zXNyf1yMPAxjmpXKHvR2-bNCxbJeX6vOPh1IOevjxrP8mDgdNZ_NTa24m5n4Wj_nAPrNlGxwy3HXn7YGK5Wp3rq2SPL1k2-u4_Kvs79aTZ3p0ckk67XxNeGghbN3zctYSn_dKvxh5JSczpKy97-pdqKM0l2tUSgBDYol-DuJuAX3p0UD68riQUxUJBihz9ek96XiFjF-nOduLYRnhzppAZyQg4AKfv4CSCxAzawQPbuR0qUzZTcHkqERSJa-LlH6Om2YKIzj1szVA9ZlQY57Oyzoy2kigkqiDGCrYTiJOYm0vgNBWLYsooZvL9nlzxOzFdLqT6JX0eLA2kxYIn3HGAI4QFEUr3kRruMPwagebbAodnkhKbtpqOH04Dq8JgvtJjDExJZ86t4NNCGoifhM3TjMoKzjnikKAJQHA55kA7prgwgSlBFakvI-ql6SITkA6UoqCBMA_kTQwPJhn_X-p00WV_86NZttIp51fmEsOTqzlndGNStdRV-5tjk7QPFB6H0M8dO4MHqiGHGOuQOce_5eWsQ-JCWs-e1gMSFMVVofgiUReug5jVYsz1thZI4WJLjTT8iohVW-wk2pfpW5CoeM9RUXpQ-n6qjg0L49B35_CuxGmjV2aQ4w_1Gelby6qv3C6e0KukuPpUkfbUTEMPqFuP0id04OI.KqiiB51qoLbuChkTG9bQ4w",
          isPreview: false,
          memory: options.deviceMemory ?? "4131418112",
          platform: options.platform ?? 'Android',
          playFabTitleId: options.playFabtitleId ?? '20CA2',
          storePlatform: options.storePlatform ?? 'android.googleplay',
          treatmentOverrides: null,
          type: options.type ?? 'Android'
        },
        user: {
          language: "en",
          languageCode: "en-US",
          regionCode: "US",
          token: sessionTicket,
          tokenType: 'PlayFab'
        }
      })
    }).then(checkStatus)

    const tokenResponse = {
      mcToken: response.result.authorizationHeader,
      validUntil: response.result.validUntil,
      gameVersion,
      treatments: response.result.treatments,
      configurations: response.result.configurations,
      treatmentContext: response.result.treatmentContext
    }

    await this.setCachedToken({ mcs: tokenResponse })

    return tokenResponse
  }

  async getMultiplayerToken (serviceToken, publicKey) {
    const response = await fetch('https://authorization.franchise.minecraft-services.net/api/v1.0/multiplayer/session/start', {
      method: 'POST',
      headers: {
        accept: '*/*',
        authorization: serviceToken,
        'content-type': 'application/json',
        'User-Agent': 'libhttpclient/1.0.0.0',
        'Accept-Language': 'en-US',
        'Accept-Encoding': 'gzip, deflate, br'
      },
      body: JSON.stringify({ publicKey })
    }).then(checkStatus)

    if (response?.code === 'PlayerBanned') {
      throw new Error(JSON.stringify({ path: '/multiplayer/bedrock/authentication', error: 'FORBIDDEN' }))
    }

    return response?.result?.signedToken || response?.signedToken || ''
  }
}

function normalizeGameVersion (version) {
  if (version === null || version === undefined || version === '') return null
  const text = String(version).trim()
  return text.startsWith('1.') ? text : `1.${text}`
}

module.exports = MinecraftBedrockServicesTokenManager
