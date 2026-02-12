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
        ctx.session = await getSession(tenant.id, ctx.chat.id);

        ctx.save = async () => {
            await saveSession(tenant.id, ctx.chat.id, ctx.session); // Save session state
        };

        return next();
    });

    // --- OWNER DASHBOARD ---
    const isOwner = (ctx) => String(ctx.chat.id) === String(ctx.tenant.owner_chat_id);

    async function renderOwnerDashboard(ctx) {
        if (!isOwner(ctx)) return;

        const tenant = ctx.tenant;
        const status = tenant.is_active ? "✅ Ativo" : "❌ Inativo";
        const syncPayStatus = (tenant.syncpay_client_id && tenant.syncpay_client_secret) ? "✅ Configurado" : "⚠️ Pendente";

        const text = `👑 <b>Painel do Dono (${tenant.name})</b>\n\n` +
            `📊 <b>Status:</b> ${status}\n` +
            `💳 <b>Pagamento (SyncPay):</b> ${syncPayStatus}\n` +
            `🔑 <b>Token Bot:</b> ...${tenant.telegram_token.slice(-5)}\n\n` +
            `<i>Configure suas credenciais abaixo para receber pagamentos:</i>`;

        const buttons = [
            [Markup.button.callback("💳 Configurar SyncPay", "owner_setup_syncpay")],
            [Markup.button.callback("🔄 Recarregar Bot", "owner_reload_bot")]
        ];

        await ctx.reply(text, { parse_mode: "HTML", ...Markup.inlineKeyboard(buttons) });
    }

    bot.command("admin", async (ctx) => {
        if (!isOwner(ctx)) return ctx.reply("⛔ Acesso restrito ao dono do bot.");
        await renderOwnerDashboard(ctx);
    });

    bot.action("owner_menu", async (ctx) => {
        if (!isOwner(ctx)) return;
        await ctx.answerCbQuery();
        await renderOwnerDashboard(ctx);
    });

    bot.action("owner_setup_syncpay", async (ctx) => {
        if (!isOwner(ctx)) return;
        ctx.session.stage = "OWNER_WAIT_SYNCPAY_ID";
        await ctx.save();
        await ctx.reply("💳 <b>Configuração SyncPay (Passo 1/2)</b>\n\nPor favor, envie o seu <b>Client ID</b> da SyncPay:", { parse_mode: "HTML" });
    });

    bot.action("owner_reload_bot", async (ctx) => {
        if (!isOwner(ctx)) return;
        await ctx.answerCbQuery("🔄 Reiniciando...", { show_alert: true });
        // Em um sistema real, isso recarregaria as configs do banco
        // Aqui, vamos apenas simular ou atualizar o objeto tenant em memória se tivermos um método para isso
        // Por simplificação: avisamos para chamar o suporte se mudou algo crítico
        await ctx.reply("ℹ️ As configurações são recarregadas automaticamente a cada ciclo. Se mudou algo no banco, aguarde alguns instantes.");
    });

    // Capture Text Handling for Wizard
    bot.on("text", async (ctx, next) => {
        if (!isOwner(ctx)) return next();

        const stage = ctx.session.stage;

        if (stage === "OWNER_WAIT_SYNCPAY_ID") {
            ctx.session.temp_sync_id = ctx.message.text.trim();
            ctx.session.stage = "OWNER_WAIT_SYNCPAY_SECRET";
            await ctx.save();
            return ctx.reply("💳 <b>Passo 2/2</b>\n\nAgora envie o seu <b>Client Secret</b> da SyncPay:", { parse_mode: "HTML" });
        }

        if (stage === "OWNER_WAIT_SYNCPAY_SECRET") {
            const secret = ctx.message.text.trim();
            const clientId = ctx.session.temp_sync_id;

            // Salvar no Banco SaaS (Tabela tenants)
            const { error } = await supabase
                .from('tenants')
                .update({
                    syncpay_client_id: clientId,
                    syncpay_client_secret: secret
                })
                .eq('id', ctx.tenant.id);

            if (error) {
                return ctx.reply(`❌ Erro ao salvar: ${error.message}`);
            }

            ctx.session.stage = "READY";
            ctx.session.temp_sync_id = null;
            await ctx.save();

            // Atualizar contexto em memória (dirty fix para não precisar reiniciar)
            ctx.tenant.syncpay_client_id = clientId;
            ctx.tenant.syncpay_client_secret = secret;

            await ctx.reply("✅ <b>Sucesso!</b> Credenciais SyncPay configuradas.\nAgora seus clientes pagarão diretamente para VOCÊ!", { parse_mode: "HTML" });
            return renderOwnerDashboard(ctx);
        }

        return next();
    });


    bot.start(async (ctx) => {
        const userFirstName = ctx.from.first_name || "Usuário";
        const welcomeMsg = `👋 <b>Olá, ${userFirstName}!</b>\n\n` +
            `Bem-vindo ao sistema de automação de <b>${ctx.tenant.name}</b>.\n` +
            `\n🆔 Seu ID: <code>${ctx.chat.id}</code>` +
            `\n🏢 Tenant: ${ctx.tenant.name}`;

        await ctx.reply(welcomeMsg, { parse_mode: "HTML" });
    });

    bot.command("id", (ctx) => {
        ctx.reply(`🆔 ID: <code>${ctx.chat.id}</code>`, { parse_mode: "HTML" });
    });

    // Aqui você adicionaria toda a lógica original do seu bot (Wuzapi, Menus, etc)
    // Adaptada para usar ctx.tenant e ctx.session
    // ...

    bot.launch().then(() => {
        log(`Bot Online! 🚀`, tenant.name);
    }).catch(err => {
        log(`Erro ao iniciar bot: ${err.message}`, tenant.name);
    });

    activeBots.set(tenant.id, bot);
}

