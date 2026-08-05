const { ProtoDefCompiler } = require('protodef').Compiler
const { FullPacketParser, Serializer } = require('protodef')

// Compiles the ProtoDef schema at runtime
const protocol = require("../protocol/protocol.json")
const compiler = new ProtoDefCompiler()

const packetNamesByHeader = protocol.types.mcpe_packet[1][0].type[1].mappings

compiler.addTypesToCompile(protocol.types)
compiler.addTypes(require('../datatypes/compiler-minecraft'))

const proto = compiler.compileProtoDefSync()

function createSerializer() {
  return new Serializer(proto, 'mcpe_packet')
}

function createDeserializer() {
  return new FullPacketParser(proto, 'mcpe_packet', true)
}

function peekPacketHeader(buffer) {
  if (!Buffer.isBuffer(buffer)) return null

  let header = 0
  let shift = 0
  for (let index = 0; index < Math.min(buffer.length, 5); index += 1) {
    const byte = buffer[index]
    header |= (byte & 0x7f) << shift
    if ((byte & 0x80) === 0) {
      const packetId = header & 0x3ff
      return {
        header: header >>> 0,
        packetId,
        senderSubclient: (header >>> 10) & 0x3,
        targetSubclient: (header >>> 12) & 0x3,
        name: packetNamesByHeader[String(header)] || packetNamesByHeader[String(packetId)] || 'unknown'
      }
    }
    shift += 7
  }

  return null
}

module.exports = { createDeserializer, createSerializer, peekPacketHeader }
