const { Client } = require('./client')
const { NethernetSignal } = require('./websocket/signal')

/** @param {{ version?: number, host: string, port?: number, connectTimeout?: number, skipPing?: boolean }} options */
function createClient(options) {
    const client = new Client({ port: 19132, ...options, delayedInit: true })

    client.on('connect_allowed', () => connect(client))
    client.init()

    return client
}

async function connect(client) {
    if (client.options.transport === 'NETHERNET') {
        client.nethernet.signalling = new NethernetSignal(client.connection.nethernet.networkId, client.options.authflow, client.options.version)

        await client.nethernet.signalling.connect()

        client.connection.nethernet.credentials = client.nethernet.signalling.credentials
        client.connection.nethernet.signalHandler = client.nethernet.signalling.write.bind(client.nethernet.signalling)

        client.nethernet.signalling.on('signal', signal => client.connection.nethernet.handleSignal(signal))
    }

    client.connect()

    client.once('resource_packs_info', () => {
        client.write('resource_pack_client_response', {
            response_status: 'completed',
            resourcepackids: []
        })

        client.write('request_chunk_radius', { chunk_radius: 8, max_radius: 12 })

        client.write("serverbound_loading_screen", {
            type: 1
        })
    })

    client.once('close', () => {
        if (client.options.transport != "NETHERNET") return;
        if (client.nethernet.session) client.nethernet.session.end()
        if (client.nethernet.signalling) client.nethernet.signalling.destroy()
    })
}

module.exports = { createClient }