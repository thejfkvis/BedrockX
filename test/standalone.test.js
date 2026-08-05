'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')
const path = require('node:path')

const root = path.resolve(__dirname, '..')

test('loads the standalone public package', () => {
  const pkg = require(root)
  assert.equal(typeof pkg.Client, 'function')
  assert.equal(typeof pkg.createClient, 'function')
  assert.equal(typeof pkg.Authflow, 'function')
})

test('loads the Bedrock 1.26.40 schema', () => {
  const schema = require(path.join(root, 'src', 'protocol', 'protocol.json'))
  assert.equal(typeof schema, 'object')
  assert.ok(schema.types || schema.packets)
})

test('loads authentication without application modules', () => {
  const { Authflow } = require(path.join(root, 'src', 'authentication'))
  assert.equal(typeof Authflow, 'function')
})

test('constructs a client without connecting', () => {
  const { Client } = require(root)
  const client = new Client({
    host: '127.0.0.1',
    port: 19132,
    version: '1.26.40',
    protocolVersion: 2168,
    transport: 'DEFAULT',
    delayedInit: true
  })
  assert.equal(client.options.protocolVersion, 2168)
  assert.equal(client.options.transport, 'DEFAULT')
})

test('exports the required UUID utility', () => {
  const { translateUUID } = require(path.join(root, 'src', 'utils', 'Util.js'))
  assert.equal(translateUUID('00112233-4455-6677-8899-aabbccddeeff'), '77665544-3322-1100-ffee-ddccbbaa9988')
})
