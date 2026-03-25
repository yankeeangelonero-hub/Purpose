/**
 * index.js — Gravity Ledger Extension for SillyTavern
 *
 * A state machine and append-only ledger that replaces TunnelVision for Gravity v10.
 * Operates entirely through regex interception and keyword-triggered lorebook injection.
 * Zero tool calls — all writes via ---LEDGER--- block extraction, all reads via lorebook.
 *
 * Event hooks:
 *   MESSAGE_RECEIVED  → Extract ledger block, validate, persist, update state view
 *   USER_MESSAGE_SENT → Check for OOC commands, dispatch structural operations
 */

import { init as initLedger, append, getBookName } from './ledger-store.js';
import { initSnapshots, computeCurrentState, createSnapshot } from './snapshot-mgr.js';
import { validateBatch, formatErrors } from './consistency.js';
import { computeState } from './state-compute.js';
import { renderAll } from './state-view.js';
import {
    extractLedgerBlock,
    getReinforcement,
    stripLedgerBlock,
} from './regex-intercept.js';
import { processOOC } from './ooc-handler.js';
import { createPanel, updatePanel, loadStyles } from './ui-panel.js';

const MODULE_NAME = 'gravity-ledger';
const LOG_PREFIX = '[GravityLedger]';

// ─── State ─────────────────────────────────────────────────────────────────────

let _initialized = false;
let _currentState = null;
let _turnCounter = 0;
let _autoSnapshotInterval = 15; // Snapshot every N turns
let _pendingInjection = null; // Message to inject into next prompt context

// ─── Initialization ────────────────────────────────────────────────────────────

/**
 * Initialize the extension. Called once on load.
 */
async function initialize() {
    if (_initialized) return;

    try {
        await initLedger();
        const bookName = getBookName();
        await initSnapshots(bookName);
        _currentState = await computeCurrentState(bookName);
        _initialized = true;
        updatePanel(_currentState, _turnCounter);
        console.log(`${LOG_PREFIX} Initialized. Book: ${bookName}, Last TX: ${_currentState.lastTxId}`);
    } catch (err) {
        console.error(`${LOG_PREFIX} Init failed:`, err);
    }
}

// ─── Message Handlers ──────────────────────────────────────────────────────────

/**
 * Handle an incoming LLM response. Extract ledger block, validate, persist.
 * Called on MESSAGE_RECEIVED event.
 *
 * @param {Object} messageData - SillyTavern message data
 */
async function onMessageReceived(messageData) {
    if (!_initialized) await initialize();
    if (!messageData?.mes) return;

    const bookName = getBookName();
    if (!bookName) return;

    _turnCounter++;

    // Extract ledger block from response
    const extraction = extractLedgerBlock(messageData.mes);

    // Strip ledger block from displayed message
    if (extraction.found) {
        messageData.mes = extraction.cleanedMessage;
    }

    // Handle extraction results
    if (!extraction.found) {
        // No ledger block — generate reinforcement
        _pendingInjection = getReinforcement(extraction, _turnCounter);
        return;
    }

    if (extraction.error) {
        // Found but malformed
        _pendingInjection = getReinforcement(extraction, _turnCounter);
        return;
    }

    if (!extraction.transactions || extraction.transactions.length === 0) {
        // Empty ledger block — valid, no-op turn
        _pendingInjection = getReinforcement(extraction, _turnCounter);
        return;
    }

    // Validate transaction FORMAT only (spelling, structure, required fields).
    // Gameplay rules (constraint counts, state machine transitions, etc.)
    // are the LLM's responsibility — audited during OOC: eval.
    const validation = validateBatch(extraction.transactions);

    if (!validation.valid) {
        // Reject — format errors only
        _pendingInjection = formatErrors(validation.errors);
        return;
    }

    // Format valid — commit to ledger
    try {
        const committed = await append(extraction.transactions);

        // Update computed state
        _currentState = computeState(_currentState, committed);

        // Update lorebook entries
        await renderAll(bookName, _currentState);

        // Update front-end panel
        updatePanel(_currentState, _turnCounter);

        // Generate format reinforcement (drift nudges only — no gameplay warnings)
        _pendingInjection = getReinforcement(extraction, _turnCounter);

        // Auto-snapshot check
        if (_turnCounter % _autoSnapshotInterval === 0) {
            await createSnapshot(bookName, _currentState, `Auto-snapshot turn ${_turnCounter}`);
            console.log(`${LOG_PREFIX} Auto-snapshot at turn ${_turnCounter}`);
        }

        console.log(`${LOG_PREFIX} Committed ${committed.length} transactions. Turn ${_turnCounter}.`);
    } catch (err) {
        console.error(`${LOG_PREFIX} Commit failed:`, err);
        _pendingInjection = `[LEDGER ERROR: Commit failed — ${err.message}. Transactions not saved. Resubmit.]`;
    }
}

/**
 * Handle a player message. Check for OOC commands.
 * Called on USER_MESSAGE_SENT event.
 *
 * @param {Object} messageData - SillyTavern message data
 */
async function onUserMessage(messageData) {
    if (!_initialized) await initialize();
    if (!messageData?.mes) return;

    const bookName = getBookName();
    if (!bookName) return;

    const result = await processOOC(messageData.mes, bookName);
    if (result.handled && result.injection) {
        _pendingInjection = result.injection;
        // Refresh state + panel after structural OOC commands (rollback, consolidate)
        _currentState = await computeCurrentState(bookName);
        updatePanel(_currentState, _turnCounter);
    }
}

/**
 * Inject pending messages into the prompt context.
 * Called on GENERATE_BEFORE_COMBINE or similar pre-generation event.
 *
 * @returns {string|null} Text to inject, or null
 */
function getPendingInjection() {
    const injection = _pendingInjection;
    _pendingInjection = null;
    return injection;
}

// ─── SillyTavern Extension Registration ────────────────────────────────────────

/**
 * Register the extension with SillyTavern's event system.
 * This is the entry point called by SillyTavern when loading the extension.
 */
function registerExtension() {
    const context = window.SillyTavern?.getContext?.();
    if (!context) {
        console.warn(`${LOG_PREFIX} SillyTavern context not available. Running in standalone mode.`);
        return;
    }

    // Load UI
    const extensionPath = `scripts/extensions/third-party/${MODULE_NAME}`;
    loadStyles(extensionPath);
    createPanel();

    const { eventSource, event_types } = context;
        // Hook into message events
        eventSource.on(event_types.MESSAGE_RECEIVED, onMessageReceived);
        eventSource.on(event_types.USER_MESSAGE_RENDERED, onUserMessage);

        // Hook into prompt generation to inject pending messages
        eventSource.on(event_types.GENERATION_STARTED, () => {
            const injection = getPendingInjection();
            if (injection) {
                // Inject as a system message in the prompt
                // The exact mechanism depends on SillyTavern's API
                context.injectSystemMessage?.(injection) ||
                console.log(`${LOG_PREFIX} Would inject: ${injection.substring(0, 100)}...`);
            }
        });

        console.log(`${LOG_PREFIX} Extension registered. Event hooks active.`);
    }

    // Initialize the ledger store
    initialize().catch(err => console.error(`${LOG_PREFIX} Init error:`, err));
}

// ─── Exports ───────────────────────────────────────────────────────────────────

// For SillyTavern extension loading
if (typeof jQuery !== 'undefined') {
    jQuery(async () => {
        registerExtension();
    });
}

export {
    initialize,
    onMessageReceived,
    onUserMessage,
    getPendingInjection,
    registerExtension,
    // Expose for testing
    _currentState as currentState,
    _turnCounter as turnCounter,
};
