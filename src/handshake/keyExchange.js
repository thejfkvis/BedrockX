const { ClientStatus } = require('../connection')
const JWT = require('jsonwebtoken')
const crypto = require('crypto')

const SALT = '🧂'
const curve = 'secp384r1'
const pem = { format: 'pem', type: 'sec1' }
const der = { format: 'der', type: 'spki' }

function KeyExchange(client) {
  client.ecdhKeyPair = crypto.generateKeyPairSync('ec', { namedCurve: curve })
  client.publicKeyDER = client.ecdhKeyPair.publicKey.export(der)
  client.privateKeyPEM = client.ecdhKeyPair.privateKey.export(pem)
  client.clientX509 = client.publicKeyDER.toString('base64')

  function startClientboundEncryption(publicKey) {
    const pubKeyDer = crypto.createPublicKey({ key: Buffer.from(publicKey.key, 'base64'), ...der })
    client.sharedSecret = crypto.diffieHellman({ privateKey: client.ecdhKeyPair.privateKey, publicKey: pubKeyDer })

    const secretHash = crypto.createHash('sha256').update(SALT).update(client.sharedSecret)

    client.secretKeyBytes = secretHash.digest()

    const token = JWT.sign({
      salt: toBase64(SALT),
      signedToken: client.clientX509
    }, client.ecdhKeyPair.privateKey, { algorithm: 'ES384', header: { x5u: client.clientX509 } })

    client.write('server_to_client_handshake', { token })

    const initial = client.secretKeyBytes.slice(0, 16)
    client.startEncryption(initial)
  }

  function startServerboundEncryption(token) {
    const jwt = token?.token

    const [header, payload] = jwt.split('.').map(k => Buffer.from(k, 'base64'))
    const head = JSON.parse(String(header))
    const body = JSON.parse(String(payload))

    const pubKeyDer = crypto.createPublicKey({ key: Buffer.from(head.x5u, 'base64'), ...der })

    client.sharedSecret = crypto.diffieHellman({ privateKey: client.ecdhKeyPair.privateKey, publicKey: pubKeyDer })

    const salt = Buffer.from(body.salt, 'base64')
    const secretHash = crypto.createHash('sha256').update(salt).update(client.sharedSecret)

    client.secretKeyBytes = secretHash.digest()
    const iv = client.secretKeyBytes.slice(0, 16)
    client.startEncryption(iv)

    client.write('client_to_server_handshake', {})

    client.status = ClientStatus.Initializing
  }

  client.on('server.client_handshake', startClientboundEncryption)
  client.on('client.server_handshake', startServerboundEncryption)
}

function toBase64(string) {
  return Buffer.from(string).toString('base64')
}

module.exports = { KeyExchange }