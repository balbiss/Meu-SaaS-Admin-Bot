import express from "express";
import fetch from "node-fetch";
import path from "path";
import { fileURLToPath } from "url";
import { Telegraf, Markup } from "telegraf";
import QRCode from "qrcode";
import dotenv from "dotenv";
import fs from "fs";
import OpenAI from "openai";
import cors from "cors";
import { createClient } from "@supabase/supabase-js";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json({ limit: "25mb" }));
const PORT = Number(process.env.PORT || 8788);

// Garantir diretório de uploads
const UPLOADS_DIR = path.join(__dirname, "uploads");
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR);
app.use("/uploads", express.static(UPLOADS_DIR));

// -- Configurações Globais (Serviços Compartilhados) --
const DEFAULT_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const WUZAPI_BASE_URL = process.env.WUZAPI_BASE_URL || "http://localhost:8080";
const WUZAPI_ADMIN_TOKEN = process.env.WUZAPI_ADMIN_TOKEN;
const WEBHOOK_BASE = process.env.WEBHOOK_URL || `http://localhost:${PORT}/webhook`;

// -- Supabase Setup (Banco SaaS) --
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

// -- Estado Global do SaaS --
const activeBots = new Map(); // tenant_id -> Telegraf Instance
const SERVER_VERSION = "2.0.0-SAAS";

function log(msg, tenantName = "SYSTEM") {
    const logMsg = `[${tenantName}] ${new Date().toLocaleTimeString()} - ${msg}`;
    console.log(logMsg);
    try { fs.appendFileSync("saas_server.log", logMsg + "\n"); } catch (e) { }
}

// -- Persistence Layer (Multi-Tenant) --
const sessionCache = new Map(); // "tenantId_chatId" -> { data, timestamp }
const CACHE_TTL = 5 * 60 * 1000;

async function getSession(tenantId, chatId) {
    const cacheKey = `${tenantId}_${chatId}`;
    const now = Date.now();

    if (sessionCache.has(cacheKey)) {
        const cached = sessionCache.get(cacheKey);
        if (now - cached.timestamp < CACHE_TTL) return cached.data;
    }

    const { data, error } = await supabase
        .from('bot_sessions')
        .select('data')
        .eq('tenant_id', tenantId)
        .eq('chat_id', String(chatId))
        .single();

    if (error && error.code !== 'PGRST116') {
        log(`DB Error: ${error.message}`, tenantId);
        throw error;
    }

    let sessionObj;
    if (data) {
        sessionObj = data.data;
        // Auto-healing properties
        if (!sessionObj.whatsapp) sessionObj.whatsapp = { instances: [], maxInstances: 1 };
        if (!sessionObj.stage) sessionObj.stage = "READY";
    } else {
        sessionObj = {
            stage: "START",
            isVip: false,
            whatsapp: { instances: [], maxInstances: 1 },
            reports: {}
        };
        await saveSession(tenantId, chatId, sessionObj);
    }

    sessionCache.set(cacheKey, { data: sessionObj, timestamp: now });
    return sessionObj;
}

async function saveSession(tenantId, chatId, sessionData) {
    const cacheKey = `${tenantId}_${chatId}`;
    sessionCache.set(cacheKey, { data: sessionData, timestamp: Date.now() });

    await supabase
        .from('bot_sessions')
        .upsert({
            tenant_id: tenantId,
            chat_id: String(chatId),
            data: sessionData,
            updated_at: new Date().toISOString()
        }, { onConflict: 'tenant_id,chat_id' });
}

