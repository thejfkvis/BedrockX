const { ProtoDefCompiler } = require('protodef').Compiler
const { FullPacketParser, Serializer } = require('protodef')

const fs = require('fs')
// Find a way to make this dynamic later
const proto = createProtocol("1.21.100")

class Parser extends FullPacketParser {
  dumpFailedBuffer (packet) {
    if (packet.length > 1000) {
      const now = Date.now()
      fs.writeFileSync(now + '_packetReadError.txt', packet.toString('hex'))
      console.log(prefix, `Deserialization failure for packet 0x${packet.slice(0, 1).toString('hex')}. Packet buffer saved in ./${now}_packetReadError.txt as buffer was too large (${packet.length} bytes).`)
    } else {
      console.log(prefix, 'Read failure for 0x' + packet.slice(0, 1).toString('hex'), packet.slice(0, 1000))
    }
  }
}

// Compiles the ProtoDef schema at runtime
function createProtocol (version) {
  const protocol = require('minecraft-data')('bedrock_' + version).protocol
  const compiler = new ProtoDefCompiler()

  compiler.addTypesToCompile(protocol.types)
  compiler.addTypes(require('../datatypes/compiler-minecraft'))

  const compiledProto = compiler.compileProtoDefSync()
  return compiledProto
}

function createSerializer () {
  return new Serializer(proto, 'mcpe_packet')
}

function createDeserializer () {
  return new Parser(proto, 'mcpe_packet')
}

module.exports = { createDeserializer, createSerializer, createProtocol }