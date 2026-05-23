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
            characters: [],
            worldScenario: "",
            messages: []
        };
    }

    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!data.characters) data.characters = [];
    if (!data.messages) data.messages = [];
    return data;
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

    socket.on("new chat", () => {
        const id = `chat-${Date.now()}`;
        saveChat(userId, id, { characters: [], worldScenario: "", messages: [] });
        socket.emit("chats list", listChats(userId));
        socket.emit("open chat", id);
    });

    socket.on("open chat", (chatId) => {
        if (!chatId) return;
        const chat = loadChat(userId, chatId);
        socket.emit("load chat", { chatId, ...chat });
    });

    socket.on("update characters", ({ chatId, characters }) => {
        if (!chatId || !Array.isArray(characters)) return;
        const chat = loadChat(userId, chatId);
        chat.characters = characters;
        saveChat(userId, chatId, chat);
        socket.emit("load chat", { chatId, ...chat });
    });

    socket.on("update world", ({ chatId, worldScenario }) => {
        if (!chatId) return;
        const chat = loadChat(userId, chatId);
        chat.worldScenario = worldScenario;
        saveChat(userId, chatId, chat);
        socket.emit("load chat", { chatId, ...chat });
    });

    /* CLEAR CHAT HISTORY */
    socket.on("clear chat", (chatId) => {
        if (!chatId) return;
        const chat = loadChat(userId, chatId);
        chat.messages = []; // Purge message stack arrays
        saveChat(userId, chatId, chat);
        socket.emit("load chat", { chatId, ...chat });
    });

    /* STREAMING CHAT MESSAGE INTERACTION ENGINE */
    socket.on("chat message", async (data) => {
        const { chatId, message } = data;
        if (!chatId || !message) return;

        const chat = loadChat(userId, chatId);
        chat.messages.push({ role: "user", content: message });

        const activeChars = (chat.characters || []).filter(char => char.enabled);
        
        // Dynamic structural text labeling computation for dynamic identity delivery
        let identityLabel = "Assistant";
        if (activeChars.length > 0) {
            identityLabel = activeChars.map(c => c.name).join(" & ");
        }

        const systemMessages = activeChars.map(char => ({
            role: "system",
            content: `Your name identity label is: ${char.name}. Instruction criteria parameters: ${char.text}`
        }));

        if (chat.worldScenario) {
            systemMessages.push({ role: "system", content: chat.worldScenario });
        }

        // Format history payloads stripping custom frontend visualization nodes
        const cleanHistoryPayload = chat.messages.map(m => ({
            role: m.role === "user" ? "user" : "assistant",
            content: m.content
        }));

        try {
            const stream = await grok.chat.completions.create({
                model: "grok-4-1-fast-non-reasoning",
                messages: [...systemMessages, ...cleanHistoryPayload],
                stream: true,
            });

            let fullReplyText = "";

            for await (const chunk of stream) {
                const textChunk = chunk.choices[0]?.delta?.content || "";
                if (textChunk) {
                    fullReplyText += textChunk;
                    // Emit chunk updates in real time to the socket interface client
                    socket.emit("stream chunk", {
                        chatId,
                        textChunk,
                        identityLabel
                    });
                }
            }

            // Save the finalized string into history records post-stream complete
            chat.messages.push({
                role: "assistant",
                displayName: identityLabel,
                content: fullReplyText
            });
            saveChat(userId, chatId, chat);

            socket.emit("stream complete", { chatId });

        } catch (err) {
            console.error("Streaming API Processing Error:", err);
            socket.emit("chat response", {
                chatId,
                message: "Error processing dynamic streaming responses."
            });
        }
    });
});

server.listen(3000, () => {
    console.log("Server running on http://localhost:3000");
});
