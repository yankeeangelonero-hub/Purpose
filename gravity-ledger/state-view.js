/**
 * state-view.js — Render computed state into lorebook entries.
 *
 * Maintains three types of lorebook entries:
 * 1. Gravity_State_View (always-on) — full state overview with entity registry
 * 2. Gravity_Char_[id] (keyword-triggered) — per-character dossiers
 * 3. Gravity_Ledger_Readme (always-on, low depth) — format spec, commands, writing guide
 *
 * These are the LLM's window into cold state. The extension keeps them current
 * after every ledger commit.
 */

import { findEntryByComment, createEntry, updateEntry, getEntries } from './lorebook-api.js';
import { getPhonebook } from './state-compute.js';

const STATE_VIEW_COMMENT = 'Gravity_State_View';
const LEDGER_README_COMMENT = 'Gravity_Ledger_Readme';
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
 * Includes entity IDs so the LLM knows exactly what to target in ledger transactions.
 * @param {import('./state-compute.js').ComputedState} state
 * @returns {string}
 */
function formatStateView(state) {
    const lines = [];
    lines.push('═══ GRAVITY STATE VIEW ═══');
    lines.push('');

    // ── Entity Registry (what to write to) ─────────────────────────────
    // Every entity ID the LLM can target in ledger transactions.
    lines.push('ENTITY REGISTRY — use these IDs in ledger transactions');

    // Characters
    const phonebook = getPhonebook(state);
    lines.push('');
    lines.push('Characters:');
    for (const char of Object.values(state.characters)) {
        if (char.tier === 'UNKNOWN') continue;
        lines.push(`  ${char.tier} "${char.name || char.id}" → id: ${char.id}`);
    }
    if (Object.keys(state.characters).length === 0) lines.push('  (none)');

    // Constraints
    const constraints = Object.values(state.constraints);
    if (constraints.length) {
        lines.push('');
        lines.push('Constraints:');
        for (const c of constraints) {
            const owner = state.characters[c.owner_id];
            const ownerName = owner?.name || c.owner_id;
            lines.push(`  ${c.name} [${c.integrity}] (${ownerName}) → id: ${c.id}`);
        }
    }

    // Collisions
    const allCollisions = Object.values(state.collisions).filter(c => c.status !== 'RESOLVED');
    if (allCollisions.length) {
        lines.push('');
        lines.push('Collisions:');
        for (const col of allCollisions) {
            const forces = (col.forces || []).map(f => f.name || f).join(' → ');
            lines.push(`  ⊕ ${col.name || col.id} [${col.status}] ${forces} | dist:${col.distance || '?'} → id: ${col.id}`);
        }
    }

    // Chapters
    const activeChapters = Object.values(state.chapters).filter(ch => ch.status !== 'CLOSED');
    if (activeChapters.length) {
        lines.push('');
        lines.push('Chapters:');
        for (const ch of activeChapters) {
            lines.push(`  Ch${ch.number || '?'} "${ch.title || ch.focus || '?'}" [${ch.status}] → id: ${ch.id}`);
        }
    }

    // Singletons
    lines.push('');
    lines.push('Singletons (no id needed):');
    lines.push('  world — factions, constants, pressure_points, world_state');
    if (state.pc.name) {
        lines.push(`  pc — "${state.pc.name}"`);
    } else {
        lines.push('  pc — (not initialized)');
    }

    // ── Current State Detail ───────────────────────────────────────────
    lines.push('');
    lines.push('─── CURRENT STATE ───');

    // Chapter
    const openChapter = Object.values(state.chapters).find(ch => ch.status === 'OPEN');
    if (openChapter) {
        lines.push('');
        lines.push(`CHAPTER ${openChapter.number || '?'}: "${openChapter.title || openChapter.focus || '?'}" [${openChapter.status}]`);
        if (openChapter.arc) lines.push(`  Arc: ${openChapter.arc}`);
        if (openChapter.central_tension) lines.push(`  Tension: ${openChapter.central_tension}`);
    }

    // Collisions detail
    const liveCollisions = Object.values(state.collisions).filter(
        c => c.status !== 'RESOLVED' && c.status !== 'SEEDED'
    );
    if (liveCollisions.length) {
        lines.push('');
        lines.push('COLLISIONS');
        for (const col of liveCollisions) {
            const forces = (col.forces || []).map(f => f.name || f).join(' → ');
            lines.push(`  ⊕ ${col.name || col.id} | ${forces} | dist:${col.distance || '?'} | ${col.status}`);
            if (col.cost) lines.push(`    Cost: ${col.cost}`);
            if (col.target_constraint) lines.push(`    Targets: ${col.target_constraint}`);
        }
    }

    // Constants
    const c = state.world.constants || {};
    if (Object.keys(c).length) {
        lines.push('');
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
    }

    // World state
    if (state.world.world_state) {
        lines.push('');
        lines.push('WORLD STATE');
        lines.push(`  ${state.world.world_state}`);
    }

    // Factions
    if (state.world.factions?.length) {
        lines.push('');
        lines.push('FACTIONS');
        for (const f of state.world.factions) {
            lines.push(`  ${f.name}: ${f.objective || ''} | Stance: ${f.stance_toward_pc || '?'}`);
        }
    }

    // Pressure points
    if (state.world.pressure_points?.length) {
        lines.push('');
        lines.push('PRESSURE POINTS');
        for (const pp of state.world.pressure_points) {
            lines.push(`  - ${pp}`);
        }
    }

    // PC
    if (state.pc.name) {
        lines.push('');
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
    }

    lines.push('');
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
 * Render the command readme into a low-depth always-on lorebook entry.
 * Gives the LLM a persistent reference for ledger format, commands, and examples.
 * @param {string} bookName
 */
async function renderReadme(bookName) {
    const content = formatReadme();
    const existing = await findEntryByComment(bookName, LEDGER_README_COMMENT);

    if (existing) {
        await updateEntry(bookName, existing.uid, { content });
    } else {
        await createEntry(bookName, {
            comment: LEDGER_README_COMMENT,
            content,
            constant: true,   // Always injected
            key: [],
            disable: false,
            order: 5,
            position: 1,      // After system prompt
            depth: 4,         // Low depth — available but not top priority
        });
    }
}

/**
 * Format the ledger readme — command reference, format spec, writing guide, and examples.
 * @returns {string}
 */
function formatReadme() {
    const lines = [];
    lines.push('═══ GRAVITY LEDGER — FORMAT & COMMANDS ═══');
    lines.push('');

    // ── Ledger Block Format ──────────────────────────────────────────────
    lines.push('LEDGER BLOCK FORMAT');
    lines.push('Every response MUST end with a ledger block, even if nothing changed.');
    lines.push('');
    lines.push('---LEDGER---');
    lines.push('[');
    lines.push('  {"op":"TR","e":"constraint","id":"c1-the-secret","d":{"f":"integrity","from":"STABLE","to":"STRESSED"},"r":"⊕Trust pressured C1"}');
    lines.push(']');
    lines.push('---END LEDGER---');
    lines.push('');
    lines.push('Empty turn (no state changes): ---LEDGER--- [] ---END LEDGER---');
    lines.push('');

    // ── Transaction Schema ───────────────────────────────────────────────
    lines.push('TRANSACTION SCHEMA');
    lines.push('Keep entries short — one line per transaction, reason under 80 chars.');
    lines.push('');
    lines.push('Keys (all short to save tokens):');
    lines.push('  tx — auto-assigned by extension, omit');
    lines.push('  t  — in-game timestamp, e.g. "[Day 1 — 21:15]"');
    lines.push('  op — operation code (see below)');
    lines.push('  e  — entity type: char | constraint | collision | chapter | world | pc');
    lines.push('  id — entity identifier (omit for world/pc singletons)');
    lines.push('  d  — data payload (operation-specific)');
    lines.push('  r  — reason (brief, one line)');
    lines.push('');

    // ── Operations with Examples ─────────────────────────────────────────
    lines.push('OPERATIONS & EXAMPLES');
    lines.push('');
    lines.push('CR  Create entity');
    lines.push('    {"op":"CR","e":"char","id":"tifa","d":{"name":"Tifa Lockhart","tier":"KNOWN"},"r":"First encounter at Seventh Heaven"}');
    lines.push('    {"op":"CR","e":"constraint","id":"c1-the-secret","d":{"name":"The Secret","owner_id":"tifa","integrity":"STABLE","prevents":"Telling Cloud about Nibelheim"},"r":"Core constraint — what she hides"}');
    lines.push('    {"op":"CR","e":"collision","id":"trust-vs-duty","d":{"name":"Trust vs Duty","forces":["trust","duty"],"status":"SEEDED","distance":10},"r":"Will she protect or tell the truth?"}');
    lines.push('');
    lines.push('TR  Transition (state machine field change — no skipping levels)');
    lines.push('    {"op":"TR","e":"char","id":"tifa","d":{"f":"tier","from":"KNOWN","to":"TRACKED"},"r":"Promoted after trust scene"}');
    lines.push('    {"op":"TR","e":"constraint","id":"c1-the-secret","d":{"f":"integrity","from":"STABLE","to":"STRESSED"},"r":"⊕Trust pressured C1 — Autumn mentioned SOLDIERs"}');
    lines.push('    {"op":"TR","e":"collision","id":"trust-vs-duty","d":{"f":"status","from":"SIMMERING","to":"ACTIVE"},"r":"Costs now concrete — must choose"}');
    lines.push('    {"op":"TR","e":"chapter","id":"ch1-arrival","d":{"f":"status","from":"OPEN","to":"CLOSING"},"r":"Chapter target reached"}');
    lines.push('');
    lines.push('S   Set field (overwrite)');
    lines.push('    {"op":"S","e":"char","id":"tifa","d":{"f":"doing","v":"Investigating the reactor"},"r":"New action"}');
    lines.push('    {"op":"S","e":"char","id":"tifa","d":{"f":"want","v":"Keep Cloud safe without revealing the truth"},"r":"Goal clarified"}');
    lines.push('    {"op":"S","e":"collision","id":"trust-vs-duty","d":{"f":"distance","v":6},"r":"Closer after confrontation"}');
    lines.push('    {"op":"S","e":"world","d":{"f":"world_state","v":"Martial law declared in Sector 7"},"r":"Major world change"}');
    lines.push('');
    lines.push('A   Append to array');
    lines.push('    {"op":"A","e":"char","id":"tifa","d":{"f":"key_moments","v":"Confronted Cloud about his memory at the well"},"r":"Pivotal scene"}');
    lines.push('    {"op":"A","e":"char","id":"tifa","d":{"f":"noticed_details","v":"Cloud flinched when she said Sephiroth"},"r":"Chekhov detail planted"}');
    lines.push('    {"op":"A","e":"world","d":{"f":"pressure_points","v":"Shinra patrols increasing in slums"},"r":"Rising tension"}');
    lines.push('');
    lines.push('R   Remove from array');
    lines.push('    {"op":"R","e":"char","id":"tifa","d":{"f":"noticed_details","v":"Scratches on his bracer"},"r":"Detail resolved in scene"}');
    lines.push('');
    lines.push('MS  Map set (set key in object field)');
    lines.push('    {"op":"MS","e":"char","id":"tifa","d":{"f":"reads","k":"cloud","v":"Something is wrong with his memories"},"r":"Updated read after evasion"}');
    lines.push('    {"op":"MS","e":"pc","d":{"f":"reputation","k":"tifa","v":"Trustworthy but secretive"},"r":"PC reputation shift"}');
    lines.push('');
    lines.push('MR  Map remove (delete key from object field)');
    lines.push('    {"op":"MR","e":"char","id":"tifa","d":{"f":"reads","k":"barret"},"r":"No longer relevant"}');
    lines.push('');
    lines.push('D   Destroy entity');
    lines.push('    {"op":"D","e":"char","id":"minor-npc","r":"Left the story permanently"}');
    lines.push('');
    lines.push('AMEND  Correct a past transaction (eval only)');
    lines.push('    {"op":"AMEND","d":{"target_tx":42,"correction":{"op":"TR","e":"constraint","id":"c1","d":{"f":"integrity","from":"STRESSED","to":"CRITICAL"}},"reason":"Was STRESSED not STABLE at that point"}}');
    lines.push('');

    // ── State Machine Quick Reference ────────────────────────────────────
    lines.push('STATE MACHINES (use TR to move between adjacent states only)');
    lines.push('  Character tier:       UNKNOWN → KNOWN → TRACKED → PRINCIPAL');
    lines.push('  Constraint integrity: STABLE → STRESSED → CRITICAL → BREACHED (terminal)');
    lines.push('    Relief reverse:     CRITICAL → STRESSED → STABLE');
    lines.push('  Collision status:     SEEDED → SIMMERING → ACTIVE → RESOLVING → RESOLVED');
    lines.push('  Chapter status:       PLANNED → OPEN → CLOSING → CLOSED');
    lines.push('  No skipping — must go through each state in order.');
    lines.push('');

    // ── Writing Guide ────────────────────────────────────────────────────
    lines.push('WRITING GUIDE');
    lines.push('');
    lines.push('Volume per turn:');
    lines.push('  Quiet dialogue scene: 1–2 transactions (a read update, maybe a distance change)');
    lines.push('  Normal scene: 2–4 transactions');
    lines.push('  Action/confrontation: 4–6 transactions');
    lines.push('  Heavy turn (setup, chapter close, promotion): 6–12 transactions');
    lines.push('  If nothing changed: empty block [] — do NOT invent transactions.');
    lines.push('');
    lines.push('Reasons ("r" field): Write like margin notes — brief, causal, present tense.');
    lines.push('  GOOD: "⊕Trust pressured C1 — Autumn mentioned SOLDIERs"');
    lines.push('  GOOD: "Promoted after trust scene at the well"');
    lines.push('  GOOD: "Distance 8→6, confrontation escalated"');
    lines.push('  BAD:  "This constraint was transitioned because the collision caused pressure" (too verbose)');
    lines.push('  BAD:  "" (empty — always explain why)');
    lines.push('');
    lines.push('Entity IDs: Use kebab-case, descriptive, stable.');
    lines.push('  Characters: "tifa-lockhart", "cloud-strife"');
    lines.push('  Constraints: "c1-the-secret", "c2-cover-story"');
    lines.push('  Collisions: "trust-vs-duty", "identity-crisis"');
    lines.push('  Chapters: "ch1-arrival", "ch2-the-reactor"');
    lines.push('  Once assigned, NEVER change an entity ID.');
    lines.push('');
    lines.push('Timestamps: Use "[Day N — HH:MM]" format consistently.');
    lines.push('');

    // ── Full Turn Examples ───────────────────────────────────────────────
    lines.push('FULL TURN EXAMPLES');
    lines.push('');
    lines.push('Quiet dialogue (2 txns):');
    lines.push('---LEDGER---');
    lines.push('[');
    lines.push('  {"t":"[Day 1 — 21:15]","op":"MS","e":"char","id":"tifa","d":{"f":"reads","k":"cloud","v":"Hiding something about Nibelheim"},"r":"Updated read after evasion"},');
    lines.push('  {"t":"[Day 1 — 21:15]","op":"S","e":"collision","id":"trust-vs-duty","d":{"f":"distance","v":6},"r":"Closer after confrontation"}');
    lines.push(']');
    lines.push('---END LEDGER---');
    lines.push('');
    lines.push('Action scene (5 txns):');
    lines.push('---LEDGER---');
    lines.push('[');
    lines.push('  {"t":"[Day 2 — 03:00]","op":"TR","e":"constraint","id":"c2-cover-story","d":{"f":"integrity","from":"STRESSED","to":"CRITICAL"},"r":"⊕Identity — guard recognized him"},');
    lines.push('  {"t":"[Day 2 — 03:00]","op":"A","e":"char","id":"cloud","d":{"f":"key_moments","v":"Guard recognized him from Nibelheim"},"r":"Pivotal moment"},');
    lines.push('  {"t":"[Day 2 — 03:00]","op":"S","e":"char","id":"cloud","d":{"f":"doing","v":"Fighting to escape checkpoint"},"r":"Forced into action"},');
    lines.push('  {"t":"[Day 2 — 03:00]","op":"S","e":"collision","id":"identity-crisis","d":{"f":"distance","v":3},"r":"Near collision point"},');
    lines.push('  {"t":"[Day 2 — 03:00]","op":"S","e":"world","d":{"f":"world_state","v":"Checkpoint breach — alarms triggered in Sector 7"},"r":"World reacts"}');
    lines.push(']');
    lines.push('---END LEDGER---');
    lines.push('');
    lines.push('Nothing happened:');
    lines.push('---LEDGER--- [] ---END LEDGER---');
    lines.push('');

    // ── OOC Commands ─────────────────────────────────────────────────────
    lines.push('OOC COMMANDS (player types these in chat)');
    lines.push('  OOC: snapshot          — Save current state checkpoint');
    lines.push('  OOC: rollback          — List available snapshots');
    lines.push('  OOC: rollback to #N    — Restore to snapshot N');
    lines.push('  OOC: eval              — Full system audit (retrieve history, emit AMEND to fix errors)');
    lines.push('  OOC: history [entity]  — View full change history for an entity');
    lines.push('  OOC: timeline [from] to [to] — View transactions in time range');
    lines.push('  OOC: archive           — Consolidation checkpoint');
    lines.push('');

    // ── Delta State Block ────────────────────────────────────────────────
    lines.push('DELTA STATE BLOCK (in HTML details tag, before ledger block)');
    lines.push('Only write what CHANGED this turn. Full state lives in Gravity_State_View.');
    lines.push('  Δ this turn:');
    lines.push('  C1: STABLE→STRESSED (⊕Trust — Autumn mentioned SOLDIERs)');
    lines.push('  R.Autumn: → "civilian who asks the wrong questions"');
    lines.push('  ⊕Trust: distance 8→6');
    lines.push('');
    lines.push('═══ END LEDGER README ═══');

    return lines.join('\n');
}

/**
 * Full render: state view + all character entries + readme.
 * Called after every successful ledger commit.
 * @param {string} bookName
 * @param {import('./state-compute.js').ComputedState} state
 */
async function renderAll(bookName, state) {
    await renderStateView(bookName, state);
    await renderCharacterEntries(bookName, state);
    await renderReadme(bookName);
}

export {
    renderStateView,
    renderCharacterEntries,
    renderReadme,
    renderAll,
    formatStateView,
    formatCharacterEntry,
    formatReadme,
    STATE_VIEW_COMMENT,
    LEDGER_README_COMMENT,
    CHAR_ENTRY_PREFIX,
};
