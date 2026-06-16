const { Client } = require('./client')

function createClient(options) {
    const client = new Client({ port: 19132, ...options, delayedInit: true })

    client.once('connect_allowed', () => connect(client))
    client.init()

    return client
}

async function connect(client) {
    client.connect()

    client.once('resource_packs_info', () => {
        client.write('resource_pack_client_response', { response_status: 'completed', resourcepackids: [] })
        client.write('request_chunk_radius', { chunk_radius: 16, max_radius: 8 })
    })
}

module.exports = { createClient }