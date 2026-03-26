/**
 * ledger-store.js — Append-only ledger storage in lorebook entries.
 *
 * Transactions are stored as JSON arrays in lorebook entries. When a partition
 * exceeds MAX_PARTITION_SIZE, it's archived and a new active partition is created.
 * Partitions are disabled lorebook entries (not injected into prompt).
 */

import { ensureLedgerBook, findEntryByComment, createEntry, updateEntry } from './lorebook-api.js';

const MAX_PARTITION_SIZE = 50; // Max transactions per partition before archiving
const ACTIVE_COMMENT = 'Gravity_Ledger_Active';
const ARCHIVE_PREFIX = 'Gravity_Ledger_Archive_';

let _bookName = null;
let _txCounter = 0;
let _cachedTransactions = null; // In-memory cache of active partition
let _currentChatId = null;

/**
 * Reset the ledger store state. Called when switching chats.
 */
function reset() {
    _bookName = null;
    _txCounter = 0;
    _cachedTransactions = null;
    _currentChatId = null;
}

/**
 * Initialize the ledger store. Ensures the lorebook and active partition exist.
 * @param {string} [chatId] - The chat ID to scope the ledger to
 * @param {string} [explicitBookName] - Load a specific book by name (overrides chatId)
 * @returns {Promise<void>}
 */
async function init(chatId, explicitBookName) {
    // If switching to a different chat, reset first
    if (chatId && _currentChatId && chatId !== _currentChatId) {
        reset();
    }
    _currentChatId = chatId || null;
    _bookName = explicitBookName || await ensureLedgerBook(chatId);
    const active = await findEntryByComment(_bookName, ACTIVE_COMMENT);
    if (!active) {
        await createEntry(_bookName, {
            comment: ACTIVE_COMMENT,
            content: '[]',
            constant: false,
            disable: true, // Never injected into prompt
            key: [],
        });
        _txCounter = 0;
        _cachedTransactions = [];
    } else {
        _cachedTransactions = parseTransactions(active.content);
        _txCounter = _cachedTransactions.length > 0
            ? Math.max(..._cachedTransactions.map(tx => tx.tx)) + 1
            : 0;
    }
}

/**
 * Parse transactions from a lorebook entry's content.
 * Lenient — handles common LLM serialization quirks.
 * @param {string} content
 * @returns {Array}
 */
function parseTransactions(content) {
    if (!content || content.trim() === '') return [];
    try {
        return JSON.parse(content);
    } catch {
        // Try lenient parsing: strip trailing commas, fix single quotes
        try {
            const cleaned = content
                .replace(/,\s*([}\]])/g, '$1')  // trailing commas
                .replace(/'/g, '"');              // single quotes
            return JSON.parse(cleaned);
        } catch {
            console.warn('[GravityLedger] Failed to parse ledger partition:', content.substring(0, 200));
            return [];
        }
    }
}

/**
 * Assign transaction IDs and normalize fields.
 * @param {Array} transactions
 * @returns {Array} Normalized transactions with tx_id assigned
 */
function normalizeTransactions(transactions) {
    return transactions.map(tx => ({
        tx: tx.tx ?? _txCounter++,
        t: tx.t || tx.timestamp || '',
        op: tx.op || tx.type || 'S',
        e: tx.e || tx.entity || '',
        id: tx.id || tx.entity_id || '',
        d: tx.d || tx.data || {},
        r: tx.r || tx.reason || '',
    }));
}

/**
 * Append validated transactions to the active ledger partition.
 * @param {Array} transactions - Already validated and normalized transactions
 * @returns {Promise<Array>} The committed transactions (with assigned tx_ids)
 */
async function append(transactions) {
    if (!_bookName) await init();

    const normalized = normalizeTransactions(transactions);

    // Add to in-memory cache
    _cachedTransactions.push(...normalized);

    // Check if we need to archive
    if (_cachedTransactions.length > MAX_PARTITION_SIZE) {
        await archiveActive();
    } else {
        // Persist to lorebook
        await persistActive();
    }

    return normalized;
}

/**
 * Write the in-memory cache to the active lorebook entry.
 */
