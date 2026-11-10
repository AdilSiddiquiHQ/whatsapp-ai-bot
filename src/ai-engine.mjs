import { GoogleGenAI } from '@google/genai';
import { BRAIN_LIMITS, CONFIG, GEMINI_MODELS, GROQ_MODELS } from './config.mjs';

const geminiClient = CONFIG.GEMINI_API_KEY ? new GoogleGenAI({ apiKey: CONFIG.GEMINI_API_KEY }) : null;

export function getProviderAvailability() {
    return {
        gemini: Boolean(geminiClient),
        openrouter: Boolean(CONFIG.OPENROUTER_API_KEY),
        groq: Boolean(CONFIG.GROQ_API_KEY)
    };
}

function buildRawCatalogSnapshot(botConfig) {
    const cfg = botConfig || {};
    const parts = [];
    const curr = cfg.currency || 'INR';

    const offers = (cfg.offers || []).filter((o) => o && o.active !== false && o.title);
    if (offers.length > 0) {
        parts.push('ACTIVE OFFERS: ' + offers.map((o) => `${o.title} (${o.deal}${o.code ? `, code: ${o.code}` : ''})`).join('; '));
    }

    if (cfg.announcement && cfg.announcement.trim()) {
        parts.push(`LIVE UPDATE: ${cfg.announcement.trim()}`);
    }

    const prods = (cfg.products || []).filter((p) => p && p.active !== false && p.name);
    if (prods.length > 0) {
        parts.push('CATALOG: ' + prods.map((p) => `${p.name}: ${curr} ${p.price || 'Ask'}${p.note ? ` (${p.note})` : ''}`).join(' | '));
    }

    const faqs = (cfg.faqs || []).filter((f) => f && f.q && f.a);
    if (faqs.length > 0) {
        parts.push('FAQS: ' + faqs.map((f) => `${f.q} -> ${f.a}`).join(' | '));
    }

    const rules = (cfg.customRules || []).filter(Boolean);
    if (rules.length > 0) {
        parts.push('RULES: ' + rules.join('; '));
    }

    return parts.join('\n');
}

/**
 * Rebuilds compressed client knowledge digest cleanly from scratch whenever Business Brain is saved.
 * Guarantees deleted/edited items vanish immediately while Admin's agencySystemPrompt stays untouched!
 */
export async function compileClientKnowledgeDigest(botConfig) {
    const rawSnapshot = buildRawCatalogSnapshot(botConfig);
    if (!rawSnapshot) {
        return { compiledDigest: '', compressedByAi: false };
    }

    // If compact already, keep 100% lossless deterministic version with 0 API calls
    if (rawSnapshot.length <= 1350) {
        return { compiledDigest: rawSnapshot, compressedByAi: false };
    }

    // Large knowledge base (>1350 chars): run a single save-time compression pass via lightweight Flash Lite
    if (geminiClient) {
        try {
            const prompt =
                'Compress these active offers, prices, FAQs, and business rules into dense factual bullet lines under 1450 characters total.\n' +
                'STRICT RULES:\n' +
                '1. Keep EVERY number, price, currency, promo code, day/time, and exclusion 100% exact.\n' +
                '2. Omit filler words; preserve only factual business information.\n' +
                '3. Output ONLY the compressed facts with zero intro or outro.';

            const interaction = await Promise.race([
                geminiClient.interactions.create({
                    model: 'gemini-3.5-flash-lite',
                    system_instruction: prompt,
                    input: [{ type: 'user_input', content: [{ type: 'text', text: rawSnapshot.slice(0, 8000) }] }],
                    store: false,
                    generation_config: { max_output_tokens: 450, temperature: 0.1 }
                }),
                new Promise((_, reject) => setTimeout(() => reject(new Error('Digest timeout')), 10_000))
            ]);
            const compressed = extractInteractionText(interaction);
            if (compressed && compressed.length > 40 && compressed.length <= BRAIN_LIMITS.maxDigestChars + 100) {
                return {
                    compiledDigest: compressed.slice(0, BRAIN_LIMITS.maxDigestChars),
                    compressedByAi: true
                };
            }
        } catch (err) {
            console.warn('[Brain Digest Fallback]:', err.message);
        }
    }

    // Deterministic clean truncation fallback
    return {
        compiledDigest: rawSnapshot.slice(0, BRAIN_LIMITS.maxDigestChars),
        compressedByAi: false
    };
}

