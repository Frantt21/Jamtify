#!/usr/bin/env node
'use strict';

// Spicetify Jam relay server.
//
// Every Spotify client keeps a single WebSocket to this server. The host opens
// a room with a 6-character code; guests join that room by code. Messages are
// relayed verbatim between the host and its guests, so no direct (P2P) path
// between listeners is ever required.
//
// Client -> server
//   { t: 'host',  room }                     register a new room (host)
//   { t: 'join',  room, name, image }        join an existing room (guest)
//   { t: 'msg',   to, data }                 relay `data` to a peer in the room
//   { t: 'kick',  id }                       host only: disconnect a guest
//   { t: 'leave' }                           leave the current room
//
// Server -> client
//   { t: 'ready',    room, id }              room registered
//   { t: 'joined',   room, id }              guest joined
//   { t: 'peer-open', id, name, image }      host: a guest joined
//   { t: 'peer-close', id }                  host: a guest left
//   { t: 'msg',      from, data }            relayed message
//   { t: 'kicked' }                          this guest was removed by the host
//   { t: 'host-left' }                       the host ended the session
//   { t: 'error',    code, message }         fatal (room-taken, room-not-found, ...)

const http = require('node:http');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const PATH = process.env.JAM_PATH || '/jam-ws';
const HEARTBEAT_MS = 30_000;
const MAX_GUESTS_PER_ROOM = Number(process.env.JAM_MAX_GUESTS || 64);
const MAX_PAYLOAD = 512 * 1024;
const ROOM_ID = /^[A-Z0-9]{6}$/;
const WS_OPEN = 1;

/** @type {Map<string, { host: Client, guests: Map<string, Client> }>} */
const rooms = new Map();
let guestSequence = 0;

const log = (...args) => console.log(new Date().toISOString(), '[jam-relay]', ...args);

function send(client, data) {
    const ws = client?.ws;
    if (ws && ws.readyState === WS_OPEN) ws.send(JSON.stringify(data));
}

function fail(client, code, message) {
    send(client, { t: 'error', code, message });
}

function normalizeRoom(value) {
    const room = String(value || '').trim().toUpperCase();
    return ROOM_ID.test(room) ? room : null;
}

function registerHost(client, msg) {
    if (client.role) return fail(client, 'already-registered', 'This connection already joined a room');
    const room = normalizeRoom(msg.room);
    if (!room) return fail(client, 'bad-room', 'Invalid Jam ID');
    if (rooms.has(room)) return fail(client, 'room-taken', 'That Jam ID is already in use');

    rooms.set(room, { host: client, guests: new Map() });
    client.role = 'host';
    client.id = 'host';
    client.roomId = room;
    send(client, { t: 'ready', room, id: 'host' });
    log(`room ${room} opened`);
}

function joinRoom(client, msg) {
    if (client.role) return fail(client, 'already-registered', 'This connection already joined a room');
    const room = normalizeRoom(msg.room);
    if (!room) return fail(client, 'bad-room', 'Invalid Jam ID');

    const entry = rooms.get(room);
    if (!entry) return fail(client, 'room-not-found', 'Jam not found');
    if (entry.guests.size >= MAX_GUESTS_PER_ROOM) return fail(client, 'room-full', 'This Jam is full');

    const id = `g${++guestSequence}`;
    client.role = 'guest';
    client.id = id;
    client.roomId = room;
    client.name = typeof msg.name === 'string' ? msg.name.slice(0, 80) : 'Listener';
    client.image = typeof msg.image === 'string' ? msg.image.slice(0, 500) : '';
    entry.guests.set(id, client);

    send(client, { t: 'joined', room, id });
    send(entry.host, { t: 'peer-open', id, name: client.name, image: client.image });
    log(`room ${room}: ${client.name} joined (${entry.guests.size} guests)`);
}

function relay(client, msg) {
    const entry = client.roomId ? rooms.get(client.roomId) : null;
    if (!entry) return;

    // Guests always talk to the host; the host picks a guest by id.
    const target = client.role === 'host' ? entry.guests.get(String(msg.to || '')) : entry.host;
    if (!target) return;

    send(target, { t: 'msg', from: client.id, data: msg.data });
}

function kickGuest(client, msg) {
    if (client.role !== 'host') return;
    const entry = client.roomId ? rooms.get(client.roomId) : null;
    if (!entry) return;

    const id = String(msg.id || '');
    const target = entry.guests.get(id);
    if (!target) return;

    entry.guests.delete(id);
    target.role = null;
    target.roomId = null;
    send(target, { t: 'kicked' });
    log(`room ${client.roomId}: guest ${id} kicked`);
    try { target.ws.close(4001, 'kicked'); } catch {}
}

function leave(client) {
    const roomId = client.roomId;
    client.roomId = null;
    client.role = null;
    if (!roomId) return;

    const entry = rooms.get(roomId);
    if (!entry) return;

    if (entry.host === client) {
        rooms.delete(roomId);
        for (const guest of entry.guests.values()) {
            guest.roomId = null;
            guest.role = null;
            send(guest, { t: 'host-left' });
            try { guest.ws.close(4002, 'host-left'); } catch {}
        }
        entry.guests.clear();
        log(`room ${roomId} closed (host left)`);
        return;
    }

    if (entry.guests.get(client.id) === client) {
        entry.guests.delete(client.id);
        send(entry.host, { t: 'peer-close', id: client.id });
        log(`room ${roomId}: guest ${client.id} left (${entry.guests.size} guests)`);
    }
}

function handle(client, msg) {
    switch (msg.t) {
        case 'host': return registerHost(client, msg);
        case 'join': return joinRoom(client, msg);
        case 'msg': return relay(client, msg);
        case 'kick': return kickGuest(client, msg);
        case 'leave': return leave(client);
        default: return;
    }
}

const server = http.createServer((req, res) => {
    if (req.url === '/health' || req.url === '/') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('ok');
        return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
});

const wss = new WebSocketServer({ server, path: PATH, maxPayload: MAX_PAYLOAD });

wss.on('connection', ws => {
    const client = { ws, id: null, role: null, roomId: null, name: '', image: '' };
    ws.isAlive = true;

    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('message', raw => {
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch { return; }
        if (!msg || typeof msg.t !== 'string') return;
        try { handle(client, msg); } catch (error) { log('handler error', error); }
    });
    ws.on('close', () => leave(client));
    ws.on('error', () => { try { ws.close(); } catch {} });
});

const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
        if (ws.isAlive === false) { ws.terminate(); continue; }
        ws.isAlive = false;
        try { ws.ping(); } catch {}
    }
}, HEARTBEAT_MS);
heartbeat.unref();

wss.on('close', () => clearInterval(heartbeat));

server.listen(PORT, HOST, () => {
    log(`listening on ws://${HOST}:${PORT}${PATH} (health: http://${HOST}:${PORT}/health)`);
});

module.exports = { server, wss, rooms };
