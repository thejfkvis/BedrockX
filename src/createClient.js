const { Client } = require('./client')

function createClient(options) {
    const client = new Client({ port: 19132, ...options, delayedInit: true })

    client.once('connect_allowed', () => connect(client))
    // Keep the initialization promise on the client so the caller can
    // await authentication and NetherNet signaling before reporting a client
    // as established. Previously this promise was discarded.
    client.initialization = client.init()

    return client
}

async function connect(client) {
    client.options.onDiagnostic?.({ phase: 'bedrock', message: 'BedrockX start: invoking protocol client.connect().' })
    client.once('resource_packs_info', () => {
        client.write('resource_pack_client_response', {
            response_status: 'completed',
            status_id: 'resourcepackstackfinished'
        })
        client.write('request_chunk_radius', { chunk_radius: 16, max_radius: 8 })
    })

    await client.connect()
}

module.exports = { createClient }