// -- SaaS Bot Factory --
async function startTenantBot(tenant) {
    if (activeBots.has(tenant.id)) {
        log(`Bot já está rodando. Reiniciando...`, tenant.name);
        try { activeBots.get(tenant.id).stop(); } catch (e) { }
    }

    log(`Iniciando Bot...`, tenant.name);

    const bot = new Telegraf(tenant.telegram_token);

    // Inject Tenant Context Middleware
    bot.use(async (ctx, next) => {
        ctx.tenant = tenant;

        // -- VALIDAÇÃO DE VENCIMENTO --
        if (tenant.expiration_date) {
            const now = new Date();
            const expiration = new Date(tenant.expiration_date);

            // Se venceu e não é o dono (dono sempre acessa para configurar)
            if (now > expiration && String(ctx.chat.id) !== tenant.owner_chat_id) {
                return ctx.reply("🚫 <b>Seu plano venceu!</b>\nEntre em contato com o suporte para renovar.", { parse_mode: "HTML" });
            }
        }

        ctx.session = await getSession(tenant.id, ctx.chat.id);

        ctx.save = async () => {
            await saveSession(tenant.id, ctx.chat.id, ctx.session); // Save session state
        };

        return next();
    });

    // ... (Owner Dashboard code remains same) ...

    // --- (Rest of startTenantBot remains same) ---
}

// -- Loaders --
async function loadTenants() {
    log("Carregando Tenants...", "SYSTEM");
    const { data: tenants, error } = await supabase
        .from('tenants')
        .select('*') // Agora já traz expiration_date
        .eq('is_active', true);

    if (error) {
        log(`Erro fatal ao carregar tenants: ${error.message}`, "SYSTEM");
        return;
    }

    if (!tenants || tenants.length === 0) {
        log("Nenhum tenant ativo encontrado.", "SYSTEM");
        return;
    }

    for (const tenant of tenants) {
        startTenantBot(tenant);
    }
}

// -- Super Admin API (Para você criar clientes) --
app.post("/admin/create-tenant", async (req, res) => {
    const { name, telegram_token, syncpay_id, syncpay_secret } = req.body;

    // Calcula data de vcto (30 dias padrão)
    const expirationDate = new Date();
    expirationDate.setDate(expirationDate.getDate() + 30);

    const { data, error } = await supabase.from('tenants').insert({
        name,
        telegram_token,
        syncpay_client_id: syncpay_id,
        syncpay_client_secret: syncpay_secret,
        is_active: true,
        expiration_date: expirationDate
    }).select().single();

    if (error) return res.status(400).json({ error: error.message });

    startTenantBot(data);
    return res.json({ success: true, tenant: data });
});

// -- MASTER ADMIN BOT (Gerenciador do SaaS) --
const MASTER_TOKEN = process.env.MASTER_BOT_TOKEN;
const MASTER_ADMIN_ID = process.env.MASTER_ADMIN_ID;

