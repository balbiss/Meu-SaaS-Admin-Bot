import fetch from "node-fetch";

const payload = {
    token: "wa_7924857149_7149",
    event: "Message",
    data: {
        RemoteJID: "123456@s.whatsapp.net",
        FromMe: false,
        Body: "Oi, teste local"
    }
};

async function test() {
    try {
        const res = await fetch("http://localhost:8788/webhook", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
        });
        const data = await res.text();
        console.log("Response:", data);
    } catch (e) {
        console.error("Error:", e.message);
    }
}

test();
