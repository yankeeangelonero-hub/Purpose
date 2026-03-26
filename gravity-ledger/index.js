/**
 * index.js — Gravity Ledger Extension for SillyTavern
 *
 * A state machine and append-only ledger that replaces TunnelVision for Gravity v10.
 * Operates entirely through regex interception and keyword-triggered lorebook injection.
 * Zero tool calls — all writes via ---LEDGER--- block extraction, all reads via lorebook.
 */

import { init as initLedger, reset as resetLedger, append, getBookName } from './ledger-store.js';
import { initSnapshots, computeCurrentState, createSnapshot } from './snapshot-mgr.js';
import { validateBatch, formatErrors } from './consistency.js';
import { computeState } from './state-compute.js';
import { renderAll } from './state-view.js';
import {
    extractLedgerBlock,
    getReinforcement,
} from './regex-intercept.js';
import { processOOC } from './ooc-handler.js';
import { createPanel, updatePanel, setCallbacks, setBookName } from './ui-panel.js';

const MODULE_NAME = 'gravity-ledger';
const LOG_PREFIX = '[GravityLedger]';

// ─── State ─────────────────────────────────────────────────────────────────────

let _initialized = false;
let _currentState = null;
let _turnCounter = 0;
let _autoSnapshotInterval = 15;
let _pendingInjection = null;
let _currentChatId = null;

// ─── Helpers ───────────────────────────────────────────────────────────────────

function getChatId() {
    const context = SillyTavern.getContext();
    return context.chatId || null;
}

/**
 * Attach a lorebook to the current chat so ST injects its entries into prompts.
 * Sets chat_metadata['world_info'] and saves.
 */
async function attachBookToChat(bookName) {
    const context = SillyTavern.getContext();
    const { chatMetadata, saveMetadata } = context;
    if (!chatMetadata || !bookName) return;

    if (chatMetadata['world_info'] !== bookName) {
        chatMetadata['world_info'] = bookName;
        await saveMetadata();
        $('.chat_lorebook_button').addClass('world_set');
        console.log(`${LOG_PREFIX} Attached lorebook "${bookName}" to chat.`);
    }
}

// ─── Initialization ────────────────────────────────────────────────────────────

async function initialize(force = false) {
    const chatId = getChatId();

    if (_initialized && !force && chatId === _currentChatId) return;

    _initialized = false;
    _currentState = null;
    _turnCounter = 0;
    _pendingInjection = null;

    if (!chatId) {
        console.log(`${LOG_PREFIX} No active chat.`);
        updatePanel(null, 0);
        return;
    }

    try {
        _currentChatId = chatId;
        await initLedger(chatId);
        const bookName = getBookName();
        await initSnapshots(bookName);
        _currentState = await computeCurrentState(bookName);
        _initialized = true;
        await attachBookToChat(bookName);
        setBookName(bookName);
        updatePanel(_currentState, _turnCounter);
        console.log(`${LOG_PREFIX} Initialized for chat ${chatId}. Book: ${bookName}`);
    } catch (err) {
        console.error(`${LOG_PREFIX} Init failed:`, err);
        setBookName(null);
    }
}

/**
 * Load a specific lorebook by name (called from UI).
 * @param {string} bookName
 */
async function loadBook(bookName) {
    resetLedger();
    _initialized = false;
    _currentState = null;
    _turnCounter = 0;
    _pendingInjection = null;

    try {
        await initLedger(null, bookName);
        await initSnapshots(bookName);
        _currentState = await computeCurrentState(bookName);
        _initialized = true;
        await attachBookToChat(bookName);
        setBookName(bookName);
        updatePanel(_currentState, _turnCounter);
        console.log(`${LOG_PREFIX} Loaded book: ${bookName}`);
    } catch (err) {
        console.error(`${LOG_PREFIX} Load book failed:`, err);
        setBookName(null);
    }
}

/**
 * Create and switch to a new lorebook (called from UI).
 * @param {string} bookName
 */
async function newBook(bookName) {
    await loadBook(bookName);
}

async function onChatChanged() {
    const newChatId = getChatId();
    console.log(`${LOG_PREFIX} Chat changed → ${newChatId || '(none)'}`);
    resetLedger();
    await initialize(true);
}

// ─── Message Handlers ──────────────────────────────────────────────────────────

async function onMessageReceived(messageId) {
    if (!_initialized) await initialize();

    // MESSAGE_RECEIVED passes the chat index, not the message object
    const context = SillyTavern.getContext();
    const message = context.chat?.[messageId];
    if (!message?.mes) return;

    const bookName = getBookName();
    if (!bookName) return;

    _turnCounter++;

    const extraction = extractLedgerBlock(message.mes);

    if (extraction.found) {
        message.mes = extraction.cleanedMessage;
    }

    if (!extraction.found) {
        _pendingInjection = getReinforcement(extraction, _turnCounter);
        return;
    }

    if (extraction.error) {
        _pendingInjection = getReinforcement(extraction, _turnCounter);
        return;
    }

    if (!extraction.transactions || extraction.transactions.length === 0) {
        _pendingInjection = getReinforcement(extraction, _turnCounter);
        return;
    }

    const validation = validateBatch(extraction.transactions);

    if (!validation.valid) {
        _pendingInjection = formatErrors(validation.errors);
        return;
    }

    try {
        const committed = await append(extraction.transactions);
        _currentState = computeState(_currentState, committed);
        await renderAll(bookName, _currentState);
        updatePanel(_currentState, _turnCounter);
        _pendingInjection = getReinforcement(extraction, _turnCounter);

        if (_turnCounter % _autoSnapshotInterval === 0) {
            await createSnapshot(bookName, _currentState, `Auto-snapshot turn ${_turnCounter}`);
        }

        console.log(`${LOG_PREFIX} Committed ${committed.length} TX. Turn ${_turnCounter}.`);
    } catch (err) {
        console.error(`${LOG_PREFIX} Commit failed:`, err);
        _pendingInjection = `[LEDGER ERROR: Commit failed — ${err.message}. Resubmit.]`;
    }
}

async function onUserMessage(messageId) {
    if (!_initialized) await initialize();

    const context = SillyTavern.getContext();
    const message = context.chat?.[messageId];
    if (!message?.mes) return;

    const bookName = getBookName();
    if (!bookName) return;

    const result = await processOOC(message.mes, bookName);
    if (result.handled && result.injection) {
        _pendingInjection = result.injection;
        _currentState = await computeCurrentState(bookName);
        updatePanel(_currentState, _turnCounter);
    }
}

function getPendingInjection() {
    const injection = _pendingInjection;
    _pendingInjection = null;
    return injection;
}

// ─── Entry Point ───────────────────────────────────────────────────────────────

(function init() {
    const context = SillyTavern.getContext();
    const { eventSource, event_types } = context;

    // Inject UI panel
    createPanel();
    setCallbacks({ onLoadBook: loadBook, onNewBook: newBook });

    // Chat switching
    eventSource.on(event_types.CHAT_CHANGED, onChatChanged);

    // Message events
    eventSource.on(event_types.MESSAGE_RECEIVED, onMessageReceived);
    eventSource.on(event_types.USER_MESSAGE_RENDERED, onUserMessage);

    // Prompt injection
    eventSource.on(event_types.GENERATION_STARTED, () => {
        const injection = getPendingInjection();
        if (injection) {
            console.log(`${LOG_PREFIX} Injecting: ${injection.substring(0, 100)}...`);
        }
    });

    console.log(`${LOG_PREFIX} Extension registered.`);

    // Initialize for current chat if one is already open
    initialize().catch(err => console.error(`${LOG_PREFIX} Init error:`, err));
})();
