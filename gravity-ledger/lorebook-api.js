/**
 * lorebook-api.js — Direct lorebook CRUD via SillyTavern's /api/worldinfo/ endpoints
 * Standalone module — no TunnelVision dependency.
 */

const MODULE_NAME = 'gravity-ledger';

/**
 * Get the SillyTavern context (jQuery, modules, etc.)
 * In ST extensions, getContext() provides access to the chat, characters, and API.
 */
function getContext() {
    return window.SillyTavern?.getContext?.() ?? {};
}

/**
 * Get all world info (lorebook) books currently loaded.
 * @returns {Object} Map of book names to book objects
 */
async function getWorldInfoBooks() {
    const response = await fetch('/api/worldinfo/get', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
    });
    if (!response.ok) throw new Error(`Failed to get world info: ${response.status}`);
    return await response.json();
}

/**
 * Find or create the Gravity Ledger lorebook.
 * @returns {string} The lorebook name/id
 */
async function ensureLedgerBook() {
    const books = await getWorldInfoBooks();
    const existing = Object.keys(books).find(name => name.startsWith('Gravity_Ledger'));
    if (existing) return existing;

    const response = await fetch('/api/worldinfo/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Gravity_Ledger' }),
    });
    if (!response.ok) throw new Error(`Failed to create lorebook: ${response.status}`);
    const result = await response.json();
    return result.name || 'Gravity_Ledger';
}

/**
 * Get all entries in a lorebook.
 * @param {string} bookName
 * @returns {Object} Map of uid to entry objects
 */
async function getEntries(bookName) {
    const books = await getWorldInfoBooks();
    const book = books[bookName];
    if (!book) return {};
    return book.entries || {};
}

/**
 * Find an entry by comment (our naming convention for ledger entries).
 * @param {string} bookName
 * @param {string} comment - The comment/label to search for
 * @returns {Object|null} The entry or null
 */
async function findEntryByComment(bookName, comment) {
    const entries = await getEntries(bookName);
    for (const [uid, entry] of Object.entries(entries)) {
        if (entry.comment === comment) return { uid: Number(uid), ...entry };
    }
    return null;
}

/**
 * Create a new lorebook entry.
 * @param {string} bookName
 * @param {Object} entryData
 * @returns {Object} Created entry with uid
 */
async function createEntry(bookName, entryData) {
    const defaults = {
        key: entryData.key || [],
        keysecondary: entryData.keysecondary || [],
        comment: entryData.comment || '',
        content: entryData.content || '',
        constant: entryData.constant ?? false,
        selective: entryData.selective ?? false,
        selectiveLogic: entryData.selectiveLogic ?? 0,
        position: entryData.position ?? 0,
        disable: entryData.disable ?? false,
        order: entryData.order ?? 100,
        depth: entryData.depth ?? 4,
        scanDepth: entryData.scanDepth ?? null,
        caseSensitive: entryData.caseSensitive ?? false,
        matchWholeWords: entryData.matchWholeWords ?? false,
        automationId: entryData.automationId ?? '',
        excludeRecursion: entryData.excludeRecursion ?? false,
        preventRecursion: entryData.preventRecursion ?? false,
        delayUntilRecursion: entryData.delayUntilRecursion ?? false,
        probability: entryData.probability ?? 100,
        useProbability: entryData.useProbability ?? true,
        group: entryData.group ?? '',
        groupOverride: entryData.groupOverride ?? false,
        groupWeight: entryData.groupWeight ?? 100,
        sticky: entryData.sticky ?? null,
        cooldown: entryData.cooldown ?? null,
        delay: entryData.delay ?? null,
    };

    const response = await fetch('/api/worldinfo/entry/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ book: bookName, entry: defaults }),
    });
    if (!response.ok) throw new Error(`Failed to create entry: ${response.status}`);
    return await response.json();
}

/**
 * Update an existing lorebook entry.
 * @param {string} bookName
 * @param {number} uid
 * @param {Object} updates - Fields to update
 */
async function updateEntry(bookName, uid, updates) {
    const response = await fetch('/api/worldinfo/entry/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ book: bookName, uid, entry: updates }),
    });
    if (!response.ok) throw new Error(`Failed to update entry ${uid}: ${response.status}`);
}

/**
 * Delete a lorebook entry.
 * @param {string} bookName
 * @param {number} uid
 */
async function deleteEntry(bookName, uid) {
    const response = await fetch('/api/worldinfo/entry/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ book: bookName, uid }),
    });
    if (!response.ok) throw new Error(`Failed to delete entry ${uid}: ${response.status}`);
}

export {
    getContext,
    getWorldInfoBooks,
    ensureLedgerBook,
    getEntries,
    findEntryByComment,
    createEntry,
    updateEntry,
    deleteEntry,
};
