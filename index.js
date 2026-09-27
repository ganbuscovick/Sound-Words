/*
 * SillyTavern - Sound Words
 * Turn configured words in chat messages into clickable audio triggers.
 * Audio blobs are stored in IndexedDB; rule metadata is stored in ST extension settings.
 */

const EXTENSION_NAME = 'st-sound-words';
const DB_NAME = 'st-sound-words-db';
const DB_VERSION = 1;
const STORE_NAME = 'audio';
const SETTINGS_ID = '#stsw-settings';

const DEFAULT_SETTINGS = {
    enabled: true,
    includeUserMessages: false,
    overlapSounds: true,
    entries: [],
};

let dbPromise = null;
let rootObserver = null;
let chatObserver = null;
let activeAudios = new Set();
let objectUrls = new Set();
let isInitialized = false;
let renderQueued = false;

function log(...args) {
    console.log('[Sound Words]', ...args);
}

function getContext() {
    return SillyTavern.getContext();
}

function getSettings() {
    const { extensionSettings } = getContext();
    if (!extensionSettings[EXTENSION_NAME]) {
        extensionSettings[EXTENSION_NAME] = structuredClone(DEFAULT_SETTINGS);
    }

    const settings = extensionSettings[EXTENSION_NAME];
    if (typeof settings.enabled !== 'boolean') settings.enabled = DEFAULT_SETTINGS.enabled;
    if (typeof settings.includeUserMessages !== 'boolean') settings.includeUserMessages = DEFAULT_SETTINGS.includeUserMessages;
    if (typeof settings.overlapSounds !== 'boolean') settings.overlapSounds = DEFAULT_SETTINGS.overlapSounds;
    if (!Array.isArray(settings.entries)) settings.entries = [];

    for (const entry of settings.entries) {
        if (!entry.id) entry.id = crypto.randomUUID();
        if (typeof entry.word !== 'string') entry.word = '';
        if (entry.mode !== 'combo') entry.mode = 'exact';
        if (!Number.isFinite(Number(entry.volume))) entry.volume = 1;
        entry.volume = Math.max(0, Math.min(1, Number(entry.volume)));
        if (!Array.isArray(entry.files)) entry.files = [];
        for (const file of entry.files) {
            if (!file.id) file.id = crypto.randomUUID();
            if (typeof file.name !== 'string') file.name = 'audio';
            if (typeof file.type !== 'string') file.type = 'audio/*';
        }
    }

    return settings;
}

function saveSettings() {
    const { saveSettingsDebounced } = getContext();
    saveSettingsDebounced();
}

function openDb() {
    if (dbPromise) return dbPromise;

    dbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onerror = () => reject(request.error || new Error('Failed to open IndexedDB.'));
        request.onsuccess = () => resolve(request.result);
        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME, { keyPath: 'id' });
            }
        };
    });

    return dbPromise;
}

async function putAudio(fileId, file) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        store.put({
            id: fileId,
            blob: file,
            updatedAt: Date.now(),
        });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error || new Error('Failed to save the audio.'));
        tx.onabort = () => reject(tx.error || new Error('Failed to save the audio.'));
    });
}

async function getAudio(fileId) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const request = tx.objectStore(STORE_NAME).get(fileId);
        request.onsuccess = () => resolve(request.result?.blob || null);
        request.onerror = () => reject(request.error || new Error('Failed to read the audio.'));
    });
}

async function deleteAudio(fileId) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).delete(fileId);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error || new Error('Failed to delete the audio.'));
        tx.onabort = () => reject(tx.error || new Error('Failed to delete the audio.'));
    });
}

async function clearExtensionAudio() {
    const settings = getSettings();
    const ids = settings.entries.flatMap(entry => (entry.files || []).map(file => file.id));
    await Promise.all(ids.map(id => deleteAudio(id).catch(() => {})));
}

