const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const fs = require("fs");
const path = require("path");
const OpenAI = require("openai");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const grok = new OpenAI({
    apiKey: "xai-",
    baseURL: "https://api.x.ai/v1",
});

app.use(express.static("public"));

const CHATS_DIR = "./chat-history/web";

/* ---------------- HELPERS ---------------- */

function userDir(userId) {
    return path.join(CHATS_DIR, userId);
}

function chatPath(userId, chatId) {
    return path.join(userDir(userId), `${chatId}.json`);
}

function loadChat(userId, chatId) {
    const file = chatPath(userId, chatId);

    if (!fs.existsSync(file)) {
        return {
            character: "",
            worldScenario: "",
            messages: []
        };
    }

    return JSON.parse(fs.readFileSync(file, "utf8"));
}

function saveChat(userId, chatId, data) {
    const dir = userDir(userId);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    fs.writeFileSync(chatPath(userId, chatId), JSON.stringify(data, null, 2));
}

function listChats(userId) {
    const dir = userDir(userId);
    if (!fs.existsSync(dir)) return [];

    return fs.readdirSync(dir)
        .filter(f => f.endsWith(".json"))
        .map(f => {
            const id = f.replace(".json", "");
            // Create a friendlier display name from the timestamp if applicable
            let name = id;
            if (id.startsWith("chat-")) {
                const timestamp = parseInt(id.split("-")[1]);
                if (!isNaN(timestamp)) {
                    name = new Date(timestamp).toLocaleDateString([], { month: 'short', day: 'numeric', hour: '2-digit', minute:'2-digit' });
                }
            }
            return { id, name };
        });
}

/* ---------------- SOCKET ---------------- */

io.on("connection", (socket) => {

    const userId = socket.handshake.auth?.userId || socket.id;

    socket.emit("chats list", listChats(userId));

    /* NEW CHAT */
    socket.on("new chat", () => {
        const id = `chat-${Date.now()}`;

        saveChat(userId, id, {
            character: "",
            worldScenario: "",
            messages: []
        });

        socket.emit("chats list", listChats(userId));
        socket.emit("open chat", id);
    });

    /* OPEN CHAT */
    socket.on("open chat", (chatId) => {
        if (!chatId) return;

        const chat = loadChat(userId, chatId);

        socket.emit("load chat", {
            chatId,
            ...chat
        });
    });

    /* CHARACTER */
    socket.on("update character", ({ chatId, character }) => {
        if (!chatId) return;

        const chat = loadChat(userId, chatId);
        chat.character = character;

        saveChat(userId, chatId, chat);
        socket.emit("load chat", { chatId, ...chat });
    });

    /* WORLD */
    socket.on("update world", ({ chatId, worldScenario }) => {
        if (!chatId) return;

        const chat = loadChat(userId, chatId);
        chat.worldScenario = worldScenario;

        saveChat(userId, chatId, chat);
        socket.emit("load chat", { chatId, ...chat });
    });

    /* CHAT MESSAGE */
    socket.on("chat message", async (data) => {
        const { chatId, message } = data;

        if (!chatId || !message) return;

        const chat = loadChat(userId, chatId);

        chat.messages.push({
            role: "user",
            content: message
        });

        try {
            const completion = await grok.chat.completions.create({
                model: "grok-4-1-fast-non-reasoning",
                messages: [
                    { role: "system", content: chat.character || "" },
                    { role: "system", content: chat.worldScenario || "" },
                    ...chat.messages
                ]
            });

            const reply = completion.choices[0].message.content;

            chat.messages.push({
                role: "assistant",
                content: reply
            });

            saveChat(userId, chatId, chat);

            socket.emit("chat response", {
                chatId,
                message: reply
            });
        } catch (err) {
            console.error("AI Error:", err);
            socket.emit("chat response", {
                chatId,
                message: "Error connecting to AI service."
            });
        }
    });
});

server.listen(3000, () => {
    console.log("Server running on http://localhost:3000");
});