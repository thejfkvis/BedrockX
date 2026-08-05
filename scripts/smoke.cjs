'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const pkg = require(root)
const schema = require(path.join(root, 'src', 'protocol', 'protocol.json'))
const auth = require(path.join(root, 'src', 'authentication'))

assert.equal(typeof pkg.Client, 'function')
assert.equal(typeof pkg.createClient, 'function')
assert.equal(typeof pkg.Authflow, 'function')
assert.equal(typeof schema, 'object')
assert.ok(schema.types || schema.packets)
assert.equal(typeof auth.Authflow, 'function')

const client = new pkg.Client({
  host: '127.0.0.1',
  port: 19132,
  version: '1.26.40',
  protocolVersion: 2168,
  transport: 'DEFAULT',
  delayedInit: true
})
assert.equal(client.options.transport, 'DEFAULT')

console.log('BedrockX smoke checks passed: package, schema, authentication, and client construction.')
