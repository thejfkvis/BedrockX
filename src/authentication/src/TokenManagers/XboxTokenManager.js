const crypto = require('crypto')

const { SmartBuffer } = require('smart-buffer')

const { Endpoints, xboxLiveErrors } = require('../common/Constants')
const { checkStatus, createHash } = require('../common/Util')

const { v3, v4 } = require('uuid-1345')

const nextUUID = () => v3({ namespace: v4(), name: v4() })

const checkIfValid = (expires) => {
  const remainingMs = new Date(expires) - Date.now()
  const valid = remainingMs > 1000
  return valid
}

// Manages Xbox Live tokens for xboxlive.com
class XboxTokenManager {
  constructor(ecKey, cache) {
    this.key = ecKey
    this.jwk = { ...ecKey.publicKey.export({ format: 'jwk' }), alg: 'ES256', use: 'sig' }
    this.cache = cache

    this.headers = { 'Cache-Control': 'no-store, must-revalidate, no-cache', 'x-xbl-contract-version': 1 }
  }

  async setCachedToken(data) {
    await this.cache.setCachedPartial(data)
  }

  async getCachedTokens(relyingParty) {
    const cachedTokens = await this.cache.getCached()

    const xstsHash = createHash(relyingParty)

    const result = {}

    for (const token of ['userToken', 'titleToken', 'deviceToken']) {
      const cached = cachedTokens[token]
      result[token] = cached && checkIfValid(cached.NotAfter)
        ? { valid: true, token: cached.Token, data: cached }
        : { valid: false }
    }

    result.xstsToken = cachedTokens[xstsHash] && checkIfValid(cachedTokens[xstsHash].expiresOn)
      ? { valid: true, data: cachedTokens[xstsHash] }
      : { valid: false }

    return result
  }

  checkTokenError(errorCode, response) {
    // { Identity: '0', XErr: 2148916233, Message: '', Redirect: 'https://start.ui.xboxlive.com/CreateAccount' }
    // https://wiki.vg/Microsoft_Authentication_Scheme#Authenticate_with_XSTS
    // Because we do the full auth sequence like the official XAL, the issue with accounts under 18 (2148916238)
    // should not happen through title auth. But the user must always have an xbox.com profile before being able
    // to obtain a Minecraft or Xbox token.
    if (errorCode in xboxLiveErrors) throw new Error(xboxLiveErrors[errorCode])
    else throw new Error(`Xbox Live authentication failed to obtain a XSTS token. XErr: ${errorCode}\n${JSON.stringify(response)}`)
  }

  async getUserToken(accessToken) {
    const payload = {
      RelyingParty: 'http://auth.xboxlive.com',
      TokenType: 'JWT',
      Properties: {
        AuthMethod: 'RPS',
        SiteName: 'user.auth.xboxlive.com',
        RpsTicket: `t=${accessToken}`
      }
    }

    const body = JSON.stringify(payload)
    const signature = this.sign(Endpoints.XboxUserAuth, '', body).toString('base64')
    const headers = { ...this.headers, signature, 'Content-Type': 'application/json', accept: 'application/json', 'x-xbl-contract-version': '2' }

    const ret = await fetch(Endpoints.XboxUserAuth, { method: 'post', headers, body }).then(checkStatus)

    await this.setCachedToken({ userToken: ret })

    return ret.Token
  }

  // Make signature for the data being sent to server with our private key; server is sent our public key in plaintext
  sign(url, authorizationToken, payload) {
    // Their backend servers use Windows epoch timestamps, account for that. The server is very picky,
    // bad percision or wrong epoch may fail the request.
    const windowsTimestamp = (BigInt((Date.now() / 1000) | 0) + 11644473600n) * 10000000n
    // Only the /uri?and-query-string
    const pathAndQuery = new URL(url).pathname

    // Allocate the buffer for signature, TS, path, tokens and payload and NUL termination
    const allocSize = /* sig */ 5 + /* ts */ 9 + /* POST */ 5 + pathAndQuery.length + 1 + authorizationToken.length + 1 + payload.length + 1
    const buf = SmartBuffer.fromSize(allocSize)
    buf.writeInt32BE(1) // Policy Version
    buf.writeUInt8(0)
    buf.writeBigUInt64BE(windowsTimestamp)
    buf.writeUInt8(0) // null term
    buf.writeStringNT('POST')
    buf.writeStringNT(pathAndQuery)
    buf.writeStringNT(authorizationToken)
    buf.writeStringNT(payload)

    // Get the signature from the payload
    const signature = crypto.sign('SHA256', buf.toBuffer(), { key: this.key.privateKey, dsaEncoding: 'ieee-p1363' })

    const header = SmartBuffer.fromSize(signature.length + 12)
    header.writeInt32BE(1) // Policy Version
    header.writeBigUInt64BE(windowsTimestamp)
    header.writeBuffer(signature) // Add signature at end of header

    return header.toBuffer()
  }

