const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mineflayer = require('mineflayer');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

const DEFAULT_CONFIG = {
    host: 'helosmp.freezehost.com',
    port: 8861,
    username: 'WebBot_X'
};

const bots = new Map();

function toSafeText(value, fallback = '') {
    if (typeof value !== 'string') return fallback;
    return value.trim();
}

function toSafePort(value, fallback = 25565) {
    const port = Number(value);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return fallback;
    return port;
}

function sanitizeConfig(input = {}) {
    const host = toSafeText(input.host, DEFAULT_CONFIG.host);
    const username = toSafeText(input.username, DEFAULT_CONFIG.username);
    const port = toSafePort(input.port, DEFAULT_CONFIG.port);

    return {
        host: host || DEFAULT_CONFIG.host,
        port,
        username: username || DEFAULT_CONFIG.username
    };
}

function isBotAlive(entry) {
    return Boolean(entry && entry.bot && !entry.bot._client?.socket?.destroyed);
}

function getBotView(id, entry) {
    const bot = entry.bot;
    const online = Boolean(bot && bot.entity);

    return {
        id,
        username: entry.config.username,
        host: entry.config.host,
        port: entry.config.port,
        online,
        hp: typeof bot.health === 'number' ? bot.health : 0,
        food: typeof bot.food === 'number' ? bot.food : 0,
        x: bot.entity ? Math.floor(bot.entity.position.x) : 0,
        y: bot.entity ? Math.floor(bot.entity.position.y) : 0,
        z: bot.entity ? Math.floor(bot.entity.position.z) : 0,
        uptime: entry.startTime ? Math.floor((Date.now() - entry.startTime) / 1000) : 0,
        status: entry.status || 'connecting'
    };
}

function getBotList() {
    return [...bots.entries()].map(([id, entry]) => getBotView(id, entry));
}

function broadcastBotList() {
    io.emit('botList', getBotList());
}

function removeBotEntry(id) {
    const entry = bots.get(id);
    if (!entry) return;

    try {
        if (entry.bot) {
            entry.bot.removeAllListeners('spawn');
            entry.bot.removeAllListeners('chat');
            entry.bot.removeAllListeners('end');
            entry.bot.removeAllListeners('kicked');
            entry.bot.removeAllListeners('error');
            entry.bot.quit('panel stop');
        }
    } catch (err) {
        console.log(`⚠️ Lỗi khi tắt bot ${id}:`, err.message);
    }

    bots.delete(id);
}

function createBot(id, rawConfig) {
    if (bots.has(id)) {
        return { ok: false, message: 'Bot ID đã tồn tại' };
    }

    const config = sanitizeConfig(rawConfig);

    const bot = mineflayer.createBot({
        host: config.host,
        port: config.port,
        username: config.username,
        version: false
    });

    const entry = {
        bot,
        config,
        startTime: 0,
        status: 'connecting'
    };

    bots.set(id, entry);
    broadcastBotList();

    bot.on('spawn', () => {
        entry.startTime = Date.now();
        entry.status = 'online';
        console.log(`✅ ${id} online: ${config.username} @ ${config.host}:${config.port}`);
        broadcastBotList();
    });

    bot.on('chat', (username, message) => {
        io.emit('chat', {
            botId: id,
            text: `[${id}] ${username}: ${message}`
        });
    });

    bot.on('kicked', (reason) => {
        entry.status = 'kicked';
        console.log(`⚠️ ${id} kicked:`, reason);
        broadcastBotList();
    });

    bot.on('error', (err) => {
        entry.status = 'error';
        console.log(`❌ ${id} error:`, err.message);
        broadcastBotList();
    });

    bot.on('end', () => {
        console.log(`❌ ${id} disconnected`);
        entry.status = 'offline';
        broadcastBotList();

        // Tự dọn entry sau khi ngắt kết nối
        setTimeout(() => {
            const current = bots.get(id);
            if (current && current.bot === bot) {
                bots.delete(id);
                broadcastBotList();
            }
        }, 3000);
    });

    return { ok: true, message: 'Đã tạo bot' };
}

app.get('/health', (_req, res) => {
    res.json({
        ok: true,
        botCount: bots.size
    });
});

io.on('connection', (socket) => {
    console.log('🌐 Web connected:', socket.id);

    socket.emit('botList', getBotList());

    socket.on('createBot', (payload = {}, ack) => {
        const id = toSafeText(payload.id, '');
        const config = sanitizeConfig(payload.config || payload);

        const botId = id || `bot_${Date.now()}`;

        const result = createBot(botId, config);

        if (typeof ack === 'function') {
            ack({
                ok: result.ok,
                message: result.message,
                id: botId
            });
        }
    });

    socket.on('deleteBot', (id, ack) => {
        const botId = toSafeText(id, '');
        if (!botId || !bots.has(botId)) {
            if (typeof ack === 'function') {
                ack({ ok: false, message: 'Bot không tồn tại' });
            }
            return;
        }

        removeBotEntry(botId);
        broadcastBotList();

        if (typeof ack === 'function') {
            ack({ ok: true, message: 'Đã xoá bot' });
        }
    });

    socket.on('restartBot', (payload = {}, ack) => {
        const botId = toSafeText(payload.id, '');
        const config = sanitizeConfig(payload.config || {});

        if (!botId || !bots.has(botId)) {
            if (typeof ack === 'function') {
                ack({ ok: false, message: 'Bot không tồn tại' });
            }
            return;
        }

        removeBotEntry(botId);
        const result = createBot(botId, config);

        if (typeof ack === 'function') {
            ack({
                ok: result.ok,
                message: result.message
            });
        }
    });

    socket.on('chat', (payload = {}, ack) => {
        const botId = toSafeText(payload.id, '');
        const msg = toSafeText(payload.msg, '');

        const entry = bots.get(botId);
        if (!entry || !entry.bot || !msg) {
            if (typeof ack === 'function') {
                ack({ ok: false, message: 'Tin nhắn hoặc bot không hợp lệ' });
            }
            return;
        }

        try {
            entry.bot.chat(msg);
            if (typeof ack === 'function') {
                ack({ ok: true, message: 'Đã gửi' });
            }
        } catch (err) {
            if (typeof ack === 'function') {
                ack({ ok: false, message: err.message });
            }
        }
    });

    socket.on('stopAll', (_payload, ack) => {
        const ids = [...bots.keys()];
        for (const id of ids) {
            removeBotEntry(id);
        }
        broadcastBotList();

        if (typeof ack === 'function') {
            ack({ ok: true, message: 'Đã dừng toàn bộ bot' });
        }
    });

    socket.on('disconnect', () => {
        console.log('🌐 Web disconnected:', socket.id);
    });
});

setInterval(() => {
    io.emit('botList', getBotList());
}, 2000);

server.listen(3000, () => {
    console.log('🌐 Server chạy tại http://localhost:3000');
});