function selectRelevantItems(queryText, items, maxCount, formatter) {
    if (!items || !items.length) return [];
    const tokens = String(queryText || '')
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length >= 3);

    if (!tokens.length) return items.slice(0, maxCount).map(formatter);

    const scored = items.map((item) => {
        const txt = formatter(item).toLowerCase();
        let score = 0;
        for (const tok of tokens) {
            if (txt.includes(tok)) score += tok.length;
        }
        return { item, score };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, maxCount).map((s) => formatter(s.item));
}

export function estimateKnowledgeBudget(tenantOrConfig) {
    const cfg = tenantOrConfig?.botConfig || tenantOrConfig || {};
    const digestLen = (cfg.compiledDigest || buildRawCatalogSnapshot(cfg)).length;
    const agencyLen = (tenantOrConfig?.agencySystemPrompt || '').length;
    const totalUsedChars = Math.min(BRAIN_LIMITS.maxTotalSystemChars, digestLen + agencyLen + 750);
    return {
        digestChars: digestLen,
        maxDigestChars: BRAIN_LIMITS.maxDigestChars,
        estimatedTokens: Math.ceil(totalUsedChars / 4),
        maxTokens: Math.ceil(BRAIN_LIMITS.maxTotalSystemChars / 4),
        compressedByAi: Boolean(cfg.compressedByAi),
        counts: {
            offers: (cfg.offers || []).length,
            products: (cfg.products || []).length,
            faqs: (cfg.faqs || []).length,
            rules: (cfg.customRules || []).length
        }
    };
}

/**
 * Compiles strict anti-hallucination + human WhatsApp persona + Admin System Prompt +
 * active Offers + query-matched items + bounded Digest (keeps prompt tight <= ~850 tokens!).
 */