  async SisuAuthenticate(asDevice, DeviceToken) {
    const payload = {
      AppId: asDevice.authTitle,
      TitleId: asDevice.titleId,
      RedirectUri: `ms-xal-${asDevice.authTitle}://auth`,
      DeviceToken,
      Sandbox: "RETAIL",
      TokenType: "code",
      Offers: [
        'service::user.auth.xboxlive.com::MBI_SSL'
      ],
      Query: {
        display: `${asDevice.deviceType}_phone`,
        code_challenge: "",
        code_challenge_method: "S256",
        state: "",
        prompt: "select_account"
      }
    }

    const body = JSON.stringify(payload)

    const signature = this.sign(Endpoints.SisuAuthenticate, '', body).toString('base64')

    const headers = { Signature: signature }

    const req = await fetch(Endpoints.SisuAuthenticate, { method: 'post', headers, body })

    const ret = JSON.parse(await req.text())

    if (!req.ok) this.checkTokenError(parseInt(req.headers.get('x-err')), ret)

    return ret
  }

  async SisuAuthorize(accessToken, deviceToken, options = {}) {
    const payload = {
      AccessToken: 't=' + accessToken,
      AppId: options.authTitle,
      DeviceToken: deviceToken,
      Sandbox: 'RETAIL',
      UseModernGamertag: true,
      SiteName: 'user.auth.xboxlive.com',
      RelyingParty: options.relyingParty,
      ProofKey: this.jwk
    }

    const body = JSON.stringify(payload)

    const signature = this.sign(Endpoints.SisuAuthorize, '', body).toString('base64')

    const headers = { Signature: signature }

    const req = await fetch(Endpoints.SisuAuthorize, { method: 'post', headers, body })

    const ret = JSON.parse(await req.text())

    if (!req.ok) this.checkTokenError(parseInt(req.headers.get('x-err')), ret)

    const xsts = {
      userXUID: ret.AuthorizationToken.DisplayClaims.xui[0].xid || null,
      userHash: ret.AuthorizationToken.DisplayClaims.xui[0].uhs,
      XSTSToken: ret.AuthorizationToken.Token,
      expiresOn: ret.AuthorizationToken.NotAfter
    }

    await this.setCachedToken({ userToken: ret.UserToken, titleToken: ret.TitleToken, [createHash(options.relyingParty)]: xsts })

    return xsts
  }

  async getXSTSToken(tokens, options = {}) {
    const payload = {
      RelyingParty: options.relyingParty,
      TokenType: 'JWT',
      Properties: {
        UserTokens: [tokens.userToken],
        DeviceToken: tokens.deviceToken,
        TitleToken: tokens.titleToken,
        OptionalDisplayClaims: options.optionalDisplayClaims,
        ProofKey: this.jwk,
        SandboxId: 'RETAIL'
      }
    }

    const body = JSON.stringify(payload)
    const signature = this.sign(Endpoints.XstsAuthorize, '', body).toString('base64')

    const headers = { ...this.headers, Signature: signature }

    const req = await fetch(Endpoints.XstsAuthorize, { method: 'post', headers, body })
    const ret = JSON.parse(await req.text())
    if (!req.ok) this.checkTokenError(ret.XErr, ret)

    const xsts = {
      userXUID: ret.DisplayClaims.xui[0].xid || null,
      userHash: ret.DisplayClaims.xui[0].uhs,
      XSTSToken: ret.Token,
      expiresOn: ret.NotAfter
    }

    await this.setCachedToken({ [createHash(options.relyingParty)]: xsts })

    return xsts
  }

  /**
   * Requests an Xbox Live-related device token that uniquely links the XToken (aka xsts token)
   * @param {{ DeviceType, Version }} asDevice The hardware type and version to auth as, for example Android or Nintendo
   */
  async getDeviceToken(asDevice) {
    const payload = {
      Properties: {
        AuthMethod: 'ProofOfPossession',
        Id: `{${nextUUID()}}`,
        DeviceType: asDevice.deviceType || 'Android',
        SerialNumber: `{${nextUUID()}}`,
        Version: asDevice.deviceVersion || '0.0.0',
        ProofKey: this.jwk
      },
      RelyingParty: 'http://auth.xboxlive.com',
      TokenType: 'JWT'
    }

    const body = JSON.stringify(payload)
    const signature = this.sign(Endpoints.XboxDeviceAuth, '', body).toString('base64')
    const headers = { ...this.headers, Signature: signature }

    const ret = await fetch(Endpoints.XboxDeviceAuth, { method: 'post', headers, body }).then(checkStatus)

    await this.setCachedToken({ deviceToken: ret })

    return ret.Token
  }

  // This *only* works with live.com auth
  async getTitleToken(msaAccessToken, deviceToken) {
    const payload = {
      Properties: {
        AuthMethod: 'RPS',
        DeviceToken: deviceToken,
        RpsTicket: 't=' + msaAccessToken,
        SiteName: 'user.auth.xboxlive.com',
        ProofKey: this.jwk
      },
      RelyingParty: 'http://auth.xboxlive.com',
      TokenType: 'JWT'
    }

    const body = JSON.stringify(payload)
    const signature = this.sign(Endpoints.XboxTitleAuth, '', body).toString('base64')

    const headers = { ...this.headers, Signature: signature }

    const ret = await fetch(Endpoints.XboxTitleAuth, { method: 'post', headers, body }).then(checkStatus)

    await this.setCachedToken({ titleToken: ret })

    return ret.Token
  }
}

module.exports = XboxTokenManager