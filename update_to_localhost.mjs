import fetch from "node-fetch";
import dotenv from "dotenv";
dotenv.config();

const instId = "wa_7924857149_7149";
const WUZAPI_BASE_URL = process.env.WUZAPI_BASE_URL || "http://localhost:8080";
const LOCAL_WEBHOOK = "http://localhost:8788/webhook";

async function update() {
    console.log(`Updating instance: ${instId} to ${LOCAL_WEBHOOK}`);
    try {
        const res = await fetch(`${WUZAPI_BASE_URL}/webhook`, {
            method: "PUT",
            headers: {
                "Content-Type": "application/json",
                "token": instId
            },
            body: JSON.stringify({
                webhook: LOCAL_WEBHOOK,
                events: ["All"],
                subscribe: ["All"],
                Active: true
            })
        });
        const data = await res.json();
        console.log("Response:", JSON.stringify(data, null, 2));
    } catch (e) {
        console.error("Error:", e.message);
    }
}

update();
