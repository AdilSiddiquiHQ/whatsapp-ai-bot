/**
 * Sub-2ms Deterministic Guardrails, Anti-Slop Sanitizer, Loop Shield & Stop/Phatic Classifiers.
 * Zero extra LLM calls — runs strictly in V8 RAM before dispatch to Baileys.
 */

// 1. Reasoning leaks, LLM meta-delimiters, and placeholder detectors
const REASONING_TAGS_REGEX = /<(?:think|thought|reasoning)>[\s\S]*?(?:<\/(?:think|thought|reasoning)>|$)/gi;
const XML_GROUNDING_REGEX = /<grounding>[\s\S]*?(?:<\/grounding>|$)/gi;
const XML_REPLY_WRAP_REGEX = /<\/?reply>/gi;
const LLM_DELIMITERS_REGEX = /(?:<\|im_start\|>|<\|im_end\|>|<s>|<\/s>|\[INST\]|\[\/INST\]|<<SYS>>|<\/SYS>>)/gi;
const MALFORMED_INTERNAL_TAGS_REGEX = /\n?\[(?:LEAD|HANDOFF|VOICE_INTENT|NO_REPLY)[^\]]*$/gi;

const PLACEHOLDER_TOKENS_REGEX = /\[(?:(?:your|insert|enter|add)\s+)?(?:city|location|link|website|url|phone|number|name|business|company|price|amount|product|service|date|time)\]/gi;
const DUMMY_PHONE_REGEX = /\b(?:\+?\d{1,3}[-.\s]*)?\d{2,4}[xX]{3,8}\b/g;
const AI_CONFESSION_REGEX = /(?:as an ai(?:\s+language\s+model)?|as a (?:virtual\s+)?(?:assistant|chatbot)|i am an artificial intelligence|according to my programming|i don't have access to real-time)\b/i;
const SYS_PROMPT_MARKERS = ['AGENCY ROLE & INSTRUCTIONS', 'ZERO-HALLUCINATION RULE', 'VERIFIED BUSINESS DATA', 'SILENT LEAD TAG', 'FINAL OUTPUT PROTOCOL'];

// 2. Numeric, currency, discount, code, URL & phone extractors
const CURRENCY_PRICE_REGEX = /(?:[₹$€£]|Rs\.?|INR|USD|EUR|GBP|AED|SAR)\s*(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)(?:\s*(?:\/-|\b))?|(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)\s*(?:[₹$€£]|Rs\.?|INR|USD|EUR|GBP|AED|SAR|\/-)\b/gi;
const PERCENT_DISCOUNT_REGEX = /\b(\d{1,2}(?:\.\d+)?)\s*%(?:\s*(?:off|discount|cashback|extra))?\b/gi;
const PROMO_CODE_MENTION_REGEX = /\b(?:code|coupon|promo)\s*[:\-]?\s*([A-Z0-9]{4,16})\b/gi;
const URL_REGEX = /(?:https?:\/\/|www\.)[^\s<>"'{}|\\^`]+|\b[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.(?:com|org|net|in|io|co|ai|app|store|shop|me|info)\b[^\s<>"'{}|\\^`]*/gi;
const PHONE_NUMBER_REGEX = /(?:\+?\d{1,3}[-.\s]*)?(?:\(?\d{2,5}\)?[-.\s]*)?\d{3,5}[-.\s]*\d{3,5}\b/g;

// 3. Inbound Autoresponder & Prompt-Injection Shields
const AUTORESPONDER_SIGNATURES = [
    /(?:thank\s+you|thanks)\s+for\s+(?:contacting|reaching\s+out\s+to|messaging)\s+[A-Za-z]/i,
    /(?:we\s+are|i\s+am|currently)\s+(?:away|closed|out\s+of\s+office|unavailable|offline)/i,
    /(?:our\s+working\s+hours|business\s+hours\s+are)\b/i,
    /please\s+let\s+us\s+know\s+how\s+we\s+can\s+(?:help|assist)\s+you\s+(?:today|and)/i,
    /this\s+is\s+an\s+automated\s+(?:message|reply|response)/i,
    /auto-?reply\s*:/i,
    /do\s+not\s+reply\s+to\s+this\s+message/i,
    /press\s+[1-9]\s+for\b|reply\s+with\s+[1-9]\s+to\b/i
];

const PROMPT_INJECTION_SIGNATURES = [
    /(?:ignore|disregard|forget|override)\s+(?:all\s+)?(?:previous|prior|system|above)\s+(?:instructions|rules|prompts)/i,
    /(?:you\s+are\s+now|switch\s+to|act\s+as)\s+(?:in\s+)?(?:developer|dan|jailbreak|unfiltered)\s+mode/i,
    /(?:repeat|print|reveal|display|output|dump)\s+(?:your\s+)?(?:system\s+prompt|instructions|initial\s+prompt)\s*(?:verbatim|word\s+for\s+word)?/i,
    /(?:system\s*:\s*override|###\s*new\s+instruction)/i
];

// 4. Anti-AI-Slop Linguistics Cleaners
const OPENER_PATTERNS = [
    /^(?:(?:Certainly|Absolutely|Sure thing|Of course|Delighted to help|Great question|Excellent question|Happy to help|Good question)[!,.]*\s*)+/i,
    /^(?:I(?: would|'d)? be (?:happy|delighted|pleased|glad) to (?:assist|help)(?: you)?(?: with that)?)[!,.]*\s*/i,
    /^(?:Thank you for (?:reaching out|contacting us|messaging us)(?: today)?)[!,.]*\s*/i,
    /^(?:Thanks for (?:reaching out|messaging|contacting us))[!,.]*\s*/i,
    /^(?:I completely understand (?:your concern|what you need))[!,.]*\s*/i,
    /^(?:I(?:'m| am) here to help(?: you)?)[!,.]*\s*/i,
    /^(?:Greetings|Warm greetings|Hope you are doing well|Hope this message finds you well)[!,.]*\s*/i,
    /^(?:Regarding your (?:inquiry|query|question) (?:about|regarding)\s+[^,.:]+[,.:]\s*)/i
];

const CLOSER_PATTERNS = [
    /(?:Please\s+)?(?:feel\s+free\s+to\s+)?(?:let\s+me\s+know|reach\s+out|contact\s+us)\s+if\s+you\s+(?:have|need|require)\s+(?:any(?:\s+further)?|further)?\s*(?:questions|assistance|queries|clarifications|details)?[.!]?\s*$/i,
    /(?:Don't|Do\s+not)\s+hesitate\s+to\s+(?:reach\s+out|ask|contact(?:\s+us)?)[.!]?\s*$/i,
    /Looking\s+forward\s+to\s+(?:serving|assisting|hearing\s+from)\s+you[.!]?\s*$/i,
    /Have\s+a\s+(?:great|wonderful|fantastic|nice|blessed)\s+day(?:\s+ahead)?[.!]?\s*$/i,
    /Hope\s+this\s+(?:helps|information\s+helps)[.!]?\s*$/i,
    /(?:I'm\s+|We're\s+)?always\s+here\s+to\s+help[.!]?\s*$/i,
    /Let\s+me\s+know\s+if\s+(?:there's\s+anything\s+else|you\s+need\s+anything\s+else)(?:\s+today)?[.!]?\s*$/i,
    /Wishing\s+you\s+a\s+(?:great|wonderful)\s+day[.!]?\s*$/i,
    /Aapka\s+din\s+(?:shubh|mangalmay)\s+ho[.!]?\s*$/i
];

const HEADER_PATTERNS = [
    /^\s*\*(?:Key Highlights|Highlights|Summary|Overview|Details|Important Notes|Next Steps|Package Includes|Features|Services Offered):\*\s*\n?/gim,
    /^\s*#{1,4}\s*(?:Key Highlights|Highlights|Summary|Overview|Details|Important Notes|Next Steps)\s*\n?/gim
];

const BUZZWORD_REPLACEMENTS = [
    [/\butilize\b/gi, 'use'],
    [/\butilizes\b/gi, 'uses'],
    [/\butilizing\b/gi, 'using'],
    [/\bassist\b/gi, 'help'],
    [/\bassisting\b/gi, 'helping'],
    [/\bassistance\b/gi, 'help'],
    [/\bkindly ensure\b/gi, 'please make sure'],
    [/\bkindly note\b/gi, 'please note'],
    [/\bkindly revert back\b/gi, 'please reply'],
    [/\brevert back\b/gi, 'reply'],
    [/\bdo the needful\b/gi, 'take care of this'],
    [/\bas per your convenience\b/gi, 'whenever suits you'],
    [/\bavail\b/gi, 'get'],
    [/\bleverage\b/gi, 'use'],
    [/\bdelighted to\b/gi, 'happy to'],
    [/\bcomprehensive\b/gi, 'complete'],
    [/\bpertain to\b/gi, 'are about'],
    [/\bfacilitate\b/gi, 'help arrange'],
    [/\bseamless\b/gi, 'smooth'],
    [/\bseamlessly\b/gi, 'smoothly'],
    [/\bparamount\b/gi, 'crucial'],
    [/\brequisite\b/gi, 'needed'],
    [/\bplethora of\b/gi, 'plenty of'],
    [/\bendeavor to\b/gi, 'aim to'],
    [/\binquire\b/gi, 'ask'],
    [/\bintimate us\b/gi, 'let us know']
];

const HINDI_SLOP_REPLACEMENTS = [
    [/\bkripaya(?:\s+karke)?\s+batayein\b/gi, 'Bataiye,'],
    [/\baapka\s+(?:hardik\s+)?swagat\s+hai\b/gi, 'Haanji,'],
    [/\bshubh\s+naam\b/gi, 'naam'],
    [/\bsevaon\s+ka\s+labh\s+uthayein\b/gi, 'offers dekh lijiye'],
    [/\baapko\s+suchit\s+kiya\s+jata\s+hai\s+ki\b/gi, 'Actually']
];

// 5. Closure Phatics & Stop/Human Classifier
const CLOSURE_PHATICS_REGEX = new RegExp(
    '^(' + [
        'thank\\s*you(?:\\s+(?:so\\s+much|bhai|sir|ma\'?am|mam|ji))?',
        'thanks(?:\\s+(?:a\\s+lot|so\\s+much|bhai|sir|ma\'?am|mam|ji))?',
        'thx', 'thnks', 'ty', 'tq', 'dhanyawad', 'shukriya',
        'ok(?:ay)?(?:\\s+(?:thanks|thx|got\\s+it|cool|bhai|sir|ji))?',
        'k', 'kk', 'alright', 'cool', 'got\\s*it', 'noted', 'understood',
        'done', 'perfect', 'great', 'awesome', 'sure', 'fine',
        'haan(?:ji)?', 'ha(?:ji)?', 'theek\\s*hai', 'thik\\s*h(?:ai)?', 'accha', 'acha', 'sahi\\s*h(?:ai)?',
        'good\\s*night', 'gn', 'bye+', 'cya', 'see\\s*you'
    ].join('|') + ')[.!,\\s]*(?:[👍👌🙏❤️🤝✅😊🔥✨]*)$',
    'iu'
);

const STANDALONE_REACTION_EMOJIS = /^[👍👌🙏❤️🤝✅😊🔥✨🙌💯]{1,3}$/u;

export function isAutoresponderMessage(text) {
    if (!text || typeof text !== 'string') return false;
    const clean = text.trim();
    if (clean.length < 15) return false;
    return AUTORESPONDER_SIGNATURES.some((pattern) => pattern.test(clean));
}

export function detectPromptInjection(text) {
    if (!text || typeof text !== 'string') return false;
    return PROMPT_INJECTION_SIGNATURES.some((pattern) => pattern.test(text));
}

export function isClosurePhatic(text, contextTurns = []) {
    const clean = String(text || '').trim();
    if (!clean) return false;
    // Never treat questions as closure phatics
    if (clean.includes('?')) return false;
    const matchesPhatic = CLOSURE_PHATICS_REGEX.test(clean) || STANDALONE_REACTION_EMOJIS.test(clean);
    if (!matchesPhatic) return false;
    // Only auto-react when preceded by a recent assistant turn
    const lastTurn = Array.isArray(contextTurns) && contextTurns.length > 0 ? contextTurns[contextTurns.length - 1] : null;
    return lastTurn?.role === 'assistant';
}

export function classifyStopIntent(text, optOutKeywords = ['stop', 'stopall', 'unsubscribe']) {
    const clean = String(text || '').trim().toLowerCase();
    if (!clean) return 'none';

    // Explicit human-agent escalation phrases must NOT opt-out/block user!
    if (/\b(?:talk|speak|connect|transfer)\s+(?:to|with)\s+(?:a\s+)?(?:human|real\s+person|agent|owner|manager|someone|staff)\b|\bneed\s+(?:a\s+)?(?:human|real\s+person|manager)\b/i.test(clean)) {
        return 'human_request';
    }

    // Conversational "wait stop..." or "stop, that's wrong" should NOT unsubscribe the user
    if (/^(?:wait|hey|arre|no|plz|please)?\s*stop[,.\s]+(?:that|this|wrong|it|not|one|plan|option)/i.test(clean)) {
        return 'none';
    }

    // Phrase-level opt-out (e.g. "stop texting me", "don't message me", "unsubscribe")
    if (/\b(?:stop\s+(?:texting|messaging|replying|bot)|don'?t\s+(?:text|message|spam)\s+me|leave\s+me\s+alone|unsubscribe\s*(?:me)?|opt[\s-]?out)\b/i.test(clean)) {
        return 'opt_out';
    }

    // Exact keyword match (e.g. standalone "stop", "stopall", "cancel")
    const escaped = (optOutKeywords || ['stop', 'stopall', 'unsubscribe']).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
    const exactRegex = new RegExp(`^(${escaped})[.!\\s]*$`, 'i');
    if (exactRegex.test(clean)) {
        return 'opt_out';
    }

    return 'none';
}

export function sanitizeWhatsAppSlop(rawText, { isFollowUp = false } = {}) {
    let text = String(rawText || '').trim();
    if (!text) return '';

    // 1. Convert markdown links [Label](https://...) to plain WhatsApp preview links
    text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '$1: $2');

    // 2. Convert headings / **bold** to WhatsApp *bold*
    text = text.replace(/^#+\s*(.*)$/gm, '*$1*');
    text = text.replace(/\*\*([^*]+)\*\*/g, '*$1*');

    // 3. Strip academic section headers
    for (const pattern of HEADER_PATTERNS) {
        text = text.replace(pattern, '');
    }

    // 4. Strip repetitive greetings on follow-up turns
    if (isFollowUp) {
        text = text.replace(/^(?:(?:Hey|Hi|Hello|Hi there)(?:\s+(?:there|[A-Za-z]+))?|Greetings|Namaste|Haanji)[!.,\s]+/i, '').trim();
    }

    // 5. Multi-pass compound opener & closer removal
    for (let pass = 0; pass < 3; pass++) {
        let modified = false;
        for (const p of OPENER_PATTERNS) {
            if (p.test(text)) {
                text = text.replace(p, '').trim();
                modified = true;
            }
        }
        for (const p of CLOSER_PATTERNS) {
            if (p.test(text)) {
                text = text.replace(p, '').trim();
                modified = true;
            }
        }
        if (!modified) break;
    }

    // 6. Purge corporate Babuspeak & stiff Hindi slop
    for (const [pattern, replacement] of BUZZWORD_REPLACEMENTS) {
        text = text.replace(pattern, replacement);
    }
    for (const [pattern, replacement] of HINDI_SLOP_REPLACEMENTS) {
        text = text.replace(pattern, replacement);
    }

    // 7. Punctuation hygiene (zero em-dashes, zero semicolons, max 1 exclamation mark)
    text = text.replace(/\s*—\s*/g, ' - ');
    text = text.replace(/\s*--\s*/g, ' - ');
    text = text.replace(/;\s*/g, ', ');
    text = text.replace(/!{2,}/g, '!');
    let exclCount = 0;
    text = text.replace(/!/g, () => (++exclCount <= 1 ? '!' : '.'));
    text = text.replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
    text = text.replace(/^[,.\-]\s*/, '').trim();

    if (text.length > 0 && /^[a-z]/.test(text)) {
        text = text.charAt(0).toUpperCase() + text.slice(1);
    }
    return text;
}

export function compileGroundingCorpus(tenant, customerQuery = '') {
    const cfg = tenant?.botConfig || {};
    const verifiedPrices = new Set();
    const verifiedPercentages = new Set();
    const verifiedCodes = new Set();
    const verifiedUrls = new Set();
    const verifiedPhones = new Set();

    const extractNum = (str) => String(str || '').replace(/,/g, '').replace(/[^0-9.]/g, '');

    for (const p of cfg.products || []) {
        if (!p || p.active === false) continue;
        const matches = String(p.price || '').match(/\d[\d,]*(?:\.\d+)?/g) || [];
        for (const m of matches) {
            const val = Number(extractNum(m));
            if (Number.isFinite(val)) verifiedPrices.add(val);
        }
        const noteNums = String(p.note || '').match(CURRENCY_PRICE_REGEX) || [];
        for (const m of noteNums) {
            const val = Number(extractNum(m));
            if (Number.isFinite(val)) verifiedPrices.add(val);
        }
    }

    for (const o of cfg.offers || []) {
        if (!o || o.active === false) continue;
        if (o.code) verifiedCodes.add(o.code.trim().toUpperCase());
        const dealStr = String(o.deal || '');
        const pctMatches = dealStr.match(PERCENT_DISCOUNT_REGEX) || [];
        for (const m of pctMatches) {
            const val = Number(extractNum(m));
            if (Number.isFinite(val)) verifiedPercentages.add(val);
        }
        const numMatches = dealStr.match(/\d[\d,]*(?:\.\d+)?/g) || [];
        for (const m of numMatches) {
            const val = Number(extractNum(m));
            if (Number.isFinite(val)) verifiedPrices.add(val);
        }
    }

    const rawCorpus = [
        tenant?.agencySystemPrompt || '',
        cfg.extraInstructions || '',
        cfg.announcement || '',
        ...(cfg.faqs || []).map((f) => `${f.q} ${f.a}`),
        ...(cfg.customRules || []),
        cfg.compiledDigest || ''
    ].join('\n');

    // Capture currency numbers + standalone price-like numbers (>= 50) written inside agency prompt/FAQs
    for (const match of rawCorpus.match(CURRENCY_PRICE_REGEX) || []) {
        const val = Number(extractNum(match));
        if (Number.isFinite(val)) verifiedPrices.add(val);
    }
    for (const match of rawCorpus.match(/\b\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?\b|\b\d{2,6}\b/g) || []) {
        const val = Number(extractNum(match));
        if (Number.isFinite(val)) verifiedPrices.add(val);
    }
    for (const match of rawCorpus.match(PERCENT_DISCOUNT_REGEX) || []) {
        const val = Number(extractNum(match));
        if (Number.isFinite(val)) verifiedPercentages.add(val);
    }

    for (const u of rawCorpus.match(URL_REGEX) || []) {
        const domain = u.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].replace(/[.,!?;:)\]]+$/, '');
        if (domain) verifiedUrls.add(domain);
    }

    for (const ph of rawCorpus.match(PHONE_NUMBER_REGEX) || []) {
        const d = ph.replace(/\D/g, '');
        if (d.length >= 8) verifiedPhones.add(d.slice(-10));
    }
    if (tenant?.waPhone) verifiedPhones.add(String(tenant.waPhone).replace(/\D/g, '').slice(-10));

    // Allow numbers mentioned directly by the customer (so bot can quote them back negatively/accurately)
    for (const qNum of customerQuery.match(/\d[\d,]*(?:\.\d+)?/g) || []) {
        const val = Number(extractNum(qNum));
        if (Number.isFinite(val)) verifiedPrices.add(val);
    }

    return {
        verifiedPrices,
        verifiedPercentages,
        verifiedCodes,
        verifiedUrls,
        verifiedPhones
    };
}

/**
 * Post-generation verification and cleaning middleware.
 * Returns:
 *   { action: 'pass', cleanedText, latencyMs }
 *   { action: 'no_reply', reason, latencyMs }
 *   { action: 'silent_abstain', reason, quarantinedText, latencyMs }
 */
export function guardAndCleanReply({
    candidateText,
    tenant = null,
    customerQuery = '',
    contactContext = null,
    isFollowUp = false,
    strictGrounding = true
}) {
    const started = performance.now();
    let text = String(candidateText || '').trim();

    // 1. Strip hidden reasoning blocks, XML grounding wrappers, and delimiter artifacts
    text = text.replace(REASONING_TAGS_REGEX, '').trim();
    text = text.replace(XML_GROUNDING_REGEX, '').trim();
    text = text.replace(XML_REPLY_WRAP_REGEX, '').trim();
    text = text.replace(LLM_DELIMITERS_REGEX, '').trim();
    text = text.replace(MALFORMED_INTERNAL_TAGS_REGEX, '').trim();

    if (!text || /^\s*\[?\s*NO_REPLY\s*\]?\s*$/i.test(text)) {
        return { action: 'no_reply', reason: 'explicit_no_reply_or_empty', latencyMs: performance.now() - started };
    }

    // 2. Quarantine prompt leaks, AI persona confessions, and template placeholders
    if (SYS_PROMPT_MARKERS.some((m) => text.includes(m))) {
        return { action: 'silent_abstain', reason: 'system_prompt_leakage', quarantinedText: text, latencyMs: performance.now() - started };
    }
    if (AI_CONFESSION_REGEX.test(text)) {
        return { action: 'silent_abstain', reason: 'ai_persona_confession', quarantinedText: text, latencyMs: performance.now() - started };
    }
    if (PLACEHOLDER_TOKENS_REGEX.test(text) || DUMMY_PHONE_REGEX.test(text)) {
        return { action: 'silent_abstain', reason: 'placeholder_token_detected', quarantinedText: text, latencyMs: performance.now() - started };
    }

    // 3. Deterministic grounding verification (prices, %, codes, URLs, phones)
    if (strictGrounding && tenant) {
        const corpus = compileGroundingCorpus(tenant, customerQuery);

        const priceMatches = [...text.matchAll(CURRENCY_PRICE_REGEX)];
        for (const m of priceMatches) {
            const rawNum = m[1] || m[2] || '';
            const numVal = Number(rawNum.replace(/,/g, ''));
            if (Number.isFinite(numVal) && numVal > 0 && !corpus.verifiedPrices.has(numVal)) {
                return {
                    action: 'silent_abstain',
                    reason: `ungrounded_price:${m[0].trim()}`,
                    quarantinedText: text,
                    latencyMs: performance.now() - started
                };
            }
        }

        const pctMatches = [...text.matchAll(PERCENT_DISCOUNT_REGEX)];
        for (const m of pctMatches) {
            const pctVal = Number(m[1]);
            if (Number.isFinite(pctVal) && pctVal > 0 && !corpus.verifiedPercentages.has(pctVal)) {
                return {
                    action: 'silent_abstain',
                    reason: `ungrounded_discount:${m[0].trim()}`,
                    quarantinedText: text,
                    latencyMs: performance.now() - started
                };
            }
        }

        const codeMatches = [...text.matchAll(PROMO_CODE_MENTION_REGEX)];
        for (const m of codeMatches) {
            const code = String(m[1] || '').toUpperCase();
            if (code && !corpus.verifiedCodes.has(code)) {
                return {
                    action: 'silent_abstain',
                    reason: `ungrounded_code:${code}`,
                    quarantinedText: text,
                    latencyMs: performance.now() - started
                };
            }
        }

        const urlMatches = text.match(URL_REGEX) || [];
        for (const rawUrl of urlMatches) {
            const domain = rawUrl.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].replace(/[.,!?;:)\]]+$/, '');
            if (domain && !corpus.verifiedUrls.has(domain)) {
                return {
                    action: 'silent_abstain',
                    reason: `ungrounded_url:${domain}`,
                    quarantinedText: text,
                    latencyMs: performance.now() - started
                };
            }
        }

        const phoneMatches = text.match(PHONE_NUMBER_REGEX) || [];
        for (const rawPhone of phoneMatches) {
            const digits = rawPhone.replace(/\D/g, '');
            if (digits.length >= 10) {
                const last10 = digits.slice(-10);
                const custDigits = String(contactContext?.phoneNumber || '').replace(/\D/g, '');
                const isCustPhone = custDigits && custDigits.includes(last10);
                if (!corpus.verifiedPhones.has(last10) && !isCustPhone) {
                    return {
                        action: 'silent_abstain',
                        reason: `ungrounded_phone:${digits}`,
                        quarantinedText: text,
                        latencyMs: performance.now() - started
                    };
                }
            }
        }
    }

    // 4. Clean AI slop & normalize WhatsApp markdown
    const cleaned = sanitizeWhatsAppSlop(text, { isFollowUp });
    if (!cleaned) {
        return { action: 'no_reply', reason: 'cleaned_empty', latencyMs: performance.now() - started };
    }

    return {
        action: 'pass',
        cleanedText: cleaned,
        latencyMs: performance.now() - started
    };
}
