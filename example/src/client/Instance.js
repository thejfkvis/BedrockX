const { createClient } = require("../../../index");
const { Authflow, Titles } = require("prismarine-auth");

async function createInstance(realm, RAPI) {
    RAPI.realm = realm;

    await RAPI.postStorySettings(realm.id, true, true, true, true)

    const options = {
        host: realm.transport === "DEFAULT" ? realm.ip : undefined,
        port: realm.transport === "DEFAULT" ? realm.port : undefined,
        profilesFolder: "./auth",
        authTitle: Titles.MinecraftIOS,
        deviceType: "iOS",
        flow: "sisu",

        protocolVersion: 2169,
        authflow: new Authflow(undefined, "./auth", {
            flow: "sisu",
            authTitle: Titles.MinecraftIOS,
            deviceType: "iOS",
        }, (data) => {
            console.log(`${data.message}`);
        }),
        transport: realm.transport,
        networkId: realm.transport.includes("NETHERNET") ? realm.networkId : undefined,
        skinData: {}
    };

    const instance = createClient(options);

    console.log(`Connecting to ${realm.name}`);

    instance._disconnect = instance.disconnect;

    let wasKicked = false, interval;

    const updatePresence = async () => {
        await RAPI.sendPresence({})
        // await RAPI.sendInGamePresence(realm, true)
    }

    interval = setInterval(updatePresence, 60000);

    instance.disconnect = () => {
        wasKicked = true;

        instance._disconnect();
    };

    instance.on("kick", async (data) => {
        wasKicked = true;

        console.log(`${JSON.stringify(data)}`);

        clearInterval(interval);
    });

    instance.on("error", (error) => {
        console.log(error)

        if (wasKicked) return;

        instance.emit("kick", { message: String(error) });
    });

    instance.on("close", () => {
        if (wasKicked) return;

        instance.emit("kick", { message: "Lost connection" });
    });

    instance.on("play_status", async (data) => {
        switch (data.status) {
            case 'login_success':
                console.log(`Connected to ${realm.name}`);
                break;
            case 'player_spawn':
                instance.write("serverbound_loading_screen", {
                    type: 1
                });

                instance.write("serverbound_loading_screen", {
                    type: 2
                });

                break;
        }
    });

    instance.on("start_game", () => {
        console.log(`Spawned into ${realm.name}`);
    })
}

module.exports = createInstance;