function escapeRegex(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isInsideIgnoredElement(node) {
    let el = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
    while (el) {
        if (el.nodeType === Node.ELEMENT_NODE) {
            if (
                el.matches('code, pre, textarea, input, button, a, [contenteditable="true"], .stsw-word, .mes_edit')
                || el.classList.contains('stsw-ignore')
            ) {
                return true;
            }
        }
        el = el.parentElement;
    }
    return false;
}

function getTargetEntries() {
    const settings = getSettings();
    return settings.entries.filter(entry => entry.word.trim() && entry.files?.length);
}

function getExactEntries() {
    return getTargetEntries().filter(entry => entry.mode !== 'combo');
}

function parseComboTerms(value) {
    const raw = String(value ?? '')
        .split('+')
        .map(term => term.trim())
        .filter(Boolean);

    const seen = new Set();
    const terms = [];
    for (const term of raw) {
        const key = term.toLocaleLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        terms.push(term);
    }
    return terms;
}

function getComboEntries() {
    const settings = getSettings();
    return settings.entries
        .map((entry, index) => ({ entry, index, terms: parseComboTerms(entry.word) }))
        .filter(item => item.entry.mode === 'combo' && item.entry.files?.length && item.terms.length >= 2);
}

function buildPattern(entries) {
    if (!entries.length) return null;

    const sorted = [...entries].sort((a, b) => b.word.trim().length - a.word.trim().length);
    const alternatives = sorted.map(entry => escapeRegex(entry.word.trim()));

    // The negative character class is Unicode-aware, so accented Portuguese text works as expected.
    return {
        regex: new RegExp(`(^|[^\\p{L}\\p{N}_])(${alternatives.join('|')})(?=$|[^\\p{L}\\p{N}_])`, 'giu'),
        entries: sorted,
    };
}

function findEntryByMatchedWord(match, entries) {
    const normalized = match.trim().toLocaleLowerCase();
    return entries.find(entry => entry.word.trim().toLocaleLowerCase() === normalized) || null;
}

function findWholeWordMatches(text, term) {
    const normalizedTerm = String(term ?? '').trim();
    if (!normalizedTerm) return [];

    // Allow flexible whitespace inside a configured multi-word term.
    const escaped = escapeRegex(normalizedTerm).replace(/\s+/g, '\\s+');
    const regex = new RegExp(`(^|[^\\p{L}\\p{N}_])(${escaped})(?=$|[^\\p{L}\\p{N}_])`, 'giu');
    const matches = [];
    let match;

    while ((match = regex.exec(text)) !== null) {
        matches.push({
            index: match.index + (match[1] || '').length,
            length: match[2].length,
            text: match[2],
        });
    }

    return matches;
}

function getComboGroups(root) {
    const groups = new Map();
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
            if (!node.nodeValue) return NodeFilter.FILTER_REJECT;

            let el = node.parentElement;
            while (el && el !== root) {
                if (el.matches?.('code, pre, textarea, input, button, a, [contenteditable="true"], .mes_edit')) {
                    return NodeFilter.FILTER_REJECT;
                }
                el = el.parentElement;
            }

            return NodeFilter.FILTER_ACCEPT;
        },
    });

    while (walker.nextNode()) {
        const node = walker.currentNode;
        const block = node.parentElement?.closest?.('p, li, blockquote, h1, h2, h3, h4, h5, h6') || root;
        let group = groups.get(block);
        if (!group) {
            group = { block, nodes: [], text: '' };
            groups.set(block, group);
        }
        group.nodes.push({ node, start: group.text.length });
        group.text += node.nodeValue;
    }

    return [...groups.values()];
}

function getSentenceRanges(text) {
    const ranges = [];
    let start = 0;

    // A comma (and other internal punctuation) does NOT end a sentence.
    // Combo terms must be allowed to match across commas, e.g.
    // "the bus stopped hissing, and the doors opened" -> doors+bus.
    // Only sentence-ending punctuation closes the matching range.
    for (let i = 0; i < text.length; i++) {
        const char = text[i];
        if (char === '.' || char === '!' || char === '?' || char === '。' || char === '！' || char === '？') {
            const end = i + 1;
            if (end > start) ranges.push({ start, end });
            start = end;
        }
    }

    if (start < text.length) ranges.push({ start, end: text.length });
    return ranges;
}