export function buildTenantSystemPrompt(tenant, contactContext = null, customerQuery = '') {
    const cfg = tenant?.botConfig || {};
    const bizName = cfg.businessName || tenant?.name || 'our business';
    const industry = tenant?.industry || cfg.industry || '';
    const curr = cfg.currency || 'INR';

    const sections = [];

    // 1. Admin's Custom Core System Prompt (immutable to client; fallback preserves legacy extraInstructions!)
    const adminPrompt =
        (tenant?.agencySystemPrompt || '').trim() ||
        (cfg?.extraInstructions || '').trim() ||
        `You work on the customer desk for ${bizName}${industry ? ` (${industry})` : ''}.`;
    sections.push(`AGENCY ROLE & INSTRUCTIONS:\n${adminPrompt.slice(0, BRAIN_LIMITS.maxAgencyPromptChars)}`);

    // 2. Realistic Human WhatsApp Voice & Strict Grounding Protocol
    const emojiRule = cfg.emojiLevel === 'none'
        ? 'Never use emojis.'
        : cfg.emojiLevel === 'natural'
            ? 'Use light natural emojis sparingly only if appropriate.'
            : 'Use zero emojis (or at most 1 subtle emoji if natural).';

    sections.push(
        `HOW YOU TEXT ON WHATSAPP (CRITICAL):\n` +
        `- Sound like a real human staff member texting from the business phone — NOT an AI chatbot.\n` +
        `- Tone: ${cfg.tone || 'Natural & Helpful'}. Language: ${cfg.language || 'Auto (Match Customer)'}${cfg.city ? `. Location: ${cfg.city}` : ''}. ${emojiRule}\n` +
        `- BANNED ROBOTIC PHRASES: NEVER say "Certainly!", "I'd be happy to help", "Great question!", "Feel free to reach out", "As an AI", or write numbered essay lists.\n` +
        `- Keep messages brief (1-3 crisp lines). Answer the question first, use plain contractions ("we're", "you'll"), and *bold* only key prices/names.\n\n` +
        `STRICT ZERO-HALLUCINATION RULE:\n` +
        `- ONLY state facts, prices, offers, timings, links, and policies written in VERIFIED BUSINESS DATA below.\n` +
        `- NEVER guess, invent, estimate, or use outside knowledge if a detail is missing.\n` +
        `- If the customer asks anything NOT covered below (or asks for special discounts, custom complaints, or refunds), reply naturally in 1 short sentence like "Let me quickly check with our team and confirm back for you" and append [HANDOFF: reason="needs_team"] on a new line at the end.`
    );

    // 3. Verified Business Knowledge (strictly bounded under ~3400 chars total)
    const knowledgeParts = [];

    const activeOffers = (cfg.offers || []).filter((o) => o && o.active !== false && o.title);
    if (activeOffers.length > 0) {
        knowledgeParts.push('LIVE OFFERS: ' + activeOffers.map((o) => `*${o.title}*: ${o.deal}${o.code ? ` (Code: ${o.code})` : ''}`).join(' | '));
    }

    if (cfg.announcement && cfg.announcement.trim()) {
        knowledgeParts.push(`IMPORTANT UPDATE: ${cfg.announcement.trim()}`);
    }

    const activeProds = (cfg.products || []).filter((p) => p && p.active !== false && p.name);
    const activeFaqs = (cfg.faqs || []).filter((f) => f && f.q && f.a);

    if (cfg.compiledDigest && cfg.compressedByAi) {
        // Inject top exact query matches verbatim + compressed digest for everything else
        const matchedProds = selectRelevantItems(customerQuery, activeProds, 6, (p) => `${p.name} (${curr} ${p.price}${p.note ? `, ${p.note}` : ''})`);
        const matchedFaqs = selectRelevantItems(customerQuery, activeFaqs, 4, (f) => `Q: ${f.q} A: ${f.a}`);
        if (matchedProds.length) knowledgeParts.push(`KEY MATCHED ITEMS: ${matchedProds.join(' | ')}`);
        if (matchedFaqs.length) knowledgeParts.push(`KEY FAQS: ${matchedFaqs.join(' | ')}`);
        knowledgeParts.push(`FULL KNOWLEDGE SUMMARY:\n${cfg.compiledDigest}`);
    } else {
        const snapshot = cfg.compiledDigest || buildRawCatalogSnapshot(cfg);
        if (snapshot) knowledgeParts.push(snapshot);
    }

    if (knowledgeParts.length > 0) {
        sections.push(`VERIFIED BUSINESS DATA (Currency: ${curr}):\n${knowledgeParts.join('\n').slice(0, 1900)}`);
    } else {
        sections.push('VERIFIED BUSINESS DATA: No prices or catalog items added yet. If asked about prices/services, politely tell them you will check with the team and emit [HANDOFF: reason="empty_catalog"].');
    }

    if (contactContext?.displayName || contactContext?.phoneNumber) {
        sections.push(`CUSTOMER: ${contactContext.displayName || 'Customer'} (${contactContext.phoneNumber || ''}). Never ask for details already known.`);
    }

    sections.push(
        `SILENT LEAD TAG: Only if the customer shows buying intent, asks price to buy, or requests booking, append on the last line: [LEAD: intent="3-5 words" | budget="amount or empty" | score="hot|warm|cold"]`
    );

    return sections.join('\n\n').slice(0, BRAIN_LIMITS.maxTotalSystemChars + 1200);
}

