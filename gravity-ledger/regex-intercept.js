/**
 * regex-intercept.js — Fuzzy regex extraction of ---LEDGER--- blocks from LLM output.
 *
 * Handles drift-tolerant matching, lenient JSON parsing, error detection,
 * and format reinforcement. The core of the zero-tool-call architecture.
 */

// ─── Fuzzy Regex Patterns ──────────────────────────────────────────────────────

// Match the ledger block with tolerance for formatting drift
// Accepts: ---LEDGER---, --- LEDGER ---, —LEDGER—, ---LEDGER BLOCK---, etc.
const LEDGER_BLOCK_PATTERN = /[-—–]{2,3}\s*LEDGER\s*(?:BLOCK)?\s*[-—–]{2,3}([\s\S]*?)[-—–]{2,3}\s*END\s*LEDGER\s*[-—–]{2,3}/i;

// Also catch common variants the LLM might drift to
const LEDGER_BLOCK_FALLBACKS = [
    /```ledger\s*\n?([\s\S]*?)```/i,           // Markdown code block variant
    /\[LEDGER\]([\s\S]*?)\[\/LEDGER\]/i,       // BBCode-style variant
    /<!--\s*LEDGER\s*-->([\s\S]*?)<!--\s*END\s*LEDGER\s*-->/i,  // HTML comment variant
];

// ─── Compliance Tracking ───────────────────────────────────────────────────────

const COMPLIANCE_WINDOW = 10;
let _complianceHistory = []; // Array of { turn, status: 'clean'|'drifted'|'malformed'|'missing' }

/**
 * Record a compliance event.
 * @param {number} turn
 * @param {string} status
 */
function recordCompliance(turn, status) {
    _complianceHistory.push({ turn, status });
    if (_complianceHistory.length > COMPLIANCE_WINDOW) {
        _complianceHistory.shift();
    }
}

/**
 * Get compliance score (0-1, 1 = perfect).
 * @returns {number}
 */
function getComplianceScore() {
    if (_complianceHistory.length === 0) return 1;
    const clean = _complianceHistory.filter(e => e.status === 'clean').length;
    return clean / _complianceHistory.length;
}

// ─── Extraction ────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} ExtractionResult
 * @property {boolean} found - Whether a ledger block was found
 * @property {Array|null} transactions - Parsed transactions or null
 * @property {string|null} error - Parse error message if found but malformed
 * @property {boolean} drifted - Whether the format was non-standard but recoverable
 * @property {string} cleanedMessage - The message with ledger block stripped
 */

/**
 * Extract the ledger block from an LLM response.
 * @param {string} message - The full LLM response text
 * @returns {ExtractionResult}
 */
function extractLedgerBlock(message) {
    if (!message) {
        return { found: false, transactions: null, error: null, drifted: false, cleanedMessage: message || '' };
    }

    // Try primary pattern
    let match = message.match(LEDGER_BLOCK_PATTERN);
    let drifted = false;

    // Try fallbacks if primary fails
    if (!match) {
        for (const pattern of LEDGER_BLOCK_FALLBACKS) {
            match = message.match(pattern);
            if (match) {
                drifted = true;
                break;
            }
        }
    }

    if (!match) {
        return { found: false, transactions: null, error: null, drifted: false, cleanedMessage: message };
    }

    const rawContent = match[1].trim();
    const cleanedMessage = message.replace(match[0], '').trim();

    // Check for minor drift in the primary pattern (non-standard delimiters)
    if (!drifted && match[0]) {
        const standard = /^---LEDGER---[\s\S]*---END LEDGER---$/;
        if (!standard.test(match[0].trim())) {
            drifted = true;
        }
    }

    // Parse the content
    if (!rawContent || rawContent === '[]') {
        return { found: true, transactions: [], error: null, drifted, cleanedMessage };
    }

    const parsed = lenientJsonParse(rawContent);
    if (parsed.error) {
        return { found: true, transactions: null, error: parsed.error, drifted, cleanedMessage };
    }

    // Ensure it's an array
    const transactions = Array.isArray(parsed.data) ? parsed.data : [parsed.data];

    return { found: true, transactions, error: null, drifted, cleanedMessage };
}

/**
 * Lenient JSON parser that handles common LLM serialization quirks.
 * @param {string} raw
 * @returns {{ data: any, error: string|null }}
 */