function locateComboTextNode(group, start, length) {
    const end = start + length;
    for (const item of group.nodes) {
        const itemEnd = item.start + item.node.nodeValue.length;
        if (start >= item.start && end <= itemEnd) {
            return { item, localStart: start - item.start };
        }
    }
    return null;
}

function setWordSpanEntry(span, entry) {
    if (!span || !entry) return;
    span.dataset.stswEntryId = entry.id;
    span.title = `Play sound: ${entry.word}`;
    span.setAttribute('aria-label', `Play sound for ${entry.word}`);
}

function comboEntryPriority(item) {
    const totalLength = item.terms.reduce((sum, term) => sum + term.length, 0);
    return [item.terms.length, totalLength, -item.index];
}

function isHigherPriorityCombo(a, b) {
    const pa = comboEntryPriority(a);
    const pb = comboEntryPriority(b);
    for (let i = 0; i < pa.length; i++) {
        if (pa[i] !== pb[i]) return pa[i] > pb[i];
    }
    return false;
}

function createWordSpan(matchedText, entry) {
    const span = document.createElement('span');
    span.className = 'stsw-word';
    span.dataset.stswEntryId = entry.id;
    span.textContent = matchedText;
    span.title = `Play sound: ${entry.word}`;
    span.setAttribute('role', 'button');
    span.setAttribute('tabindex', '0');
    span.setAttribute('aria-label', `Play sound for ${entry.word}`);
    return span;
}

function wrapComboCandidatesInTextNode(node, candidates) {
    if (!node?.parentNode || !candidates.length) return;

    const value = node.nodeValue || '';
    const sorted = [...candidates]
        .sort((a, b) => a.localStart - b.localStart || b.length - a.length);

    const accepted = [];
    let cursor = 0;
    for (const candidate of sorted) {
        if (candidate.localStart < cursor) continue;
        if (candidate.localStart + candidate.length > value.length) continue;
        accepted.push(candidate);
        cursor = candidate.localStart + candidate.length;
    }

    if (!accepted.length) return;

    const fragment = document.createDocumentFragment();
    let last = 0;
    for (const candidate of accepted) {
        if (candidate.localStart > last) {
            fragment.appendChild(document.createTextNode(value.slice(last, candidate.localStart)));
        }

        fragment.appendChild(createWordSpan(
            value.slice(candidate.localStart, candidate.localStart + candidate.length),
            candidate.entry,
        ));
        last = candidate.localStart + candidate.length;
    }

    if (last < value.length) fragment.appendChild(document.createTextNode(value.slice(last)));
    node.parentNode.replaceChild(fragment, node);
}

