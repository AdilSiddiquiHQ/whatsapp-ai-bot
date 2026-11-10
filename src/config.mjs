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
        'You are a helpful, trustworthy customer assistant replying via WhatsApp. Be concise, accurate, natural, and polite. Use clean WhatsApp formatting (*bold*, _italic_, bullet lists) and never use markdown headings (#).'
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

export function createDefaultTenantConfig(businessName = 'Workspace') {
    return {
        botConfig: {
            businessName,
            industry: 'Service & Retail Business',
            city: '',
            currency: 'INR',
            language: 'Auto (Match Customer)',
            tone: 'Warm & Professional',
            emojiLevel: 'minimal',
            welcomeHint: '',
            products: [
                { name: 'Starter Consultation', price: '499', note: '30 min 1-on-1 discovery call', active: true }
            ],
            faqs: [
                {
                    q: 'What are your working hours?',
                    a: 'Our team is available Monday to Saturday, 10 AM to 7 PM.'
                }
            ],
            customRules: [
                'Always quote prices strictly from the service catalog above.',
                'Never promise discounts without team confirmation.'
            ],
            leadFields: ['name', 'intent', 'budget'],
            extraInstructions: ''
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
            groupMode: 'ignore_all', // ignore_all | mentions_only
            operatingMode: 'always', // always | business_hours | after_hours_only
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
            awayMessage: 'Thanks for messaging us. Our team is currently offline and will respond as soon as we open.',
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
            { id: 'qr_price', title: 'Send Price Summary', body: 'Here is our updated service & pricing list. Let me know which option fits best.' },
            { id: 'qr_callback', title: 'Schedule Callback', body: 'Got it — could you share a preferred time today or tomorrow for our team to call you back?' },
            { id: 'qr_thanks', title: 'Thank & Handover', body: 'Thanks for sharing those details. One of our team specialists is reviewing this now.' }
        ]
    };
}
