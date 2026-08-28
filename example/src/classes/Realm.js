const XboxAPI = require("./Xbox.js");

class RealmAPI extends XboxAPI {
    constructor() {
        super()
        this.endpoint = "bedrock.frontendlegacy.realms.minecraft-services.net";
        this.headers = {
            "Accept": "*/*",
            "charset": "utf-8",
            "client-ref": "040cca85d792e94e6fe087503108295846d4933d",
            "client-version": "1.26.44",
            "x-clientplatform": "iOS",
            "x-networkprotocolversion": "2168",
            "content-type": "application/json",
            "user-agent": "MCPE/IOS",
            "Accept-Language": "en-US",
            "Accept-Encoding": "gzip, deflate, br",
            "Host": this.endpoint,
            "Connection": "Keep-Alive"
        };
    }

    async init() {
        this.authToken = await this.getXboxToken("https://pocket.realms.minecraft.net/");
    }

    async getRealms(xuid) {
        const response = await fetch(`https://${this.endpoint}/worlds`, {
            method: "GET",
            headers: {
                ...this.headers,
                "authorization": this.authToken,
            },
        });

        switch (response.status) {
            case 200:
            case 403:
                break;
            default:
                console.log(`Error: ${response.status} ${response.statusText}`);
                return response.status;
        }

        const data = await response.json();

        if (!data.servers) console.log(data.servers)

        this.ownedRealms = data.servers.filter((realm) => realm.ownerUUID === xuid);

        return data.servers;
    }

    async getRealmInfo(realmCode, quick = false) {
        const response = await fetch(`https://${this.endpoint}/worlds/v1/link/${realmCode}`, {
            method: "GET",
            headers: {
                ...this.headers,
                "authorization": this.authToken
            }
        });

        if (response.status !== 200) {
            console.log(`Error: ${response.status} ${response.statusText} ${await response.text()}, getRealmInfo`);

            return response.status;
        }

        let realm = await response.json();

        if (!realm.member) await this.joinRealm(realmCode);

        // So we can get the members and other data for /realm
        if (!quick) realm = await this.getRealmInfoByID(realm.id);

        return realm
    }

    async getRealmInfoByID(realmID) {
        const response = await fetch(`https://${this.endpoint}/worlds/${realmID}`, {
            method: "GET",
            headers: {
                ...this.headers,
                "authorization": this.authToken
            }
        });

        if (response.status !== 200) {
            console.log(`Error: ${response.status} ${response.statusText} ${await response.text()}, getRealmInfo`);

            return response.status;
        }

        return await response.json();
    }

    async joinRealm(code) {
        const response = await fetch(`https://${this.endpoint}/invites/v1/link/accept/${code}`, {
            method: "POST",
            headers: {
                ...this.headers,
                "authorization": this.authToken,
            }
        });

        if (response.status !== 200) {
            console.log(`Error: ${response.status} ${response.statusText} ${await response.text()} joinRealm`);

            return response.status;
        }

        let data = await response.json();

        return data
    }

    async getRealmIP(realmID) {
        while (true) {
            const response = await fetch(`https://${this.endpoint}/worlds/${realmID}/join`, {
                method: "GET",
                headers: {
                    ...this.headers,
                    "authorization": this.authToken
                }
            });

            switch (response.status) {
                case 200:
                    return await response.json();
                case 503:
                    await new Promise(resolve => setTimeout(resolve, 1800));
                    break;
                case 403:
                    return response.status;
                default:
                    console.log(`Error: ${response.status} ${response.statusText}`,);
                    return response.status;
            }
        }
    }

    async postStorySettings(realmID, notifications, autostories, coordinates, timeline) {
        const body = JSON.stringify({
            notifications, // Badge Notifications
            autostories, // Realm Events
            coordinates, // Realm Event Coordinates
            timeline, // Timeline
            // inGameChatMessages, // In Game Chat Messages (Unused)
            playerOptIn: "OPT_IN", // OPT_IN OR OPT_OUT
            realmOptIn: "OPT_IN" // OPT_IN OR OPT_OUT
        })

        const response = await fetch(`https://bedrock.frontendlegacy.realms.minecraft-services.net/worlds/${realmID}/stories/settings`, {
            method: "POST",
            headers: {
                ...this.headers,
                "authorization": this.authToken,
                "content-length": body.length,
            },
            body
        });

        return response.status;
    }

    async getInvites() {
        const response = await fetch(`https://${this.endpoint}/invites/pending`, {
            method: "GET",
            headers: {
                ...this.headers,
                "authorization": this.authToken,
            }
        });

        switch (response.status) {
            case 200:
            case 403:
                break;
            default:
                console.log(`Error: ${response.status} ${response.statusText} ${await response.text()}`);
                return response.status;
        }

        return (await response.json()).invites
    }

    async acceptInvite(inviteId) {
        const response = await fetch(`https://${this.endpoint}/invites/accept/${inviteId}`, {
            method: "PUT",
            headers: {
                ...this.headers,
                "authorization": this.authToken
            }
        });

        return response.status
    }

    async ban(xuid) {
        if (!xuid) return;

        const response = await fetch(`https://${this.endpoint}/worlds/${this.realm.id}/blocklist/${xuid}`, {
            method: "POST",
            headers: {
                ...this.headers,
                "authorization": this.authToken
            }
        });

        return response.status;
    }

    async kick(xuid) {
        if (!xuid) return;

        const response = await fetch(`https://${this.endpoint}/invites/${this.realm.id}/invite/update`, {
            method: "PUT",
            headers: {
                ...this.headers,
                "authorization": this.authToken
            },
            body: JSON.stringify({
                invites: { [xuid]: "REMOVE" }
            })
        });

        return response.status;
    }
}

module.exports = RealmAPI;