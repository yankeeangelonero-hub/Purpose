/**
 * state-view.js — Render computed state into lorebook entries.
 *
 * Maintains two types of lorebook entries:
 * 1. Gravity_State_View (always-on) — full state overview
 * 2. Gravity_[CharName] (keyword-triggered) — per-character dossiers
 *
 * These are the LLM's window into cold state. The extension keeps them current
 * after every ledger commit.
 */

import { findEntryByComment, createEntry, updateEntry, getEntries } from './lorebook-api.js';
import { getPhonebook } from './state-compute.js';

const STATE_VIEW_COMMENT = 'Gravity_State_View';
const CHAR_ENTRY_PREFIX = 'Gravity_Char_';

/**
 * Render the full state view into the always-on lorebook entry.
 * @param {string} bookName
 * @param {import('./state-compute.js').ComputedState} state
 */
async function renderStateView(bookName, state) {
    const content = formatStateView(state);
    const existing = await findEntryByComment(bookName, STATE_VIEW_COMMENT);

    if (existing) {
        await updateEntry(bookName, existing.uid, { content });
    } else {
        await createEntry(bookName, {
            comment: STATE_VIEW_COMMENT,
            content,
            constant: true,  // Always injected
            key: [],
            disable: false,
            order: 10,
            position: 1,     // After system prompt
            depth: 0,
        });
    }
}

/**
 * Format the full state into a prompt-friendly string.
 * @param {import('./state-compute.js').ComputedState} state
 * @returns {string}
 */
function formatStateView(state) {
    const lines = [];
    lines.push('═══ GRAVITY STATE VIEW ═══');
    lines.push('');

    // Phonebook
    const phonebook = getPhonebook(state);
    lines.push('PHONEBOOK');
    if (phonebook.principal) lines.push(`  PRINCIPAL: ${phonebook.principal}`);
    if (phonebook.tracked.length) lines.push(`  TRACKED: ${phonebook.tracked.join(', ')}`);
    if (phonebook.known.length) lines.push(`  KNOWN: ${phonebook.known.join(', ')}`);
    lines.push('');

    // Active chapter
    const openChapter = Object.values(state.chapters).find(ch => ch.status === 'OPEN');
    if (openChapter) {
        lines.push(`CHAPTER ${openChapter.number || '?'}: "${openChapter.title || openChapter.focus || '?'}" [${openChapter.status}]`);
        if (openChapter.arc) lines.push(`  Arc: ${openChapter.arc}`);
        if (openChapter.central_tension) lines.push(`  Tension: ${openChapter.central_tension}`);
        lines.push('');
    }

    // Collisions (active/simmering)
    const liveCollisions = Object.values(state.collisions).filter(
        c => c.status !== 'RESOLVED' && c.status !== 'SEEDED'
    );
    if (liveCollisions.length) {
        lines.push('COLLISIONS');
        for (const col of liveCollisions) {
            const forces = (col.forces || []).map(f => f.name || f).join(' → ');
            lines.push(`  ⊕ ${col.name || col.id} | ${forces} | ${col.distance || '?'} | ${col.status}`);
            if (col.cost) lines.push(`    Cost: ${col.cost}`);
        }
        lines.push('');
    }

    // Constants
    const c = state.world.constants || {};
    if (Object.keys(c).length) {
        lines.push('CONSTANTS');
        if (c.role) lines.push(`  Role: ${c.role}`);
        if (c.voice) lines.push(`  Voice: ${c.voice}`);
        if (c.tone) lines.push(`  Tone: ${c.tone}`);
        if (c.tone_rules) {
            const rules = Array.isArray(c.tone_rules) ? c.tone_rules : [c.tone_rules];
            lines.push(`  Tone Rules:`);
            rules.forEach((r, i) => lines.push(`    ${i + 1}. ${r}`));
        }
        if (c.guidelines) lines.push(`  Guidelines: ${c.guidelines}`);
        if (c.motivation) lines.push(`  Motivation: ${c.motivation}`);
        if (c.objective) lines.push(`  Objective: ${c.objective}`);
        lines.push('');
    }

    // World state
    if (state.world.world_state) {
        lines.push('WORLD STATE');
        lines.push(`  ${state.world.world_state}`);
        lines.push('');
    }

    // Factions
    if (state.world.factions?.length) {
        lines.push('FACTIONS');
        for (const f of state.world.factions) {
            lines.push(`  ${f.name}: ${f.objective || ''} | Stance: ${f.stance_toward_pc || '?'}`);
        }
        lines.push('');
    }

    // Pressure points
    if (state.world.pressure_points?.length) {
        lines.push('PRESSURE POINTS');
        for (const pp of state.world.pressure_points) {
            lines.push(`  - ${pp}`);
        }
        lines.push('');
    }

    // PC
    if (state.pc.name) {
        lines.push(`PC: ${state.pc.name}`);
        if (state.pc.demonstrated_traits?.length) {
            lines.push(`  Traits: ${state.pc.demonstrated_traits.join(', ')}`);
        }
        if (Object.keys(state.pc.reputation || {}).length) {
            lines.push(`  Reputation:`);
            for (const [who, rep] of Object.entries(state.pc.reputation)) {
                lines.push(`    ${who}: ${rep}`);
            }
        }
        lines.push('');
    }

    lines.push('═══ END STATE VIEW ═══');
    return lines.join('\n');
}

