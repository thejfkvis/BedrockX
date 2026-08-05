const { Client, decodeConnectError, createConnectError, formatConnectErrorMetadata } = require('./src/client')
const { SignalStructure } = require('./src/signalling')

const SignalType = {
  ConnectRequest: 'CONNECTREQUEST',
  ConnectResponse: 'CONNECTRESPONSE',
  CandidateAdd: 'CANDIDATEADD',
  ConnectError: 'CONNECTERROR'
}

module.exports = { Client, SignalType, SignalStructure, decodeConnectError, createConnectError, formatConnectErrorMetadata }
