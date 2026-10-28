const { encrypt, calculateChecksum, decrypt } = require('./crypto')
const { CompactSign } = require("jose");

const getRandomUint64 = () => {
  const high = Math.floor(Math.random() * 0xFFFFFFFF)
  const low = Math.floor(Math.random() * 0xFFFFFFFF)

  return (BigInt(high) << 32n) | BigInt(low)
}

const createPacketData = (packetName, packetId, senderId, additionalParams = {}) => {
  return {
    name: packetName,
    params: {
      sender_id: senderId,
      reserved: Buffer.allocUnsafe(8),
      ...additionalParams
    }
  }
}

const prepareSecurePacket = (serializer, packetData) => {
  const buf = serializer.createPacketBuffer(packetData)

  const checksum = calculateChecksum(buf)
  const encryptedData = encrypt(buf)

  return Buffer.concat([checksum, encryptedData])
}

const processSecurePacket = (buffer, deserializer) => {
  if (buffer.length < 32) throw new Error('Packet is too short')

  const decryptedData = decrypt(buffer.slice(32))
  const checksum = calculateChecksum(decryptedData)

  if (Buffer.compare(buffer.slice(0, 32), checksum) !== 0) throw new Error('Checksum mismatch')

  const packet = deserializer.parsePacketBuffer(decryptedData)

  return { name: packet.data.name, params: packet.data.params }
}

const createAssertion = async (fingerprint, token, ecdhKeyPair) => {
  const payload = JSON.stringify({ fingerprint: [{ algorithm: "sha-256", digest: fingerprint }] });
  const jws = await new CompactSign(Buffer.from(payload)).setProtectedHeader({ alg: "ES384" }).sign(ecdhKeyPair.privateKey);

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

  return Buffer.from(JSON.stringify(data)).toString('base64')
}

module.exports = { getRandomUint64, createPacketData, prepareSecurePacket, processSecurePacket, createAssertion }