export function formatForWhatsApp(rawText) {
    let text = String(rawText || '').trim();
    text = text.replace(/^#+\s*(.*)$/gm, '*$1*');
    text = text.replace(/\*\*([^*]+)\*\*/g, '*$1*');
    return text.trim();
}

export function extractAndStripTags(rawText) {
    let cleanText = String(rawText || '');
    let leadData = null;
    let handoffData = null;

    const leadRegex = /\n?\[LEAD:\s*([^\]]+)\]/i;
    const leadMatch = cleanText.match(leadRegex);
    if (leadMatch) {
        cleanText = cleanText.replace(leadRegex, '');
        const body = leadMatch[1];
        const parsed = {};
        const intentM = body.match(/intent="([^"]*)"/i) || body.match(/intent=([^|\]]*)/i);
        const budgetM = body.match(/budget="([^"]*)"/i) || body.match(/budget=([^|\]]*)/i);
        const scoreM = body.match(/score="?(hot|warm|cold)"?/i);
        if (intentM?.[1]?.trim()) parsed.intent = intentM[1].trim().slice(0, 120);
        if (budgetM?.[1]?.trim()) parsed.budget = budgetM[1].trim().slice(0, 60);
        if (scoreM?.[1]) parsed.score = scoreM[1].toLowerCase();
        if (Object.keys(parsed).length > 0) leadData = parsed;
    }

    const handoffRegex = /\n?\[HANDOFF(?::\s*([^\]]+))?\]/i;
    const handoffMatch = cleanText.match(handoffRegex);
    if (handoffMatch) {
        cleanText = cleanText.replace(handoffRegex, '');
        const body = handoffMatch[1] || '';
        const reasonM = body.match(/reason="([^"]*)"/i) || body.match(/reason=([^|\]]*)/i);
        handoffData = {
            reason: (reasonM?.[1] || 'needs_team').trim().slice(0, 80)
        };
    }

    return {
        cleanText: cleanText.trim(),
        leadData,
        handoffData
    };
}

// Keep alias export for backwards test compatibility if needed
export const extractAndStripLeadTag = extractAndStripTags;

function extractInteractionText(interaction) {
    if (interaction?.output_text && typeof interaction.output_text === 'string') {
        return interaction.output_text.trim();
    }
    if (Array.isArray(interaction?.outputs)) {
        const joined = interaction.outputs
            .map((o) => o?.text || o?.content?.map?.((c) => c?.text || '').join('') || '')
            .join('\n')
            .trim();
        if (joined) return joined;
    }
    return '';
}

/**
 * Generates an AI reply with 3-tier fallback (Gemini 2026 -> OpenRouter Free -> Groq)
 * at low temperature (0.45) to keep replies realistic & strictly grounded.
 */
