// LAN discovery data, version 7 as sent by 1.26.60 clients hosting a world
class NethernetServerAdvertisement {
  version = 7
  motd = 'Bedrock Protocol Server'
  protocol = 2225
  gameVersion = '1.26.60'
  levelName = 'bedrock-protocol'
  playerCount = 0
  playersMax = 8
  gamemodeId = 0
  isEditorWorld = false
  hardcore = false
  unknown1 = 1
  unknown2 = 1
  worldId = require('crypto').randomBytes(8).toString('hex')
  transportLayer = 8

  constructor(obj) {
    Object.assign(this, obj)
  }

  // Server sets playersOnline for both advertisement types
  set playersOnline(value) {
    this.playerCount = value
  }

  get playersOnline() {
    return this.playerCount
  }

  static fromBuffer(buffer) {
    const advertisement = new NethernetServerAdvertisement()
    let offset = 0

    const readString = () => {
      const length = buffer.readUInt8(offset++)
      const value = buffer.toString('utf8', offset, offset + length)
      offset += length
      return value
    }

    // Signed varints are zigzag encoded
    const readZigzag = () => {
      let value = 0
      let shift = 0
      let byte
      do {
        byte = buffer.readUInt8(offset++)
        value |= (byte & 0x7f) << shift
        shift += 7
      } while (byte & 0x80)
      return (value >>> 1) ^ -(value & 1)
    }

    advertisement.version = buffer.readUInt8(offset++)
    advertisement.motd = readString()
    advertisement.protocol = readZigzag()
    advertisement.gameVersion = readString()
    advertisement.levelName = readString()
    advertisement.playerCount = readZigzag()
    advertisement.playersMax = readZigzag()
    advertisement.gamemodeId = readZigzag()
    advertisement.isEditorWorld = buffer.readUInt8(offset++) === 1
    advertisement.hardcore = buffer.readUInt8(offset++) === 1
    advertisement.unknown1 = buffer.readUInt8(offset++)
    advertisement.unknown2 = buffer.readUInt8(offset++)
    advertisement.worldId = readString()
    advertisement.transportLayer = buffer.readUInt8(offset++)

    return advertisement
  }

  toBuffer() {
    const buffers = []

    const writeString = (value) => {
      const data = Buffer.from(String(value), 'utf8')
      buffers.push(Buffer.from([data.length]), data)
    }

    const writeZigzag = (value) => {
      let v = ((value << 1) ^ (value >> 31)) >>> 0
      const bytes = []
      while (v >= 0x80) {
        bytes.push((v & 0x7f) | 0x80)
        v >>>= 7
      }
      bytes.push(v)
      buffers.push(Buffer.from(bytes))
    }

    buffers.push(Buffer.from([this.version]))
    writeString(this.motd)
    writeZigzag(this.protocol)
    writeString(this.gameVersion)
    writeString(this.levelName)
    writeZigzag(this.playerCount)
    writeZigzag(this.playersMax)
    writeZigzag(this.gamemodeId)
    buffers.push(Buffer.from([this.isEditorWorld ? 1 : 0, this.hardcore ? 1 : 0, this.unknown1, this.unknown2]))
    writeString(this.worldId)
    buffers.push(Buffer.from([this.transportLayer]))

    return Buffer.concat(buffers)
  }
}

class ServerAdvertisement {
  motd = 'Bedrock Protocol Server'
  levelName = 'bedrock-protocol'
  playersOnline = 0
  playersMax = 5
  gamemode = 'Creative'
  serverId = Date.now().toString()
  gamemodeId = 1
  portV4 = undefined
  portV6 = undefined

  constructor(obj, port, version = "1.26.60") {
    if (obj?.name) obj.motd = obj.name
    this.protocol = 2225
    this.version = version
    this.portV4 = port
    this.portV6 = port
    Object.assign(this, obj)
  }

  fromString(str) {
    const [header, motd, protocol, version, playersOnline, playersMax, serverId, levelName, gamemode, gamemodeId, portV4, portV6] = str.split(';')
    Object.assign(this, { header, motd, protocol, version, playersOnline, playersMax, serverId, levelName, gamemode, gamemodeId, portV4, portV6 })
    for (const numeric of ['playersOnline', 'playersMax', 'gamemodeId', 'portV4', 'portV6']) {
      if (this[numeric] !== undefined) {
        this[numeric] = this[numeric] ? parseInt(this[numeric]) : null
      }
    }
    return this
  }

  toString() {
    return [
      'MCPE',
      this.motd,
      this.protocol,
      this.version,
      this.playersOnline,
      this.playersMax,
      this.serverId,
      this.levelName,
      this.gamemode,
      this.gamemodeId,
      this.portV4,
      this.portV6,
      '0'
    ].join(';') + ';'
  }

  toBuffer(version) {
    const str = this.toString(version)
    const length = Buffer.byteLength(str)
    const buf = Buffer.alloc(2 + length)
    buf.writeUInt16BE(length, 0)
    buf.write(str, 2)
    return buf
  }
}

module.exports = {
  ServerAdvertisement,
  NethernetServerAdvertisement,
  getServerName(client) {
    return new ServerAdvertisement().toBuffer()
  },
  fromServerName(string) {
    return new ServerAdvertisement().fromString(string)
  }
}