import { GoogleGenAI } from '@google/genai';
import { CONFIG, GEMINI_MODELS, GROQ_MODELS } from './config.mjs';

const geminiClient = CONFIG.GEMINI_API_KEY ? new GoogleGenAI({ apiKey: CONFIG.GEMINI_API_KEY }) : null;

export function getProviderAvailability() {
    return {
        gemini: Boolean(geminiClient),
        openrouter: Boolean(CONFIG.OPENROUTER_API_KEY),
        groq: Boolean(CONFIG.GROQ_API_KEY)
    };
}

/**
 * Compiles structured Business Brain settings into a tight, zero-hallucination system prompt.
 */
export function buildTenantSystemPrompt(tenant, contactContext = null) {
    const cfg = tenant?.botConfig || {};
    const lines = [];

    const bizName = cfg.businessName || tenant?.name || 'our business';
    lines.push(`You are the official WhatsApp AI assistant for *${bizName}*${cfg.city ? ` (${cfg.city})` : ''}.`);
    if (cfg.industry) lines.push(`Business focus: ${cfg.industry}.`);
    lines.push(`Tone: ${cfg.tone || 'Warm & Professional'}. Language style: ${cfg.language || 'Auto (Match Customer)'}.`);

    const emojiPolicy = cfg.emojiLevel === 'none'
        ? 'Do NOT use any emojis.'
        : cfg.emojiLevel === 'natural'
            ? 'Use light, natural emojis sparingly where appropriate.'
            : 'Avoid emojis or use at most 1 when genuinely appropriate.';
    lines.push(emojiPolicy);

    lines.push('WhatsApp Formatting: Keep replies crisp, human, and concise (1-4 short lines unless answering detailed pricing questions). Use *bold* for emphasis, never markdown hashtags (#) or double asterisks (**).');

    const activeProducts = (cfg.products || []).filter((p) => p && p.active !== false && p.name);
    if (activeProducts.length > 0) {
        lines.push('\nSERVICES & PRICING CATALOG (Quote strictly from this list, never invent prices):');
        for (const p of activeProducts.slice(0, 30)) {
            lines.push(`- ${p.name}: ${cfg.currency || 'INR'} ${p.price || 'Custom'}${p.note ? ` — ${p.note}` : ''}`);
        }
    }

    const faqs = (cfg.faqs || []).filter((f) => f && f.q && f.a);
    if (faqs.length > 0) {
        lines.push('\nFREQUENTLY ASKED QUESTIONS:');
        for (const f of faqs.slice(0, 25)) {
            lines.push(`Q: ${f.q}\nA: ${f.a}`);
        }
    }

    const rules = (cfg.customRules || []).filter(Boolean);
    if (rules.length > 0) {
        lines.push('\nSTRICT BUSINESS RULES:');
        for (const r of rules.slice(0, 15)) {
            lines.push(`- ${r}`);
        }
    }

    if (cfg.extraInstructions && cfg.extraInstructions.trim()) {
        lines.push(`\nADDITIONAL CONTEXT:\n${cfg.extraInstructions.trim().slice(0, 1800)}`);
    }

    if (contactContext?.displayName || contactContext?.phoneNumber) {
        lines.push(`\nCustomer profile known: Name=${contactContext.displayName || 'Unknown'}, Phone=${contactContext.phoneNumber || 'Unknown'}. Do not redundantly ask for details already known.`);
    }

    lines.push(
        '\nINTERNAL LEAD CAPTURE TAG: If the customer reveals meaningful buying intent, a product request, booking interest, or budget, append ONE compact hidden tag at the very end on a new line: [LEAD: intent="short 3-5 word summary" | budget="amount or empty" | score="hot|warm|cold"]. Only include when relevant.'
    );

    return lines.join('\n');
}

export function formatForWhatsApp(rawText) {
    let text = String(rawText || '').trim();
    text = text.replace(/^#+\s*(.*)$/gm, '*$1*');
    text = text.replace(/\*\*([^*]+)\*\*/g, '*$1*');
    return text.trim();
}

export function extractAndStripLeadTag(rawText) {
    const text = String(rawText || '');
    const regex = /\n?\[LEAD:\s*([^\]]+)\]\s*$/i;
    const match = text.match(regex);
    if (!match) {
        return { cleanText: text.trim(), leadData: null };
    }

    const cleanText = text.replace(regex, '').trim();
    const body = match[1];
    const leadData = {};

    const intentM = body.match(/intent="([^"]*)"/i) || body.match(/intent=([^|\]]*)/i);
    const budgetM = body.match(/budget="([^"]*)"/i) || body.match(/budget=([^|\]]*)/i);
    const scoreM = body.match(/score="?(hot|warm|cold)"?/i);

    if (intentM?.[1]?.trim()) leadData.intent = intentM[1].trim().slice(0, 120);
    if (budgetM?.[1]?.trim()) leadData.budget = budgetM[1].trim().slice(0, 60);
    if (scoreM?.[1]) leadData.score = scoreM[1].toLowerCase();

    return {
        cleanText,
        leadData: Object.keys(leadData).length > 0 ? leadData : null
    };
}

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
 * Generates an AI reply with 3-tier free/fast fallback (Gemini 2026 -> OpenRouter Free -> Groq).
 * Supports ephemeral multimodal Audio (voice notes) & Image attachments without persisting media bytes.
 */