export async function generateAIReply({
    systemPrompt,
    contextTurns = [],
    userText,
    mediaAttachment = null,
    aiConfig = null
}) {
    const startedAt = Date.now();
    const safeUserText = (userText || '').trim().slice(0, 2000) || (mediaAttachment?.type === 'audio' ? '[Customer sent a voice message]' : '[Customer sent an image]');
    const temp = Number.isFinite(Number(aiConfig?.temperature))
        ? Math.min(0.75, Math.max(0.1, Number(aiConfig.temperature)))
        : 0.42;
    const maxTokens = Number.isFinite(Number(aiConfig?.maxOutputTokens))
        ? Math.min(750, Math.max(180, Number(aiConfig.maxOutputTokens)))
        : 460;
    const preferred = String(aiConfig?.primaryModel || 'auto');

    const orderedGeminiModels = GEMINI_MODELS.includes(preferred)
        ? [preferred, ...GEMINI_MODELS.filter((m) => m !== preferred)]
        : GEMINI_MODELS;

    const recentTurns = contextTurns.slice(-8).map((t) => ({
        role: t.role === 'assistant' ? 'assistant' : 'user',
        text: String(t.text || '').slice(0, 700)
    }));

    const finalize = (raw, model) => {
        const { cleanText, leadData, handoffData } = extractAndStripTags(raw);
        return {
            text: formatForWhatsApp(cleanText),
            model,
            latencyMs: Date.now() - startedAt,
            leadData,
            handoffData
        };
    };

    // 1. Primary: Google Gemini 2026 Models via Interactions API (unless explicitly pinned to OpenRouter)
    if (geminiClient && preferred !== 'openrouter') {
        const steps = recentTurns.map((t) => ({
            type: t.role === 'assistant' ? 'model_output' : 'user_input',
            content: [{ type: 'text', text: t.text }]
        }));

        const currentParts = [{ type: 'text', text: safeUserText }];
        if (mediaAttachment?.data && mediaAttachment?.mimeType) {
            if (mediaAttachment.type === 'audio') {
                currentParts.push({ type: 'audio', data: mediaAttachment.data, mime_type: mediaAttachment.mimeType });
            } else if (mediaAttachment.type === 'image') {
                currentParts.push({ type: 'image', data: mediaAttachment.data, mime_type: mediaAttachment.mimeType });
            }
        }
        steps.push({ type: 'user_input', content: currentParts });

        for (const modelId of orderedGeminiModels) {
            try {
                const interaction = await Promise.race([
                    geminiClient.interactions.create({
                        model: modelId,
                        system_instruction: systemPrompt,
                        input: steps,
                        store: false,
                        generation_config: { max_output_tokens: maxTokens, temperature: temp }
                    }),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('Gemini timeout (12s)')), 12_000))
                ]);
                const raw = extractInteractionText(interaction);
                if (raw) return finalize(raw, modelId);
            } catch (err) {
                console.warn(`[AI Engine] Gemini '${modelId}' fallback:`, err.status || err.message);
                if (err.status === 401 || err.status === 403) break;
            }
        }
    }

    const fallbackUserText = mediaAttachment && !userText?.trim()
        ? (mediaAttachment.type === 'audio'
            ? '[Customer sent a voice note. Ask them briefly to type their message so you can help right away.]'
            : '[Customer sent a photo without caption. Ask briefly what item or detail they need help with.]')
        : safeUserText;

    const chatMessages = [
        { role: 'system', content: systemPrompt },
        ...recentTurns.map((t) => ({ role: t.role, content: t.text })),
        { role: 'user', content: fallbackUserText }
    ];

    // 2. Secondary: OpenRouter Auto-Free Router
    if (CONFIG.OPENROUTER_API_KEY) {
        try {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 14_000);
            const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${CONFIG.OPENROUTER_API_KEY}`,
                    'HTTP-Referer': 'https://localhost',
                    'X-Title': 'WhatsApp AI Portal'
                },
                body: JSON.stringify({
                    model: CONFIG.OPENROUTER_MODEL,
                    messages: chatMessages,
                    max_tokens: maxTokens,
                    temperature: temp
                }),
                signal: controller.signal
            });
            clearTimeout(timer);

            if (resp.ok) {
                const data = await resp.json();
                const raw = data?.choices?.[0]?.message?.content?.trim();
                if (raw) return finalize(raw, data.model || CONFIG.OPENROUTER_MODEL);
            }
        } catch (err) {
            console.warn('[AI Engine] OpenRouter fallback error:', err.message);
        }
    }

    // 3. Tertiary: Groq
    if (CONFIG.GROQ_API_KEY) {
        for (const modelId of GROQ_MODELS) {
            try {
                const controller = new AbortController();
                const timer = setTimeout(() => controller.abort(), 12_000);
                const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${CONFIG.GROQ_API_KEY}`
                    },
                    body: JSON.stringify({
                        model: modelId,
                        messages: chatMessages,
                        max_tokens: maxTokens,
                        temperature: temp
                    }),
                    signal: controller.signal
                });
                clearTimeout(timer);

                if (resp.ok) {
                    const data = await resp.json();
                    const raw = data?.choices?.[0]?.message?.content?.trim();
                    if (raw) return finalize(raw, modelId);
                }
                if (resp.status === 401) break;
            } catch {}
        }
    }

    return {
        text: 'Let me check with our team and get back to you shortly.',
        model: 'fallback-handoff',
        latencyMs: Date.now() - startedAt,
        leadData: null,
        handoffData: { reason: 'provider_unavailable' },
        isError: true
    };
}
