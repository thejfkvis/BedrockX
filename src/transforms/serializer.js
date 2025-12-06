const { ProtoDefCompiler } = require('protodef').Compiler
const { FullPacketParser, Serializer } = require('protodef')

// Find a way to make this dynamic later
const proto = createProtocol("1.21.124")

function createProtocol(version) {
  const protocol = require('minecraft-data')('bedrock_' + version).protocol
  const compiler = new ProtoDefCompiler()

  compiler.addTypesToCompile(protocol.types)
  compiler.addTypes(require('../datatypes/compiler-minecraft'))

  const compiledProto = compiler.compileProtoDefSync()
  return compiledProto
}

function createSerializer() {
  return new Serializer(proto, 'mcpe_packet')
}

function createDeserializer() {
  return new FullPacketParser(proto, 'mcpe_packet')
}

module.exports = { createDeserializer, createSerializer, createProtocol }