// WebSocket transport for Spicetify Jam.
//
// Replaces the previous peer-to-peer (WebRTC/PeerJS) transport: every client
// keeps one WebSocket to the Jam relay server, which forwards messages between
// the host and its guests. The public surface intentionally mirrors the small
// slice of PeerJS that JamContext relied on (DataConnection: peer/open/send/
// on('data'|'close'), Peer: on('open'|'connection'|'error'), connect, destroy),
// so the playback, queue and sync logic stays unchanged.

const DEFAULT_SERVER_URL = 'wss://kyzen-vps-new-1.tail9c3971.ts.net/jam-ws';
const SERVER_URL_KEY = 'jam_server';

/** Relay endpoint. Override at runtime with localStorage.setItem('jam_server', 'ws://localhost:8080/jam-ws'). */
export const jamServerUrl = (): string => {
    try {
        const custom = localStorage.getItem(SERVER_URL_KEY);
        if (custom) return custom;
    } catch {}
    return DEFAULT_SERVER_URL;
};

type Listener = (arg?: any) => void;
export type JamCloseReason = 'kicked' | 'host-left' | 'unreachable' | 'socket';

class Emitter {
    private listeners = new Map<string, Listener[]>();

    on(event: string, cb: Listener) {
        const list = this.listeners.get(event) || [];
        list.push(cb);
        this.listeners.set(event, list);
        return this;
    }

    emit(event: string, arg?: any) {
        for (const cb of (this.listeners.get(event) || []).slice()) {
            try { cb(arg); } catch (error) { console.warn('[Spicetify Jam] transport listener failed', error); }
        }
    }
}

/** Mirrors the PeerJS DataConnection API used by JamContext. */
export interface JamDataConnection {
    peer: string;
    open: boolean;
    send(data: unknown): void;
    close(): void;
    on(event: 'open' | 'data' | 'close', cb: Listener): void;
}

class Conn extends Emitter implements JamDataConnection {
    open = false;

    constructor(
        public peer: string,
        private readonly transmit: (peer: string, data: unknown) => void,
        private readonly drop: (peer: string) => void,
    ) { super(); }

    send(data: unknown) { this.transmit(this.peer, data); }

    close() {
        this.open = false;
        this.drop(this.peer);
    }
}

export interface JamSocketOptions {
    /** true: open a room as host. false: join an existing room as guest. */
    host: boolean;
    room: string;
}

export class JamSocket extends Emitter {
    /** Room code (host) or joined room code (guest). */
    id = '';

    private ws: WebSocket | null = null;
    private conns = new Map<string, Conn>();
    private options: JamSocketOptions;
    private closed = false;
    private attempt = 0;
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    constructor(options: JamSocketOptions) {
        super();
        this.options = options;
        this.openSocket();
    }

    // ── PeerJS-compatible entry points ────────────────────────────────────

    /** Guest: returns the connection to the host. Safe to call again after a reconnect. */
    connect(room: string): JamDataConnection {
        this.options = { host: false, room };
        if (this.closed) return this.createConn('host');
        if (!this.ws || this.ws.readyState > 1) {
            this.attempt = 0;
            this.openSocket();
        }
        return this.conns.get('host') || this.createConn('host');
    }

    destroy() {
        this.closed = true;
        this.clearReconnect();
        for (const conn of this.conns.values()) conn.open = false;
        this.conns.clear();
        const ws = this.ws;
        this.ws = null;
        try { ws?.close(1000, 'closed'); } catch {}
    }

    // ── Socket plumbing ───────────────────────────────────────────────────

    private openSocket() {
        if (this.closed) return;
        let ws: WebSocket;
        try {
            ws = new WebSocket(jamServerUrl());
        } catch {
            this.emit('error', { type: 'network', message: 'Could not reach the Jam server' });
            return;
        }
        this.ws = ws;

        ws.onopen = () => {
            if (ws !== this.ws) return;
            ws.send(JSON.stringify(this.options.host
                ? { t: 'host', room: this.options.room }
                : { t: 'join', room: this.options.room }));
        };
        ws.onmessage = event => {
            if (ws !== this.ws) return;
            let msg: any;
            try { msg = JSON.parse(String(event.data)); } catch { return; }
            if (msg && typeof msg.t === 'string') this.receive(msg);
        };
        ws.onerror = () => { /* surfaced through onclose */ };
        ws.onclose = () => { if (ws === this.ws) this.handleClose(); };
    }

