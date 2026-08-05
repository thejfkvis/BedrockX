const { Endpoints } = require('../common/Constants')
const { checkStatus } = require('../common/Util')
const verdata = require('../../../ext/data.json')

class BedrockTokenManager {
  constructor (cache) {
    this.cache = cache
  }

  async getCachedAccessToken () {
    const { mca: token } = await this.cache.getCached()

    if (!token) return

    const jwt = token.chain[0]
    const [header, payload, signature] = jwt.split('.').map(k => Buffer.from(k, 'base64')) // eslint-disable-line

    const body = JSON.parse(String(payload))
    const headerbody = JSON.parse(String(payload))
    //console.log(body)
    //console.log(headerbody)
    const expires = new Date(body.exp * 1000)
    const remainingMs = expires - Date.now()
    const valid = remainingMs > 1000

    return { valid, until: expires, chain: token.chain }
  }

  async setCachedAccessToken (data) {
    await this.cache.setCachedPartial({
      mca: {
        ...data,
        obtainedOn: Date.now()
      }
    })
  }

  async verifyTokens () {
    const at = await this.getCachedAccessToken()

    if (!at || this.forceRefresh) return false

    if (at.valid) return true

    return false
  }

  async getAccessToken (clientPublicKey, xsts) {
    const headers = {
      'Content-Type': 'application/json',
      'User-Agent': 'MCPE/UWP', // change this to MCPE/Android ? 
      'Client-Version' : verdata.version,
      Authorization: `XBL3.0 x=${xsts.userHash};${xsts.XSTSToken}`
    }

    const MineServicesResponse = await fetch(Endpoints.BedrockAuth, {
      method: 'post',
      headers,
      body: JSON.stringify({ identityPublicKey: clientPublicKey })
    }).then(checkStatus)

    await this.setCachedAccessToken(MineServicesResponse)

    return MineServicesResponse
  }
}

module.exports = BedrockTokenManager