function lenientJsonParse(raw) {
    // Try standard JSON first
    try {
        return { data: JSON.parse(raw), error: null };
    } catch { /* continue to lenient parsing */ }

    // Clean up common issues
    let cleaned = raw;

    // Remove trailing commas before ] or }
    cleaned = cleaned.replace(/,\s*([}\]])/g, '$1');

    // Replace single quotes with double quotes (but not within strings)
    cleaned = cleaned.replace(/'/g, '"');

    // Fix unquoted keys: {key: "value"} → {"key": "value"}
    cleaned = cleaned.replace(/(\{|,)\s*(\w+)\s*:/g, '$1"$2":');

    // Remove JavaScript-style comments
    cleaned = cleaned.replace(/\/\/.*$/gm, '');
    cleaned = cleaned.replace(/\/\*[\s\S]*?\*\//g, '');

    // Try again
    try {
        return { data: JSON.parse(cleaned), error: null };
    } catch (e) {
        return { data: null, error: `JSON parse failed: ${e.message}. Raw: ${raw.substring(0, 100)}...` };
    }
}

// ─── Reinforcement Messages ────────────────────────────────────────────────────

/**
 * Generate the appropriate reinforcement message based on extraction result and compliance.
 * @param {ExtractionResult} result
 * @param {number} turn
 * @returns {string|null} Message to inject, or null if silent
 */
function getReinforcement(result, turn) {
    if (!result.found) {
        recordCompliance(turn, 'missing');
        const score = getComplianceScore();

        if (score < 0.5) {
            // Strong reminder with full format example
            return `[LEDGER: Block missing. REQUIRED after every state block.\n` +
                `Format: ---LEDGER--- [{"op":"TR","e":"constraint","id":"c1","d":{"f":"integrity","from":"STABLE","to":"STRESSED"},"r":"evidence"}] ---END LEDGER---\n` +
                `Empty turn: ---LEDGER--- [] ---END LEDGER---]`;
        }
        return `[LEDGER: Block missing. Append ---LEDGER--- [...] ---END LEDGER--- after every state block. Empty = ---LEDGER--- [] ---END LEDGER---]`;
    }

    if (result.error) {
        recordCompliance(turn, 'malformed');
        return `[LEDGER: Parse error — ${result.error}. Expected: ---LEDGER--- [{"op":"TR",...}] ---END LEDGER---. Resubmit.]`;
    }

    if (result.drifted) {
        recordCompliance(turn, 'drifted');
        const score = getComplianceScore();
        if (score > 0.7) {
            return `[LEDGER: OK. Format note: use ---LEDGER--- (three dashes, caps).]`;
        }
        return `[LEDGER: Processed. Use standard format: ---LEDGER--- [...] ---END LEDGER---]`;
    }

    // Clean and valid
    recordCompliance(turn, 'clean');

    // Only nudge if compliance has been recently poor
    const score = getComplianceScore();
    if (score < 0.8 && _complianceHistory.length > 3) {
        return `[LEDGER: OK.]`;
    }

    return null; // Silent — no injection needed
}

/**
 * Generate a validation error message for the LLM.
 * @param {Array<import('./consistency.js').Violation>} violations
 * @returns {string}
 */
function getValidationErrorMessage(violations) {
    const blocking = violations.filter(v => v.severity === 'blocking');
    const advisory = violations.filter(v => v.severity === 'advisory');

    const parts = [];

    if (blocking.length) {
        parts.push(`[LEDGER: REJECTED — ${blocking.length} error(s):`);
        for (const v of blocking) {
            parts.push(`  #${v.check}: ${v.message}. Fix: ${v.fix}`);
        }
        parts.push(`Resubmit corrected transactions.]`);
    }

    if (advisory.length) {
        parts.push(`[LEDGER: WARNING — ${advisory.length} advisory:`);
        for (const v of advisory) {
            parts.push(`  #${v.check}: ${v.message}. Suggestion: ${v.fix}`);
        }
        parts.push(`]`);
    }

    return parts.join('\n');
}

/**
 * Strip the ledger block from a message for display.
 * Uses the same fuzzy matching to ensure we catch drift variants.
 * @param {string} message
 * @returns {string}
 */
function stripLedgerBlock(message) {
    if (!message) return message;

    // Try primary pattern
    let result = message.replace(LEDGER_BLOCK_PATTERN, '');

    // Try fallbacks
    for (const pattern of LEDGER_BLOCK_FALLBACKS) {
        result = result.replace(pattern, '');
    }

    return result.trim();
}

// ─── Delta Block Extraction ────────────────────────────────────────────────────

/**
 * Extract the delta state block from the HTML details block.
 * If the LLM writes a delta block but no explicit ledger block,
 * we can attempt to auto-generate transactions from the delta.
 *
 * @param {string} message
 * @returns {{ found: boolean, deltaContent: string|null }}
 */
function extractDeltaBlock(message) {
    const detailsMatch = message.match(/<details><summary>📋<\/summary>([\s\S]*?)<\/details>/);
    if (!detailsMatch) return { found: false, deltaContent: null };

    const content = detailsMatch[1].trim();

    // Check if it contains delta markers
    if (content.includes('Δ this turn') || content.includes('Δ:')) {
        return { found: true, deltaContent: content };
    }

    return { found: false, deltaContent: null };
}

export {
    extractLedgerBlock,
    lenientJsonParse,
    getReinforcement,
    getValidationErrorMessage,
    stripLedgerBlock,
    extractDeltaBlock,
    getComplianceScore,
    LEDGER_BLOCK_PATTERN,
};