function processCombinationTriggers(messageElement) {
    const comboEntries = getComboEntries();
    if (!comboEntries.length) return;

    const textRoot = messageElement?.querySelector?.('.mes_text');
    if (!textRoot) return;

    for (const group of getComboGroups(textRoot)) {
        const sentenceRanges = getSentenceRanges(group.text);
        const candidatesByNode = new Map();
        const upgrades = new Map();

        for (const sentence of sentenceRanges) {
            const sentenceText = group.text.slice(sentence.start, sentence.end);

            for (const combo of comboEntries) {
                const matchesByTerm = combo.terms.map(term => findWholeWordMatches(sentenceText, term));
                if (matchesByTerm.some(matches => !matches.length)) continue;

                for (const triggerMatch of matchesByTerm[0]) {
                    const globalStart = sentence.start + triggerMatch.index;
                    const located = locateComboTextNode(group, globalStart, triggerMatch.length);
                    if (!located) continue;

                    const { item, localStart } = located;
                    const existingSpan = item.node.parentElement?.closest?.('.stsw-word');

                    if (existingSpan && existingSpan.textContent?.trim().toLocaleLowerCase() === triggerMatch.text.trim().toLocaleLowerCase()) {
                        const previous = upgrades.get(existingSpan);
                        if (!previous || isHigherPriorityCombo(combo, previous)) upgrades.set(existingSpan, combo);
                        continue;
                    }

                    if (existingSpan) continue;

                    const key = item.node;
                    let list = candidatesByNode.get(key);
                    if (!list) {
                        list = [];
                        candidatesByNode.set(key, list);
                    }

                    const startKey = localStart;
                    const previous = list.find(candidate => candidate.localStart === startKey);
                    const candidate = {
                        localStart,
                        length: triggerMatch.length,
                        entry: combo.entry,
                        combo,
                    };
                    if (!previous) {
                        list.push(candidate);
                    } else if (isHigherPriorityCombo(combo, previous.combo)) {
                        previous.length = candidate.length;
                        previous.entry = candidate.entry;
                        previous.combo = candidate.combo;
                    }
                }
            }
        }

        for (const [span, combo] of upgrades) {
            if (span.dataset.stswEntryId !== combo.entry.id) setWordSpanEntry(span, combo.entry);
        }

        for (const [node, candidates] of candidatesByNode) {
            if (node.isConnected && !node.parentElement?.closest?.('.stsw-word')) {
                wrapComboCandidatesInTextNode(node, candidates);
            }
        }
    }
}

function wrapTextNode(textNode, pattern) {
    if (!pattern || !textNode?.nodeValue || isInsideIgnoredElement(textNode)) return;

    const value = textNode.nodeValue;
    pattern.regex.lastIndex = 0;
    let match;
    let lastIndex = 0;
    let changed = false;
    const fragment = document.createDocumentFragment();

    while ((match = pattern.regex.exec(value)) !== null) {
        const fullMatchStart = match.index;
        const matchedWord = match[2];
        const prefix = match[1] || '';
        const wordStart = fullMatchStart + prefix.length;

        if (wordStart > lastIndex) {
            fragment.appendChild(document.createTextNode(value.slice(lastIndex, wordStart)));
        }

        const entry = findEntryByMatchedWord(matchedWord, pattern.entries);
        if (!entry) {
            fragment.appendChild(document.createTextNode(value.slice(wordStart, wordStart + matchedWord.length)));
        } else {
            const span = document.createElement('span');
            span.className = 'stsw-word';
            span.dataset.stswEntryId = entry.id;
            span.textContent = matchedWord;
            span.title = `Play sound: ${entry.word}`;
            span.setAttribute('role', 'button');
            span.setAttribute('tabindex', '0');
            span.setAttribute('aria-label', `Play sound for ${entry.word}`);
            fragment.appendChild(span);
            changed = true;
        }

        lastIndex = wordStart + matchedWord.length;
        pattern.regex.lastIndex = lastIndex;
    }

    if (!changed) return;
    if (lastIndex < value.length) fragment.appendChild(document.createTextNode(value.slice(lastIndex)));
    textNode.parentNode?.replaceChild(fragment, textNode);
}

function processSubtree(root) {
    if (!root) return;
    const pattern = buildPattern(getExactEntries());
    if (!pattern) return;

    const textNodes = [];
    const walker = document.createTreeWalker(
        root.nodeType === Node.TEXT_NODE ? root.parentNode : root,
        NodeFilter.SHOW_TEXT,
        {
            acceptNode(node) {
                if (root.nodeType === Node.TEXT_NODE && node !== root) return NodeFilter.FILTER_REJECT;
                if (!node.nodeValue?.trim()) return NodeFilter.FILTER_REJECT;
                if (isInsideIgnoredElement(node)) return NodeFilter.FILTER_REJECT;
                return NodeFilter.FILTER_ACCEPT;
            },
        },
    );

    while (walker.nextNode()) textNodes.push(walker.currentNode);
    if (root.nodeType === Node.TEXT_NODE && !textNodes.includes(root) && !isInsideIgnoredElement(root)) {
        textNodes.push(root);
    }

    for (const node of textNodes) wrapTextNode(node, pattern);
}