    private receive(msg: any) {
        switch (msg.t) {
            case 'ready':
            case 'joined': {
                this.attempt = 0;
                this.id = String(msg.room || this.options.room);
                let conn: Conn;
                if (this.options.host) {
                    this.emit('open', this.id);
                    return;
                }
                conn = this.conns.get('host') || this.createConn('host');
                conn.open = true;
                // Emit the transport event first so JamContext can attach its
                // handlers, then open the connection (also on reconnects, which
                // re-sends JOIN so the host re-registers this member).
                this.emit('open', this.id);
                setTimeout(() => { if (conn.open) conn.emit('open'); }, 0);
                return;
            }
            case 'peer-open': {
                const conn = this.conns.get(String(msg.id)) || this.createConn(String(msg.id));
                conn.open = true;
                this.emit('connection', conn);
                conn.emit('open');
                return;
            }
            case 'peer-close': {
                const id = String(msg.id);
                const conn = this.conns.get(id);
                if (!conn) return;
                conn.open = false;
                this.conns.delete(id);
                conn.emit('close', 'socket');
                return;
            }
            case 'msg': {
                const peer = this.options.host ? String(msg.from) : 'host';
                const conn = this.conns.get(peer) || this.createConn(peer);
                conn.open = true;
                conn.emit('data', msg.data);
                return;
            }
            case 'kicked': this.finish('kicked'); return;
            case 'host-left': this.finish('host-left'); return;
            case 'error': this.handleServerError(msg); return;
            default: return;
        }
    }

    private handleServerError(msg: any) {
        const message = typeof msg.message === 'string' ? msg.message : 'Jam server error';
        this.emit('error', { type: String(msg.code || 'server-error'), message });
        this.destroy();
    }

    private handleClose() {
        this.ws = null;
        for (const conn of this.conns.values()) conn.open = false;
        if (this.closed) return;
        // The host owns the room, so a dropped socket ends the session; guests
        // retry joining a few times before giving up.
        if (this.options.host) {
            this.emit('close', 'socket');
            return;
        }
        if (this.attempt >= 3) {
            this.emit('close', 'unreachable');
            return;
        }
        const delay = 1500 * (this.attempt + 1);
        this.attempt++;
        this.emit('reconnecting', { attempt: this.attempt, delay });
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.openSocket();
        }, delay);
    }

    /** Stops all activity and reports a final reason (kicked, host-left, ...). */
    private finish(reason: JamCloseReason) {
        this.closed = true;
        this.clearReconnect();
        for (const conn of this.conns.values()) {
            conn.open = false;
            conn.emit('close', reason);
        }
        this.conns.clear();
        const ws = this.ws;
        this.ws = null;
        try { ws?.close(4000, reason); } catch {}
        this.emit('close', reason);
    }

    private clearReconnect() {
        if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    }

    private createConn(peer: string) {
        const conn = new Conn(
            peer,
            (to, data) => this.transmit(to, data),
            to => this.dropPeer(to),
        );
        this.conns.set(peer, conn);
        return conn;
    }

    private transmit(to: string, data: unknown) {
        const ws = this.ws;
        if (!ws || ws.readyState !== 1) return;
        try { ws.send(JSON.stringify({ t: 'msg', to, data })); } catch {}
    }

    /** Host closing a guest connection kicks it on the server; a guest closing the host connection leaves. */
    private dropPeer(peer: string) {
        if (!this.options.host) { this.destroy(); return; }
        this.conns.delete(peer);
        const ws = this.ws;
        if (ws && ws.readyState === 1) {
            try { ws.send(JSON.stringify({ t: 'kick', id: peer })); } catch {}
        }
    }
}
