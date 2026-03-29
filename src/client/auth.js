const { Authflow: PrismarineAuth } = require('prismarine-auth')

async function authenticate(client, options) {
  try {
    options.authflow ??= new PrismarineAuth(options.username, options.profilesFolder, options, options.onMsaCode)

    const MCTOKEN = (await options.authflow.getMinecraftBedrockServicesToken({ version: client.options.version })).mcToken
    const body = JSON.stringify({ publicKey: client.clientX509 })

    const response = await fetch("https://authorization.franchise.minecraft-services.net/api/v1.0/multiplayer/session/start", {
      method: "POST",
      headers: {
        "accept": "*/*",
        "authorization": MCTOKEN,
        "content-type": "application/json",
        "User-Agent": "libhttpclient/1.0.0.0",
        "Accept-Language": "en-US",
        "Accept-Encoding": "gzip, deflate, br",
        "Content-Length": body.length
      },
      body
    })

    const result = await response.json()

    if (result.code === "PlayerBanned") {
      throw new Error(JSON.stringify({
        "path": "/multiplayer/bedrock/authentication",
        "error": "FORBIDDEN"
      }))
    }

    const signedToken = result.result.signedToken

    const chains = await options.authflow.getMinecraftBedrockToken(client.clientX509).catch(e => {
      throw e
    })

    const jwt = chains[1]
    const [h, payload] = jwt.split('.').map(k => Buffer.from(k, 'base64')) // eslint-disable-line
    const xboxProfile = JSON.parse(String(payload))

    client.profile = xboxProfile?.extraData
    client.chain = chains
    client.token = signedToken
    client.emit('session', xboxProfile)
  } catch (err) {
    console.error(err)
    client.emit('error', err)
  }
}

module.exports = { authenticate }