async function persistActive() {
    const active = await findEntryByComment(_bookName, ACTIVE_COMMENT);
    if (active) {
        await updateEntry(_bookName, active.uid, {
            content: JSON.stringify(_cachedTransactions, null, 0),
        });
    }
}

/**
 * Archive the active partition and create a new one.
 */
async function archiveActive() {
    const active = await findEntryByComment(_bookName, ACTIVE_COMMENT);
    if (!active) return;

    // Count existing archives for naming
    const archiveNum = await countArchives();

    // Rename current active to archive
    await updateEntry(_bookName, active.uid, {
        comment: `${ARCHIVE_PREFIX}${archiveNum}`,
    });

    // Create new active partition
    _cachedTransactions = [];
    await createEntry(_bookName, {
        comment: ACTIVE_COMMENT,
        content: '[]',
        constant: false,
        disable: true,
        key: [],
    });
}

/**
 * Count existing archive partitions.
 * @returns {Promise<number>}
 */
async function countArchives() {
    const { getEntries } = await import('./lorebook-api.js');
    const entries = await getEntries(_bookName);
    let count = 0;
    for (const entry of Object.values(entries)) {
        if (entry.comment && entry.comment.startsWith(ARCHIVE_PREFIX)) count++;
    }
    return count;
}

/**
 * Get all transactions from all partitions (archives + active), in order.
 * @returns {Promise<Array>}
 */
async function getAllTransactions() {
    if (!_bookName) await init();

    const { getEntries } = await import('./lorebook-api.js');
    const entries = await getEntries(_bookName);

    // Collect archives in order
    const archives = [];
    for (const [uid, entry] of Object.entries(entries)) {
        if (entry.comment && entry.comment.startsWith(ARCHIVE_PREFIX)) {
            const num = parseInt(entry.comment.replace(ARCHIVE_PREFIX, ''), 10);
            archives.push({ num, content: entry.content });
        }
    }
    archives.sort((a, b) => a.num - b.num);

    // Combine all transactions
    const allTxns = [];
    for (const archive of archives) {
        allTxns.push(...parseTransactions(archive.content));
    }
    allTxns.push(...(_cachedTransactions || []));

    return allTxns;
}

/**
 * Get transactions since a specific tx_id.
 * @param {number} sinceTxId
 * @returns {Promise<Array>}
 */
async function getTransactionsSince(sinceTxId) {
    const all = await getAllTransactions();
    return all.filter(tx => tx.tx > sinceTxId);
}

/**
 * Get transactions filtered by entity id.
 * Used by eval to retrieve the full history of a specific entity.
 * @param {string} entityId - The entity id to filter by
 * @returns {Promise<Array>}
 */
async function getTransactionsForEntity(entityId) {
    const all = await getAllTransactions();
    return all.filter(tx =>
        tx.id === entityId ||
        // Also match AMEND transactions that target this entity's transactions
        (tx.op === 'AMEND' && tx.d?.correction?.id === entityId)
    );
}

/**
 * Get transactions within a time range (by in-game timestamp).
 * Used by eval to retrieve history for a specific period.
 * @param {string} fromTimestamp - e.g. "[Day 1 — 00:00]"
 * @param {string} [toTimestamp] - e.g. "[Day 3 — 12:00]", defaults to latest
 * @returns {Promise<Array>}
 */
async function getTransactionsInRange(fromTimestamp, toTimestamp) {
    const all = await getAllTransactions();
    // Simple string comparison works for "[Day N — HH:MM]" format
    // because Day number and time are zero-padded in practice
    return all.filter(tx => {
        if (!tx.t) return false;
        if (fromTimestamp && tx.t < fromTimestamp) return false;
        if (toTimestamp && tx.t > toTimestamp) return false;
        return true;
    });
}

/**
 * Get the current transaction counter.
 * @returns {number}
 */
function getCurrentTxId() {
    return _txCounter;
}

/**
 * Get the book name.
 * @returns {string|null}
 */
function getBookName() {
    return _bookName;
}

export {
    init,
    reset,
    append,
    getAllTransactions,
    getTransactionsSince,
    getTransactionsForEntity,
    getTransactionsInRange,
    getCurrentTxId,
    getBookName,
    parseTransactions,
    normalizeTransactions,
};
