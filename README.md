# BedrockX

BedrockX is a heavily optimized version of the [Bedrock-Protocol](https://github.com/PrismarineJS/bedrock-protocol) library made by [PrismarineJS](https://github.com/PrismarineJS).

There is a example provided. You can read the source code to learn how it works.

Supports Minecraft Bedrock 1.26.60 (protocol 2225).

## NetherNet server

`Server` and `Relay` can listen over NetherNet (WebRTC) as well as RakNet. Set `transport: "NETHERNET"` and players on the same network see it in their LAN games list, through discovery on UDP port 7551.

```js
const { Server } = require("bedrockx")

const server = new Server({ transport: "NETHERNET", version: "1.26.60", motd: { motd: "My Server", levelName: "lobby" }, maxPlayers: 20 })
server.listen()
```

For joins from outside the LAN, pass a signalling connection such as `NethernetJSONRPC` as `signalling`.

## Updating from 1.26.50

Scripts that read packets keep working. Scripts that write these packets need the new fields:

| Packet | New fields |
| --- | --- |
| `animate` | `hand` (`main_hand` / `off_hand`) |
| `inventory_transaction` | `hand` on `item_use_on_entity` and `item_release` |
| `level_chunk` | `is_client_biome_update` |
| `start_game` | `editor_level_migration_version` |
| `add_entity`, `add_player` | `passenger_block_data` (optional) |
| `player_list` | `play_fab_id` on added entries, removed from `Skin` |
| `clientbound_update_sound_data` | now `event_type` + `event_tag` + the event's fields |
| `clientbound_attribute_layer_sync` | `noise_name` moved off the layer, environment attributes have a `payload_type` |

Set `version: "1.26.60"` and `protocolVersion: 2225`.

Create a issue if you find any bugs