function getMessageElementFromNode(node) {
    const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    return element?.closest?.('#chat .mes') || null;
}

function shouldProcessMessage(messageElement) {
    const settings = getSettings();
    if (!settings.includeUserMessages) {
        const isUser = messageElement?.getAttribute('is_user') === 'true'
            || messageElement?.classList.contains('user_mes');
        if (isUser) return false;
    }
    return true;
}

function processMessage(messageElement) {
    if (!messageElement || !shouldProcessMessage(messageElement)) return;
    const text = messageElement.querySelector('.mes_text');
    if (!text) return;
    processCombinationTriggers(messageElement);
    processSubtree(text);
}

function processAllMessages() {
    if (!getSettings().enabled) return;
    document.querySelectorAll('#chat .mes').forEach(processMessage);
}

function unwrapAllWords() {
    document.querySelectorAll('.stsw-word').forEach(span => {
        const text = document.createTextNode(span.textContent || '');
        span.replaceWith(text);
    });
}

function queueRerender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => {
        renderQueued = false;
        if (!getSettings().enabled) {
            unwrapAllWords();
            return;
        }
        processAllMessages();
    });
}

function stopAllSounds() {
    for (const audio of activeAudios) {
        try {
            audio.pause();
            audio.currentTime = 0;
        } catch (_) {}
    }
    activeAudios.clear();

    for (const url of objectUrls) {
        URL.revokeObjectURL(url);
    }
    objectUrls.clear();
}

async function playEntry(entry) {
    if (!entry?.files?.length) {
        toastr.warning(`The word “${entry?.word || ''}” has no audio configured.`);
        return;
    }

    const settings = getSettings();
    if (!settings.overlapSounds) stopAllSounds();

    const fileInfo = entry.files[Math.floor(Math.random() * entry.files.length)];
    const blob = await getAudio(fileInfo.id);
    if (!blob) {
        toastr.error(`Could not find the file “${fileInfo.name}”. Reopen the settings and select it again.`);
        return;
    }

    const url = URL.createObjectURL(blob);
    objectUrls.add(url);
    const audio = new Audio(url);
    audio.volume = Math.max(0, Math.min(1, Number(entry.volume ?? 1)));
    audio.preload = 'auto';
    activeAudios.add(audio);

    const cleanup = () => {
        activeAudios.delete(audio);
        objectUrls.delete(url);
        URL.revokeObjectURL(url);
    };
    audio.addEventListener('ended', cleanup, { once: true });
    audio.addEventListener('error', cleanup, { once: true });

    try {
        await audio.play();
    } catch (error) {
        cleanup();
        toastr.error(`The browser could not play “${fileInfo.name}”.`);
        console.error('[Sound Words] audio.play() failed:', error);
    }
}

function onChatClick(event) {
    const span = event.target.closest?.('.stsw-word');
    if (!span) return;
    event.preventDefault();
    event.stopPropagation();

    const entryId = span.dataset.stswEntryId;
    const entry = getSettings().entries.find(item => item.id === entryId);
    if (entry) {
        playEntry(entry).catch(error => {
            console.error('[Sound Words] Failed to play sound:', error);
            toastr.error('Error playing the sound.');
        });
    }
}

function onChatKeydown(event) {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const span = event.target.closest?.('.stsw-word');
    if (!span) return;
    event.preventDefault();
    span.click();
}

