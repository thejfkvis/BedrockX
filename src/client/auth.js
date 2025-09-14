const { Authflow: PrismarineAuth } = require('prismarine-auth')

async function authenticate(client, options) {
  try {
    options.authflow ??= new PrismarineAuth(options.username, options.profilesFolder, options, options.onMsaCode)

    const chains = await options.authflow.getMinecraftBedrockToken(client.clientX509).catch(e => {
      throw e
    })

    const jwt = chains[1]
    const [h, payload] = jwt.split('.').map(k => Buffer.from(k, 'base64')) // eslint-disable-line
    const xboxProfile = JSON.parse(String(payload))

    client.profile = xboxProfile?.extraData
    client.chain = chains
    client.emit('session', xboxProfile)
  } catch (err) {
    console.error(err)
    client.emit('error', err)
  }
}

module.exports = { authenticate }