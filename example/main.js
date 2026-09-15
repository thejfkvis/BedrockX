const prompt = require("prompt-sync")();

const RealmAPI = require("./src/classes/Realm");
const createInstance = require("./src/client/Instance.js");
const { createRelay } = require("./src/relay/relay.js");

(async () => {
    let RAPI = new RealmAPI();
    await RAPI.init();

    let realms = await RAPI.getRealms(RAPI.xuid);
    realms = realms.filter(realm => !realm.expired && realm.state !== "CLOSED").sort((a, b) => a.id - b.id);

    let realm = {};

    console.log(`${"-".repeat(35)}\n`, realms.map((realm, i) => `-> ${i + 1}. ${realm.name}`).join("\n"), `\n${"-".repeat(35)}`);

    const selection = Number(prompt("--> Select a number: "));

    if (selection < 10000) realm = realms[selection - 1];

    if (!realm) {
        console.log(`---> Invalid choice`);
        process.exit(1);
    }

    const realmIP = await RAPI.getRealmIP(realm.id);

    switch (realmIP.networkProtocol) {
        case "DEFAULT":
            realm.ip = realmIP.address.substring(0, realmIP.address.indexOf(':'));
            realm.port = Number(realmIP.address.substring(realmIP.address.indexOf(':') + 1));
            break
        case "NETHERNET":
        case "NETHERNET_JSONRPC":
            realm.networkId = realmIP.address;
            break;
    }

    realm.transport = realmIP.networkProtocol;

    // Change to createRelay if you want to use a relay, otherwise, keep createInstance
    createInstance(realm, RAPI);
})();