function setupChatObserver() {
    if (chatObserver) chatObserver.disconnect();

    const chat = document.querySelector('#chat');
    if (!chat) return;

    chatObserver = new MutationObserver(mutations => {
        if (!getSettings().enabled) return;

        for (const mutation of mutations) {
            for (const node of mutation.addedNodes) {
                if (node.nodeType === Node.ELEMENT_NODE && node.matches('.stsw-word')) continue;
                if (node.nodeType === Node.TEXT_NODE && node.parentElement?.closest?.('.stsw-word')) continue;

                const message = getMessageElementFromNode(node);
                if (message?.querySelector('.mes_text')) {
                    processMessage(message);
                    continue;
                }

                if (node.nodeType === Node.ELEMENT_NODE) processSubtree(node);
                else if (node.nodeType === Node.TEXT_NODE) processSubtree(node);
            }
        }
    });

    chatObserver.observe(chat, { childList: true, subtree: true });
}

function setupRootObserver() {
    if (rootObserver) rootObserver.disconnect();

    rootObserver = new MutationObserver(() => {
        const chat = document.querySelector('#chat');
        if (chat && !chatObserver) setupChatObserver();
    });

    rootObserver.observe(document.body, { childList: true, subtree: true });
}

function escapeHtml(value) {
    const div = document.createElement('div');
    div.textContent = value ?? '';
    return div.innerHTML;
}

function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes < 0) return '';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function entryHtml(entry) {
    const files = entry.files || [];
    const filesHtml = files.length
        ? files.map(file => `
            <div class="stsw-file" data-file-id="${escapeHtml(file.id)}">
                <span class="stsw-file-name" title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</span>
                <span class="stsw-file-size">${formatBytes(file.size)}</span>
                <button type="button" class="menu_button stsw-test-file" data-entry-id="${escapeHtml(entry.id)}" data-file-id="${escapeHtml(file.id)}">▶</button>
                <button type="button" class="menu_button stsw-remove-file" data-entry-id="${escapeHtml(entry.id)}" data-file-id="${escapeHtml(file.id)}">×</button>
            </div>
        `).join('')
        : '<div class="stsw-empty">No audio selected.</div>';

    const volume = Math.round(Number(entry.volume ?? 1) * 100);
    const mode = entry.mode === 'combo' ? 'combo' : 'exact';
    const placeholder = mode === 'combo' ? 'e.g.: knocks+side+fist' : 'e.g.: door, footsteps, thunder';

    return `
        <div class="stsw-entry" data-entry-id="${escapeHtml(entry.id)}">
            <div class="stsw-entry-top">
                <div class="stsw-word-input-wrap">
                    <label>${mode === 'combo' ? 'Combination terms (+)' : 'Word / phrase'}</label>
                    <input class="text_pole stsw-word-input" type="text" value="${escapeHtml(entry.word)}" placeholder="${placeholder}">
                </div>
                <div class="stsw-mode-wrap">
                    <label>Trigger type</label>
                    <select class="text_pole stsw-match-mode">
                        <option value="exact" ${mode === 'exact' ? 'selected' : ''}>Exact word / phrase</option>
                        <option value="combo" ${mode === 'combo' ? 'selected' : ''}>Word combination</option>
                    </select>
                </div>
                <div class="stsw-volume-wrap">
                    <label>Volume <span class="stsw-volume-value">${volume}%</span></label>
                    <input class="stsw-volume" type="range" min="0" max="1" step="0.01" value="${entry.volume}">
                </div>
                <button type="button" class="menu_button stsw-play-entry" data-entry-id="${escapeHtml(entry.id)}">▶ Test</button>
                <button type="button" class="menu_button stsw-delete-entry" data-entry-id="${escapeHtml(entry.id)}">🗑 Delete</button>
            </div>

            <div class="stsw-files-head">
                <b>Audio files (one or more; one will be chosen at random)</b>
                <label class="menu_button stsw-file-picker">
                    + Add audio file(s)
                    <input class="stsw-file-input" type="file" accept="audio/*" multiple hidden>
                </label>
            </div>
            <div class="stsw-files">${filesHtml}</div>
        </div>
    `;
}

