#!/usr/bin/env node
'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');

const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT || 8787);
const SYNC_TOKEN = process.env.SYNC_TOKEN || '';
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'targets-store.json');
const MAX_BODY_BYTES = 1024 * 1024;

function normalizeTargets(input) {
    const normalized = {};
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        return normalized;
    }
    Object.keys(input).forEach((key) => {
        if (!key) {
            return;
        }
        const value = input[key];
        if (value === true) {
            normalized[key] = { name: '' };
            return;
        }
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            return;
        }
        const copy = Object.assign({}, value);
        copy.name = typeof copy.name === 'string' ? copy.name : '';
        normalized[key] = copy;
    });
    return normalized;
}

function safeNumber(value, fallback) {
    const num = Number(value);
    return Number.isFinite(num) ? num : fallback;
}

function looksLikeTargetKey(key) {
    return typeof key === 'string' && (key.startsWith('id:') || key.startsWith('name:'));
}

function looksLikeTargetMap(obj) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
        return false;
    }
    const keys = Object.keys(obj);
    if (keys.length === 0) {
        return false;
    }
    return keys.every((key) => looksLikeTargetKey(key));
}

function normalizeCoord(coord) {
    const raw = String(coord || '').trim();
    if (!raw) {
        return '';
    }
    const parts = raw.split(':');
    if (parts.length !== 3) {
        return '';
    }
    const nums = parts.map((part) => Number(part));
    if (nums.some((num) => Number.isNaN(num) || num <= 0)) {
        return '';
    }
    return nums.join(':');
}

function normalizeCoordList(input) {
    if (!Array.isArray(input)) {
        return [];
    }
    const set = new Set();
    input.forEach((item) => {
        const coord = normalizeCoord(item);
        if (coord) {
            set.add(coord);
        }
    });
    return Array.from(set);
}

function normalizeControl(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        return null;
    }
    const action = String(input.action || '').toLowerCase();
    if (action !== 'start' && action !== 'stop') {
        return null;
    }
    const cmdId = String(input.cmdId || '').trim();
    if (!cmdId) {
        return null;
    }
    return {
        cmdId: cmdId,
        action: action,
        issuedAt: safeNumber(input.issuedAt, Date.now()),
        continuous: Boolean(input.continuous),
        queue: normalizeCoordList(input.queue),
        scanDelayMs: safeNumber(input.scanDelayMs, 1000),
        continuousIntervalMs: safeNumber(input.continuousIntervalMs, 60000)
    };
}

function loadState() {
    try {
        if (!fs.existsSync(DATA_FILE)) {
            return { targets: {}, updatedAt: 0, control: null, controlUpdatedAt: 0 };
        }
        const raw = fs.readFileSync(DATA_FILE, 'utf8');
        if (!raw.trim()) {
            return { targets: {}, updatedAt: 0, control: null, controlUpdatedAt: 0 };
        }
        const parsed = JSON.parse(raw);
        return {
            targets: normalizeTargets(parsed.targets),
            updatedAt: safeNumber(parsed.updatedAt, 0),
            control: normalizeControl(parsed.control),
            controlUpdatedAt: safeNumber(parsed.controlUpdatedAt, 0)
        };
    } catch (err) {
        console.warn('[targets-sync-server] failed to load state:', err.message);
        return { targets: {}, updatedAt: 0, control: null, controlUpdatedAt: 0 };
    }
}

let state = loadState();

function persistState() {
    const tmpFile = DATA_FILE + '.tmp';
    fs.writeFileSync(tmpFile, JSON.stringify(state, null, 2), 'utf8');
    fs.renameSync(tmpFile, DATA_FILE);
}

function sendJson(res, statusCode, payload) {
    const body = JSON.stringify(payload);
    res.statusCode = statusCode;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-PTRE-Token, x-ptre-token');
    res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, OPTIONS');
    res.end(body);
}

function isAuthorized(req) {
    if (!SYNC_TOKEN) {
        return true;
    }
    const sent = req.headers['x-ptre-token'];
    return sent === SYNC_TOKEN;
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        let bytes = 0;
        let body = '';
        req.on('data', (chunk) => {
            bytes += chunk.length;
            if (bytes > MAX_BODY_BYTES) {
                reject(new Error('payload too large'));
                req.destroy();
                return;
            }
            body += chunk.toString('utf8');
        });
        req.on('end', () => resolve(body));
        req.on('error', reject);
    });
}

function parseUpdatePayload(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        return null;
    }
    const update = {};

    if (Object.prototype.hasOwnProperty.call(payload, 'targets') || looksLikeTargetMap(payload)) {
        const rawTargets = Object.prototype.hasOwnProperty.call(payload, 'targets') ? payload.targets : payload;
        update.targets = normalizeTargets(rawTargets);
        update.updatedAt = safeNumber(payload.updatedAt, Date.now());
    }

    if (Object.prototype.hasOwnProperty.call(payload, 'control')) {
        const control = normalizeControl(payload.control);
        if (control) {
            update.control = control;
            update.controlUpdatedAt = safeNumber(payload.controlUpdatedAt, Date.now());
        }
    }

    if (!Object.keys(update).length) {
        return null;
    }
    return update;
}

const server = http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') {
        sendJson(res, 204, {});
        return;
    }

    const pathname = (req.url || '').split('?')[0];
    if (pathname !== '/targets') {
        sendJson(res, 404, { error: 'not found' });
        return;
    }

    if (!isAuthorized(req)) {
        sendJson(res, 401, { error: 'unauthorized' });
        return;
    }

    if (req.method === 'GET') {
        sendJson(res, 200, state);
        return;
    }

    if (req.method !== 'PUT') {
        sendJson(res, 405, { error: 'method not allowed' });
        return;
    }

    try {
        const rawBody = await readBody(req);
        const parsed = rawBody ? JSON.parse(rawBody) : {};
        const update = parseUpdatePayload(parsed);
        if (!update) {
            sendJson(res, 400, { error: 'invalid payload' });
            return;
        }
        if (Object.prototype.hasOwnProperty.call(update, 'targets')) {
            state.targets = update.targets;
            state.updatedAt = update.updatedAt;
        }
        if (Object.prototype.hasOwnProperty.call(update, 'control')) {
            state.control = update.control;
            state.controlUpdatedAt = update.controlUpdatedAt;
        }
        persistState();
        sendJson(res, 200, state);
    } catch (err) {
        sendJson(res, 400, { error: err.message || 'bad request' });
    }
});

server.listen(PORT, HOST, () => {
    console.log('[targets-sync-server] listening on http://' + HOST + ':' + PORT + '/targets');
    if (!SYNC_TOKEN) {
        console.log('[targets-sync-server] warning: SYNC_TOKEN is empty');
    }
});
