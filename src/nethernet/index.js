const { Client } = require('./src/client')
const { Server } = require('./src/server')
const { SignalStructure } = require('./src/signalling')

const SignalType = {
  ConnectRequest: 'CONNECTREQUEST',
  ConnectResponse: 'CONNECTRESPONSE',
  CandidateAdd: 'CANDIDATEADD',
  ConnectError: 'CONNECTERROR'
}

module.exports = { Client, Server, SignalType, SignalStructure }