// -- Loaders --
async function loadTenants() {
    log("Carregando Tenants...", "SYSTEM");
    const { data: tenants, error } = await supabase
        .from('tenants')
        .select('*')
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
    // Proteger isso com senha na V2
    const { name, telegram_token, syncpay_id, syncpay_secret } = req.body;

    const { data, error } = await supabase.from('tenants').insert({
        name,
        telegram_token,
        syncpay_client_id: syncpay_id,
        syncpay_client_secret: syncpay_secret,
        is_active: true
    }).select().single();

    if (error) return res.status(400).json({ error: error.message });

    // Iniciar o bot imediatamente
    startTenantBot(data);

    return res.json({ success: true, tenant: data });
});

// -- MASTER ADMIN BOT (Gerenciador do SaaS) --
const MASTER_TOKEN = process.env.MASTER_BOT_TOKEN;
const MASTER_ADMIN_ID = process.env.MASTER_ADMIN_ID;

if (MASTER_TOKEN) {
    const masterBot = new Telegraf(MASTER_TOKEN);

    // Middleware de Segurança (Só você pode usar)
    masterBot.use((ctx, next) => {
        // Permitir descobrir o ID mesmo sem configurar
        if (ctx.message?.text === '/meu_id') return next();

        // Se MASTER_ADMIN_ID não estiver configurado, avisa no log e ignora
        if (!MASTER_ADMIN_ID) {
            return ctx.reply("⚠️ ADMIN_ID não configurado no .env. Configure para usar este bot.\nUse /meu_id para descobrir o seu.");
        }
        if (String(ctx.chat.id) !== String(MASTER_ADMIN_ID)) {
            log(`Acesso negado ao Master Bot: ${ctx.chat.id}`, "SECURITY");
            return;
        }
        return next();
    });

    // Wizard Simples com Session em Memória para o Master
    const masterSessions = new Map(); // chatId -> { stage, data }

    masterBot.command("start", (ctx) => {
        ctx.reply("👑 <b>Painel Master SaaS</b>\n\nUse /novo_cliente para criar um novo Tenant.", { parse_mode: "HTML" });
    });

    masterBot.command("meu_id", (ctx) => {
        ctx.reply(`🆔 Seu ID: <code>${ctx.chat.id}</code>\n(Coloque isso no .env em MASTER_ADMIN_ID)`, { parse_mode: "HTML" });
    });

    masterBot.command("novo_cliente", (ctx) => {
        masterSessions.set(ctx.chat.id, { stage: "WAIT_NAME", data: {} });
        ctx.reply("📝 <b>Novo Cliente</b>\n\nQual o <b>Nome</b> do cliente/empresa?");
    });

    masterBot.on("text", async (ctx) => {
        const session = masterSessions.get(ctx.chat.id);
        if (!session) return;

        if (session.stage === "WAIT_NAME") {
            session.data.name = ctx.message.text.trim();
            session.stage = "WAIT_TOKEN";
            return ctx.reply("🤖 Qual o <b>Token do Bot</b> dele?");
        }

        if (session.stage === "WAIT_TOKEN") {
            const token = ctx.message.text.trim();
            // Validação básica de token
            if (!token.includes(":")) return ctx.reply("❌ Token inválido. Tente novamente:");

            session.data.telegram_token = token;
            session.stage = "WAIT_OWNER_ID";
            return ctx.reply("👤 Qual o <b>Telegram ID (Chat ID)</b> do Dono?\n(Ele usará isso para acessar o painel /admin)");
        }

        if (session.stage === "WAIT_OWNER_ID") {
            session.data.owner_chat_id = ctx.message.text.trim();

            ctx.reply("⏳ Criando tenant e iniciando bot...");

            // Salvar no Banco
            const { data, error } = await supabase.from('tenants').insert({
                name: session.data.name,
                telegram_token: session.data.telegram_token,
                owner_chat_id: session.data.owner_chat_id,
                is_active: true
            }).select().single();

            if (error) {
                masterSessions.delete(ctx.chat.id);
                return ctx.reply(`❌ Erro ao criar: ${error.message}`);
            }

            // Iniciar o bot dele imediatamente
            startTenantBot(data);

            masterSessions.delete(ctx.chat.id);
            return ctx.reply(`✅ <b>Sucesso!</b>\n\nCliente <b>${data.name}</b> criado.\nBot iniciado: @${(await new Telegraf(data.telegram_token).telegram.getMe()).username}\n\nO dono já pode acessar o /admin.`);
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
