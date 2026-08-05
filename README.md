# BedrockX 1.26.40

Standalone BedrockX protocol client for Minecraft Bedrock 1.26.40 build 2168.
The package contains the protocol serializers, authentication flow, Realm
transport adapters, and the protocol data needed by the public client API.

## Install

```sh
npm install
```

The package intentionally does not include `node_modules`. Install dependencies
on the target machine before loading it.

## Basic usage

```js
const { createClient, Authflow, Titles } = require('bedrockx-1.26.40')

const authflow = new Authflow('profile-name', './profiles', {
  authTitle: Titles.MinecraftNintendoSwitch,
  deviceType: 'Win32'
})

const client = createClient({
  host: 'example.invalid',
  port: 19132,
  version: '1.26.40',
  protocolVersion: 2168,
  transport: 'DEFAULT',
  authflow
})

client.on('connect', () => console.log('connected'))
client.on('error', console.error)
```

`NETHERNET` and `NETHERNET_JSONRPC` are also available through the `transport`
option. Network access and valid platform credentials are required for an
actual login. The package does not contain credentials, token caches, or user
configuration.

## Build 2168 protocol coverage

The bundled schema and serializers target Bedrock 1.26.40 build 2168,
including the current resource-pack, start-game, creative/item, entity
metadata, chunk/subchunk, voxel, player-list, and player-auth-input layouts.
Authentication and identity payload handling are included in the package so
the client can be used without the original application tree.

## Package layout

- `index.js` and `index.d.ts`: public API
- `src/client.js`: protocol client
- `src/protocol`: build 2168 schema and packet data
- `src/authentication`: platform authentication modules
- `src/nethernet` and `src/websocket`: optional Realm transports
- `src/raknet`: default transport and platform native modules
- `src/ext`: required protocol metadata

## Validation

```sh
npm run smoke
npm test
npm run validate
npm run typecheck
```

These checks load the public entrypoint, schema, and authentication module and
construct a client without opening a network connection. No live Realm test is
claimed by this package.