function renderEntries() {
    const container = document.querySelector('#stsw-entries');
    if (!container) return;
    const settings = getSettings();

    if (!settings.entries.length) {
        container.innerHTML = '<div class="stsw-empty stsw-empty-big">No words configured. Tap “Add word”.</div>';
        return;
    }

    container.innerHTML = settings.entries.map(entryHtml).join('');
}

function renderSettingsUi() {
    const panel = document.querySelector(SETTINGS_ID);
    if (!panel) return;

    const settings = getSettings();
    panel.querySelector('#stsw-enabled').checked = settings.enabled;
    panel.querySelector('#stsw-include-user').checked = settings.includeUserMessages;
    panel.querySelector('#stsw-overlap').checked = settings.overlapSounds;
    renderEntries();
}

async function addFilesToEntry(entry, fileList) {
    const files = [...fileList].filter(file => file.type.startsWith('audio/') || /\.(mp3|wav|ogg|m4a|aac|flac|opus|weba)$/i.test(file.name));
    if (!files.length) {
        toastr.warning('No recognized audio files.');
        return;
    }

    for (const file of files) {
        const fileId = crypto.randomUUID();
        try {
            await putAudio(fileId, file);
            entry.files.push({
                id: fileId,
                name: file.name,
                type: file.type || 'audio/*',
                size: file.size,
            });
        } catch (error) {
            console.error('[Sound Words] Failed to store file:', file.name, error);
            toastr.error(`Could not save “${file.name}”. The browser storage may be full.`);
        }
    }

    saveSettings();
    renderSettingsUi();
    queueRerender();
}

function bindSettingsEvents() {
    const panel = document.querySelector(SETTINGS_ID);
    if (!panel) return;

    panel.addEventListener('change', async event => {
        const settings = getSettings();
        const target = event.target;

        if (target.id === 'stsw-enabled') {
            settings.enabled = target.checked;
            saveSettings();
            queueRerender();
            return;
        }

        if (target.id === 'stsw-include-user') {
            settings.includeUserMessages = target.checked;
            saveSettings();
            unwrapAllWords();
            queueRerender();
            return;
        }

        if (target.id === 'stsw-overlap') {
            settings.overlapSounds = target.checked;
            saveSettings();
            return;
        }

        if (target.classList.contains('stsw-match-mode')) {
            const entryElement = target.closest('.stsw-entry');
            const entryId = entryElement?.dataset.entryId;
            const entry = settings.entries.find(item => item.id === entryId);
            if (entry) {
                entry.mode = target.value === 'combo' ? 'combo' : 'exact';
                saveSettings();
                unwrapAllWords();
                renderSettingsUi();
                queueRerender();
            }
            return;
        }

        if (target.classList.contains('stsw-file-input')) {
            const entryElement = target.closest('.stsw-entry');
            const entryId = entryElement?.dataset.entryId;
            const entry = settings.entries.find(item => item.id === entryId);
            if (entry && target.files?.length) {
                await addFilesToEntry(entry, target.files);
            }
            target.value = '';
        }
    });

    panel.addEventListener('pointerdown', event => {
        const input = event.target.closest?.('.stsw-word-input');
        if (input) {
            input.focus({ preventScroll: true });
        }
    });

    panel.addEventListener('input', event => {
        const settings = getSettings();
        const target = event.target;
        const entryElement = target.closest('.stsw-entry');
        if (!entryElement) return;
        const entry = settings.entries.find(item => item.id === entryElement.dataset.entryId);
        if (!entry) return;

        if (target.classList.contains('stsw-volume')) {
            entry.volume = Number(target.value);
            const label = entryElement.querySelector('.stsw-volume-value');
            if (label) label.textContent = `${Math.round(entry.volume * 100)}%`;
            saveSettings();
        }

        if (target.classList.contains('stsw-word-input')) {
            entry.word = target.value;
            saveSettings();
        }
    });

    panel.addEventListener('click', async event => {
        const settings = getSettings();
        const target = event.target.closest('button');

        if (target?.id === 'stsw-add-entry') {
            settings.entries.push({
                id: crypto.randomUUID(),
                word: '',
                mode: 'exact',
                volume: 1,
                files: [],
            });
            saveSettings();
            renderSettingsUi();
            const newInput = panel.querySelector('.stsw-entry:last-child .stsw-word-input');
            if (newInput) {
                newInput.focus();
                newInput.select();
            }
            return;
        }

        if (target?.id === 'stsw-stop-all') {
            stopAllSounds();
            return;
        }

        if (!target) return;
        const entryId = target.dataset.entryId;
        const fileId = target.dataset.fileId;
        const entry = settings.entries.find(item => item.id === entryId);

        if (target.classList.contains('stsw-play-entry')) {
            await playEntry(entry);
            return;
        }

        if (target.classList.contains('stsw-delete-entry')) {
            if (!entry) return;
            for (const file of entry.files || []) await deleteAudio(file.id).catch(() => {});
            settings.entries = settings.entries.filter(item => item.id !== entryId);
            saveSettings();
            renderSettingsUi();
            unwrapAllWords();
            queueRerender();
            return;
        }

        if (target.classList.contains('stsw-test-file')) {
            if (!entry || !fileId) return;
            const originalFiles = entry.files;
            entry.files = originalFiles.filter(file => file.id === fileId);
            try {
                await playEntry(entry);
            } finally {
                entry.files = originalFiles;
            }
            return;
        }

        if (target.classList.contains('stsw-remove-file')) {
            if (!entry || !fileId) return;
            await deleteAudio(fileId).catch(() => {});
            entry.files = entry.files.filter(file => file.id !== fileId);
            saveSettings();
            renderSettingsUi();
            unwrapAllWords();
            queueRerender();
        }
    });
}