/**
 * Render per-character keyword-triggered lorebook entries.
 * @param {string} bookName
 * @param {import('./state-compute.js').ComputedState} state
 */
async function renderCharacterEntries(bookName, state) {
    const entries = await getEntries(bookName);

    for (const char of Object.values(state.characters)) {
        if (char.tier === 'UNKNOWN') continue; // No entry for unknown characters

        const comment = `${CHAR_ENTRY_PREFIX}${char.id}`;
        const content = formatCharacterEntry(char, state);
        const keywords = buildCharacterKeywords(char);

        const existing = Object.entries(entries).find(([, e]) => e.comment === comment);

        if (existing) {
            await updateEntry(bookName, Number(existing[0]), {
                content,
                key: keywords,
                disable: char.tier === 'KNOWN', // KNOWN chars have dormant entries
            });
        } else if (char.tier === 'TRACKED' || char.tier === 'PRINCIPAL') {
            await createEntry(bookName, {
                comment,
                content,
                key: keywords,
                constant: false,
                disable: false,
                order: 50,
                position: 1,
                depth: 4,
                scanDepth: 2,
            });
        }
    }
}

/**
 * Format a character's state into a prompt-friendly string.
 * @param {Object} char
 * @param {import('./state-compute.js').ComputedState} state
 * @returns {string}
 */
function formatCharacterEntry(char, state) {
    const lines = [];
    lines.push(`═══ ${char.name || char.id} [${char.tier}] ═══`);

    if (char.want) lines.push(`W: ${char.want}`);
    if (char.doing) lines.push(`DO: ${char.doing}${char.cost ? ` | $: ${char.cost}` : ''}`);

    // Constraints
    const constraints = Object.values(state.constraints).filter(c => c.owner_id === char.id);
    if (constraints.length) {
        lines.push('');
        lines.push('Constraints:');
        for (const c of constraints) {
            let line = `  ${c.name} [${c.integrity}]`;
            if (c.prevents) line += ` — prevents: ${c.prevents}`;
            if (c.shedding_order != null) line += ` (shed: ${c.shedding_order})`;
            lines.push(line);
            if (c.integrity === 'BREACHED' && c.replacement) {
                lines.push(`    → Replaced by: ${c.replacement} (${c.replacement_type})`);
            }
        }
    }

    // Reads
    if (char.reads && Object.keys(char.reads).length) {
        lines.push('');
        lines.push('READS:');
        for (const [who, interpretation] of Object.entries(char.reads)) {
            lines.push(`  ${who}: ${interpretation}`);
        }
    }

    // Noticed details
    if (char.noticed_details?.length) {
        lines.push('');
        lines.push('Noticed:');
        for (const detail of char.noticed_details) {
            lines.push(`  🔫 ${detail}`);
        }
    }

    // Key moments
    if (char.key_moments?.length) {
        lines.push('');
        lines.push('Key Moments:');
        for (const moment of char.key_moments.slice(-5)) { // Last 5
            lines.push(`  ${moment}`);
        }
    }

    // Stance (TRACKED only)
    if (char.stance_toward_pc) {
        lines.push('');
        lines.push(`Stance toward PC: ${char.stance_toward_pc}`);
    }

    lines.push(`═══ END ${char.name || char.id} ═══`);
    return lines.join('\n');
}

/**
 * Build keyword array for a character entry.
 * @param {Object} char
 * @returns {string[]}
 */
function buildCharacterKeywords(char) {
    const keywords = [];
    if (char.name) {
        keywords.push(char.name);
        // Add first name as keyword too
        const firstName = char.name.split(' ')[0];
        if (firstName !== char.name) keywords.push(firstName);
    }
    if (char.id && char.id !== char.name) keywords.push(char.id);
    return keywords;
}

/**
 * Full render: state view + all character entries.
 * Called after every successful ledger commit.
 * @param {string} bookName
 * @param {import('./state-compute.js').ComputedState} state
 */
async function renderAll(bookName, state) {
    await renderStateView(bookName, state);
    await renderCharacterEntries(bookName, state);
}

export {
    renderStateView,
    renderCharacterEntries,
    renderAll,
    formatStateView,
    formatCharacterEntry,
    STATE_VIEW_COMMENT,
    CHAR_ENTRY_PREFIX,
};
