import 'dotenv/config';

export const CONFIG = {
    PORT: Number(process.env.PORT || 3000),
    NODE_ENV: process.env.NODE_ENV || 'development',
    ADMIN_SECRET: process.env.ADMIN_SECRET || '',
    AUTH_SECRET_ENV: process.env.AUTH_SECRET || '',
    BOT_API_SECRET: process.env.BOT_API_SECRET || '',

    MONGODB_URI: process.env.MONGODB_URI || '',
    MONGODB_DB_NAME: process.env.MONGODB_DB_NAME || 'whatsapp_bot',

    GEMINI_API_KEY: process.env.GEMINI_API_KEY || '',
    OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY || '',
    OPENROUTER_MODEL: process.env.OPENROUTER_MODEL || 'openrouter/free',
    GROQ_API_KEY: process.env.GROQ_API_KEY || '',

    MAX_ACTIVE_WA_SESSIONS: Math.max(1, Number(process.env.MAX_ACTIVE_WA_SESSIONS || 5)),
    DEFAULT_CORE_PROMPT:
        process.env.SYSTEM_PROMPT ||
        'Reply naturally like a knowledgeable team member helping customers directly on WhatsApp.'
};

// Strict Knowledge & Token Caps (Prevents hallucination & protects free LLM quotas)
export const BRAIN_LIMITS = {
    maxOffers: 8,
    maxProducts: 30,
    maxFaqs: 25,
    maxRules: 10,
    maxQuickReplies: 12,
    maxAnnouncementChars: 350,
    maxDigestChars: 1600,
    maxAgencyPromptChars: 2000,
    maxTotalSystemChars: 3800
};

// Verified 2026 model fallback chain
export const GEMINI_MODELS = [
    'gemini-3.8-flash',
    'gemini-3.5-flash-lite',
    'gemini-3.1-flash-lite'
];

export const GROQ_MODELS = [
    'openai/gpt-oss-120b',
    'openai/gpt-oss-20b',
    'qwen/qwen3.8-27b'
];

export const WARMUP_PRESETS = {
    new: { label: 'New Number (Days 1-7)', maxDailyOut: 25, maxHourlyOut: 6 },
    warming: { label: 'Warming (Days 8-21)', maxDailyOut: 90, maxHourlyOut: 18 },
    aged: { label: 'Aged Business (30+ Days)', maxDailyOut: 220, maxHourlyOut: 30 }
};

export const ADMIN_PROMPT_TEMPLATES = {
    sales_concierge: {
        label: 'Sales & Service Concierge',
        industry: 'Service & Retail Business',
        prompt: 'You handle WhatsApp customer inquiries for this business. Answer questions fast, quote exact prices/offers, clarify what the buyer needs, and invite them to confirm their booking or order.'
    },
    clinic: {
        label: 'Clinic / Doctor / Dental Desk',
        industry: 'Healthcare & Clinic',
        prompt: 'You handle WhatsApp front-desk inquiries for our clinic. Help with consultation fees, timings, doctor availability, and location. Never give medical diagnoses or prescriptions; escalate symptoms or urgent requests to staff.'
    },
    ecommerce: {
        label: 'Store / D2C / Clothing',
        industry: 'E-commerce & Retail Store',
        prompt: 'You handle store DMs on WhatsApp. Share exact product prices, active discounts, delivery timelines, and ordering instructions. Escalate custom bulk orders, damaged returns, or refund requests to our team.'
    },
    real_estate: {
        label: 'Real Estate / Property Desk',
        industry: 'Real Estate',
        prompt: 'You qualify property inquiries on WhatsApp. Share verified project specs and pricing ranges, ask for preferred budget/configuration/move-in timeline naturally, and offer a site visit slot.'
    },
    salon_gym: {
        label: 'Salon / Fitness Studio',
        industry: 'Salon & Fitness',
        prompt: 'You manage bookings and membership queries on WhatsApp. Highlight current package deals, share session/membership rates accurately, and ask which day/time suits them to reserve a slot.'
    }
};

export function createDefaultTenantConfig(
    businessName = 'Workspace',
    {
        industry = 'Service & Retail Business',
        agencySystemPrompt = '',
        aiConfig = {}
    } = {}
) {
    return {
        industry: String(industry || 'Service & Retail Business').trim().slice(0, 80),
        agencySystemPrompt:
            String(agencySystemPrompt || '').trim().slice(0, BRAIN_LIMITS.maxAgencyPromptChars) ||
            `You handle WhatsApp customer inquiries for ${businessName} (${industry}). Help customers quickly, verify requirements politely, and guide serious buyers toward booking.`,
        aiConfig: {
            primaryModel: String(aiConfig.primaryModel || 'auto'),
            temperature: Number.isFinite(Number(aiConfig.temperature))
                ? Math.min(0.75, Math.max(0.1, Number(aiConfig.temperature)))
                : 0.42,
            maxOutputTokens: Number.isFinite(Number(aiConfig.maxOutputTokens))
                ? Math.min(750, Math.max(180, Number(aiConfig.maxOutputTokens)))
                : 460,
            allowClientBrainEdit: aiConfig.allowClientBrainEdit !== false
        },
        botConfig: {
            businessName,
            city: '',
            currency: 'INR',
            language: 'Auto (Match Customer)',
            tone: 'Natural & Helpful',
            emojiLevel: 'minimal',
            announcement: '',
            offers: [],
            products: [
                { name: 'Starter Consultation', price: '499', note: '30 min 1-on-1 discovery call', active: true }
            ],
            faqs: [
                {
                    q: 'What are your working hours?',
                    a: 'Monday to Saturday, 10 AM to 7 PM.'
                }
            ],
            customRules: [
                'Quote prices strictly from active catalog and offers only.'
            ],
            compiledDigest: '',
            compressedByAi: false,
            leadFields: ['name', 'intent', 'budget']
        },
        safety: {
            aiEnabled: true,
            warmupTier: 'warming',
            maxDailyOut: 90,
            maxHourlyOut: 18,
            perUser10m: 6,
            perUser24h: 25,
            takeoverMinutes: 30,
            debounceMs: 1800,
            groupMode: 'ignore_all',
            operatingMode: 'always',
            timezone: 'Asia/Kolkata',
            workHours: {
                mon: { open: '09:30', close: '19:30', enabled: true },
                tue: { open: '09:30', close: '19:30', enabled: true },
                wed: { open: '09:30', close: '19:30', enabled: true },
                thu: { open: '09:30', close: '19:30', enabled: true },
                fri: { open: '09:30', close: '19:30', enabled: true },
                sat: { open: '10:00', close: '18:00', enabled: true },
                sun: { open: '10:00', close: '14:00', enabled: false }
            },
            awayMessage: 'Hey! Thanks for messaging us — we are closed right now and will get back to you as soon as we open.',
            sendAwayMessage: false,
            readReceipts: true,
            quoteReplies: true,
            splitLongReplies: false,
            voiceNotesEnabled: true,
            imageVisionEnabled: true,
            optOutKeywords: ['stop', 'stopall', 'unsubscribe', 'cancel', 'optout', 'opt out'],
            webhookUrl: ''
        },
        blacklist: [],
        whitelist: [],
        quickReplies: [
            { id: 'qr_price', title: 'Send Price Summary', body: 'Here is our updated pricing list — let me know which option suits you best.' },
            { id: 'qr_callback', title: 'Schedule Callback', body: 'Sure! What time works best today or tomorrow for a quick call?' },
            { id: 'qr_thanks', title: 'Human Follow-up', body: 'Got your details, our team is checking on this and will reply shortly.' }
        ]
    };
}