async function buildSettingsPanel() {
    const { renderExtensionTemplateAsync } = getContext();
    let html = '';

    try {
        html = await renderExtensionTemplateAsync(`third-party/${EXTENSION_NAME}`, 'settings', {});
    } catch (error) {
        console.warn('[Sound Words] Failed to render settings template:', error);
        html = `
            <div id="stsw-settings" class="stsw-settings inline-drawer">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b>Sound Words</b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content">Error loading the interface.</div>
            </div>`;
    }

    const target = document.querySelector('#extensions_settings2') || document.querySelector('#extensions_settings');
    if (!target) return;
    target.insertAdjacentHTML('beforeend', html);

    const panel = document.querySelector(SETTINGS_ID);
    if (!panel) return;
    bindSettingsEvents();
    renderSettingsUi();
}

function cleanup() {
    if (chatObserver) chatObserver.disconnect();
    if (rootObserver) rootObserver.disconnect();
    chatObserver = null;
    rootObserver = null;
    document.removeEventListener('click', onChatClick, true);
    document.removeEventListener('keydown', onChatKeydown, true);
    stopAllSounds();
}

async function init() {
    if (isInitialized) return;
    isInitialized = true;

    getSettings();
    await buildSettingsPanel();

    document.addEventListener('click', onChatClick, true);
    document.addEventListener('keydown', onChatKeydown, true);

    setupChatObserver();
    setupRootObserver();
    processAllMessages();

    log('loaded');
}

// Expose a tiny debug API for troubleshooting from the browser console.
window.SoundWords = {
    play: (word) => {
        const settings = getSettings();
        const entry = settings.entries.find(item => item.word.trim().toLocaleLowerCase() === String(word).trim().toLocaleLowerCase());
        return entry ? playEntry(entry) : Promise.reject(new Error(`Word not configured: ${word}`));
    },
    render: () => {
        unwrapAllWords();
        queueRerender();
    },
    stop: stopAllSounds,
    cleanup,
};

jQuery(async () => {
    try {
        await init();
    } catch (error) {
        console.error('[Sound Words] Initialization failed:', error);
        toastr.error('Sound Words could not initialize. See the console for details.');
    }
});