if (MASTER_TOKEN) {
    const masterBot = new Telegraf(MASTER_TOKEN);

    // Middleware de Segurança ... (mantém igual) ...
    masterBot.use((ctx, next) => {
        if (ctx.message?.text === '/meu_id') return next();
        if (!MASTER_ADMIN_ID) return ctx.reply("⚠️ ADMIN_ID não configurado.");
        if (String(ctx.chat.id) !== String(MASTER_ADMIN_ID)) return;
        return next();
    });

    const masterSessions = new Map();

    masterBot.command("start", (ctx) => {
        ctx.reply(
            "👑 <b>Painel Master SaaS</b>\n\n" +
            "👤 /novo_cliente - Criar Tenant\n" +
            "📋 /clientes - Listar e Ver Vencimentos\n" +
            "📅 /renovar [ID] [Dias] - Renovar Assinatura\n" +
            "🚫 /bloquear [ID] - Bloquear Acesso",
            { parse_mode: "HTML" }
        );
    });

    masterBot.command("meu_id", (ctx) => {
        ctx.reply(`🆔 Seu ID: <code>${ctx.chat.id}</code>`, { parse_mode: "HTML" });
    });

    // LISTAR CLIENTES
    masterBot.command("clientes", async (ctx) => {
        const { data: tenants } = await supabase.from('tenants').select('*').order('id');

        if (!tenants || tenants.length === 0) return ctx.reply("Nenhum cliente encontrado.");

        let msg = "📋 <b>Lista de Clientes:</b>\n\n";
        tenants.forEach(t => {
            const status = t.is_active ? "✅" : "🚫";
            const vcto = t.expiration_date ? new Date(t.expiration_date).toLocaleDateString('pt-BR') : "Sem data";
            msg += `${status} <b>${t.name}</b> (ID: ${t.id})\n📅 Vence: ${vcto}\n\n`;
        });
        ctx.reply(msg, { parse_mode: "HTML" });
    });

    // RENOVAR ASSINATURA
    masterBot.command("renovar", async (ctx) => {
        const args = ctx.message.text.split(" ");
        const id = args[1];
        const days = parseInt(args[2]);

        if (!id || !days) return ctx.reply("Use: /renovar [ID] [Dias]\nEx: /renovar 1 30");

        // Pega data atual do tenant ou hoje
        const { data: tenant } = await supabase.from('tenants').select('expiration_date, name').eq('id', id).single();
        if (!tenant) return ctx.reply("Cliente não encontrado.");

        let newDate = new Date(tenant.expiration_date || Date.now());
        // Se já venceu, renova a partir de HOJE. Se não venceu, soma na data atual.
        if (newDate < new Date()) newDate = new Date();

        newDate.setDate(newDate.getDate() + days);

        await supabase.from('tenants').update({ expiration_date: newDate, is_active: true }).eq('id', id);

        ctx.reply(`✅ Cliente <b>${tenant.name}</b> renovado por +${days} dias.\nNovo vencimento: ${newDate.toLocaleDateString('pt-BR')}`, { parse_mode: "HTML" });

        // Recarregar tenants (para aplicar a nova data na memória)
        loadTenants();
    });

    // BLOQUEAR
    masterBot.command("bloquear", async (ctx) => {
        const id = ctx.message.text.split(" ")[1];
        if (!id) return ctx.reply("Use: /bloquear [ID]");

        await supabase.from('tenants').update({ is_active: false }).eq('id', id);
        ctx.reply(`🚫 Cliente ID ${id} bloqueado.`);

        // Parar bot do cliente
        if (activeBots.has(parseInt(id))) {
            activeBots.get(parseInt(id)).stop();
            activeBots.delete(parseInt(id));
        }
    });

    masterBot.command("novo_cliente", (ctx) => {
        masterSessions.set(ctx.chat.id, { stage: "WAIT_NAME", data: {} });
        ctx.reply("📝 Novo Cliente\n\nQual o Nome do cliente/empresa?");
    });

    masterBot.on("text", async (ctx) => {
        const session = masterSessions.get(ctx.chat.id);
        if (!session) return;

        if (session.stage === "WAIT_NAME") {
            session.data.name = ctx.message.text.trim();
            session.stage = "WAIT_TOKEN";
            return ctx.reply("🤖 Qual o Token do Bot dele?");
        }

        if (session.stage === "WAIT_TOKEN") {
            const token = ctx.message.text.trim();
            if (!token.includes(":")) return ctx.reply("❌ Token inválido.");
            session.data.telegram_token = token;
            session.stage = "WAIT_OWNER_ID";
            return ctx.reply("👤 Qual o Telegram ID do Dono?");
        }

        if (session.stage === "WAIT_OWNER_ID") {
            session.data.owner_chat_id = ctx.message.text.trim();
            ctx.reply("⏳ Criando...");

            const expirationDate = new Date();
            expirationDate.setDate(expirationDate.getDate() + 30); // 30 dias grátis

            const { data, error } = await supabase.from('tenants').insert({
                name: session.data.name,
                telegram_token: session.data.telegram_token,
                owner_chat_id: session.data.owner_chat_id,
                is_active: true,
                expiration_date: expirationDate
            }).select().single();

            if (error) {
                masterSessions.delete(ctx.chat.id);
                return ctx.reply(`Erro: ${error.message}`);
            }

            startTenantBot(data);
            masterSessions.delete(ctx.chat.id);
            return ctx.reply(`✅ Criado! Vence em: ${expirationDate.toLocaleDateString('pt-BR')}`);
        }
    });

    masterBot.launch().then(() => log("👑 Master Bot Online!", "SYSTEM"));
}

// -- Startup --
app.listen(PORT, "0.0.0.0", () => {
    log(`SaaS Server rodando em: http://0.0.0.0:${PORT}`, "SYSTEM");
    loadTenants();
});

// Graceful Stop
process.once('SIGINT', () => {
    activeBots.forEach((bot) => bot.stop('SIGINT'));
});
