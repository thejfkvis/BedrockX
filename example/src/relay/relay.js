const { Authflow, Titles } = require("prismarine-auth");

const Player = require("./player");
const localIp = require("ip").address();

const { Relay } = require("../../../index");

async function createRelay(realm) {
    const relay = new Relay({
        host: localIp,
        // The port to start the relay at
        port: 12345,
        profilesFolder: "./auth",
        authTitle: Titles.MinecraftIOS,
        deviceType: "iOS",
        flow: "sisu",
        authflow: new Authflow(undefined, "./auth", {
            flow: "sisu",
            authTitle: Titles.MinecraftIOS,
            deviceType: "iOS",
        }, (data) => {
            console.log(`${data.message}`);
        }),
        omitParseErrors: false,
        protocolVersion: 2168,
        compressionAlgorithm: "deflate",
        compressionLevel: 7,
        compressionThreshold: 512,
        destination: {
            host: realm.transport === "DEFAULT" ? realm.ip : undefined,
            port: realm.transport === "DEFAULT" ? realm.port : undefined,
            transport: realm.transport,
            networkId: realm.transport.includes("NETHERNET") ? realm.networkId : undefined,
        }
    });

    relay.conLog = console.log;
    relay.listen();

    relay.on("connect", async (player) => {
        console.log("Player connected");

        new Player(player);
    });
}

module.exports = { createRelay }