export async function generateAIReply({
    systemPrompt,
    contextTurns = [],
    userText,
    mediaAttachment = null // { type: 'audio'|'image', data: base64, mimeType }
}) {
    const startedAt = Date.now();
    const safeUserText = (userText || '').trim().slice(0, 2000) || (mediaAttachment?.type === 'audio' ? '[Customer sent a voice message]' : '[Customer sent an image]');

    // Trim context turns strictly to last 8 turns to limit token usage & latency
    const recentTurns = contextTurns.slice(-8).map((t) => ({
        role: t.role === 'assistant' ? 'assistant' : 'user',
        text: String(t.text || '').slice(0, 700)
    }));

    // 1. Primary: Google Gemini 2026 Models via @google/genai Interactions API (supports native audio + image!)
    if (geminiClient) {
        const steps = recentTurns.map((t) => ({
            type: t.role === 'assistant' ? 'model_output' : 'user_input',
            content: [{ type: 'text', text: t.text }]
        }));

        const currentParts = [{ type: 'text', text: safeUserText }];
        if (mediaAttachment?.data && mediaAttachment?.mimeType) {
            if (mediaAttachment.type === 'audio') {
                currentParts.push({
                    type: 'audio',
                    data: mediaAttachment.data,
                    mime_type: mediaAttachment.mimeType
                });
            } else if (mediaAttachment.type === 'image') {
                currentParts.push({
                    type: 'image',
                    data: mediaAttachment.data,
                    mime_type: mediaAttachment.mimeType
                });
            }
        }
        steps.push({ type: 'user_input', content: currentParts });

        for (const modelId of GEMINI_MODELS) {
            try {
                const interaction = await Promise.race([
                    geminiClient.interactions.create({
                        model: modelId,
                        system_instruction: systemPrompt,
                        input: steps,
                        store: false,
                        generation_config: { max_output_tokens: 650, temperature: 0.65 }
                    }),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('Gemini timeout (12s)')), 12_000))
                ]);
                const raw = extractInteractionText(interaction);
                if (raw) {
                    const { cleanText, leadData } = extractAndStripLeadTag(raw);
                    return {
                        text: formatForWhatsApp(cleanText),
                        model: modelId,
                        latencyMs: Date.now() - startedAt,
                        leadData
                    };
                }
            } catch (err) {
                console.warn(`[AI Engine] Gemini '${modelId}' fallback:`, err.status || err.message);
                if (err.status === 401 || err.status === 403) break;
            }
        }
    }

    // Text-only fallback prompt if customer sent uncaptioned media when Gemini is unavailable
    const fallbackUserText = mediaAttachment && !userText?.trim()
        ? (mediaAttachment.type === 'audio'
            ? '[The customer sent a voice note that could not be transcribed right now. Politely ask them to share their message in text so you can help right away.]'
            : '[The customer sent an image without caption that could not be inspected right now. Politely ask what details or item they would like help with.]')
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
                    max_tokens: 650,
                    temperature: 0.65
                }),
                signal: controller.signal
            });
            clearTimeout(timer);

            if (resp.ok) {
                const data = await resp.json();
                const raw = data?.choices?.[0]?.message?.content?.trim();
                if (raw) {
                    const { cleanText, leadData } = extractAndStripLeadTag(raw);
                    return {
                        text: formatForWhatsApp(cleanText),
                        model: data.model || CONFIG.OPENROUTER_MODEL,
                        latencyMs: Date.now() - startedAt,
                        leadData
                    };
                }
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
                        max_tokens: 650,
                        temperature: 0.65
                    }),
                    signal: controller.signal
                });
                clearTimeout(timer);

                if (resp.ok) {
                    const data = await resp.json();
                    const raw = data?.choices?.[0]?.message?.content?.trim();
                    if (raw) {
                        const { cleanText, leadData } = extractAndStripLeadTag(raw);
                        return {
                            text: formatForWhatsApp(cleanText),
                            model: modelId,
                            latencyMs: Date.now() - startedAt,
                            leadData
                        };
                    }
                }
                if (resp.status === 401) break;
            } catch {}
        }
    }

    return {
        text: 'Thanks for reaching out. Our assistant is momentarily busy — please send your question again in a moment or wait for our team.',
        model: 'fallback-static',
        latencyMs: Date.now() - startedAt,
        leadData: null,
        isError: true
    };
}
