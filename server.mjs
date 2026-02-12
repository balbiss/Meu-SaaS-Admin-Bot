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
const DEFAULT_MODEL = "gpt-4o-mini";

// Helper para pegar a instância da OpenAI correta
function getOpenAI(tenant) {
    const apiKey = tenant.openai_api_key; // STRICT MODE: Apenas key do tenant
    if (!apiKey) return null;
    return new OpenAI({ apiKey });
}

const WUZAPI_BASE_URL = process.env.WUZAPI_BASE_URL || "http://localhost:8080";
const WUZAPI_ADMIN_TOKEN = process.env.WUZAPI_ADMIN_TOKEN;
const WEBHOOK_BASE = process.env.WEBHOOK_URL || `http://localhost:${PORT}/webhook`;

// -- Credenciais MESTRE (Para receber pagamentos das assinaturas) --
const MASTER_SYNCPAY_ID = process.env.SYNCPAY_MASTER_ID;
const MASTER_SYNCPAY_SECRET = process.env.SYNCPAY_MASTER_SECRET;

console.log("--- DEBUG ENV VARS ---");
console.log("SYNCPAY_MASTER_ID:", MASTER_SYNCPAY_ID ? (MASTER_SYNCPAY_ID.substring(0, 4) + "***") : "UNDEFINED");
console.log("SYNCPAY_MASTER_SECRET:", MASTER_SYNCPAY_SECRET ? "PRESENT (MASKED)" : "UNDEFINED");
console.log("----------------------");

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

// -- Helper de Pagamento MESTRE (Renovação) --
async function generateSubscriptionCharge(tenant) {
    if (!MASTER_SYNCPAY_ID || !MASTER_SYNCPAY_SECRET) {
        throw new Error("Sistema de cobrança não configurado pelo Admin Mestre.");
    }

    const price = 49.90; // Preço da Assinatura Mensal
    const expiryMinutes = 60; // 1 hora para pagar

    // 1. Auth no SyncPay (Como MESTRE)
    const authDesc = Buffer.from(`${MASTER_SYNCPAY_ID}:${MASTER_SYNCPAY_SECRET}`).toString('base64');
    const tokenRes = await fetch("https://api.syncpayments.com.br/oauth/token", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Basic ${authDesc}`
        },
        body: JSON.stringify({ grant_type: "client_credentials" })
    });

    if (!tokenRes.ok) throw new Error("Falha na autenticação SyncPay Master");
    const { access_token } = await tokenRes.json();

    // 2. Gerar Cobrança Pix
    const chargeRes = await fetch("https://api.syncpayments.com.br/v1/billing/pix", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${access_token}`
        },
        body: JSON.stringify({
            items: [{
                name: `Renovação SaaS - ${tenant.name}`,
                value: price * 100, // em centavos
                amount: 1
            }],
            external_id: `SUB_${tenant.id}`, // Prefixo para identificar renovação
            customer: {
                name: tenant.name,
                email: `tenant_${tenant.id}@venux.com`, // Placeholder ou real se tiver
                phone: "11999999999", // Placeholder
                document: "00000000000" // Placeholder
            },
            expire_at: new Date(Date.now() + expiryMinutes * 60000).toISOString()
        })
    });

    if (!chargeRes.ok) {
        const err = await chargeRes.text();
        throw new Error(`Erro ao gerar Pix: ${err}`);
    }

    return await chargeRes.json(); // Retorna { qrcode_text, qrcode_image_url, etc }
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

    // Definir Menu de Comandos do Bot (Para o Tenant e Usuários)
    bot.telegram.setMyCommands([
        { command: "start", description: "Iniciar atendimento" },
        { command: "admin", description: "Painel do Dono (Configurações)" },
        { command: "id", description: "Ver meu ID do Telegram" }
    ]);

    // --- OWNER DASHBOARD ---
    const isOwner = (ctx) => String(ctx.chat.id) === String(ctx.tenant.owner_chat_id);

    async function renderOwnerDashboard(ctx) {
        if (!isOwner(ctx)) return;

        const tenant = ctx.tenant;

        let status = tenant.is_active ? "✅ Ativo" : "❌ Inativo (Banido)";
        if (tenant.expiration_date && new Date() > new Date(tenant.expiration_date)) {
            status = "🚫 Vencido (Bloqueado)";
        }

        const syncPayStatus = (tenant.syncpay_client_id && tenant.syncpay_client_secret) ? "✅ Configurado" : "⚠️ Pendente";

        // Status da IA
        const aiKeyStatus = tenant.openai_api_key ? "✅ Própria (Ativa)" : "🔴 Não Configurada (IA Off)";
        const aiModel = tenant.openai_model || DEFAULT_MODEL;

        const text = `👑 <b>Painel do Dono (${tenant.name})</b>\n\n` +
            `📊 <b>Status:</b> ${status}\n` +
            `💳 <b>Pagamento (SyncPay):</b> ${syncPayStatus}\n` +
            `🧠 <b>Inteligência Artificial:</b>\n` +
            `   ├ Key: ${aiKeyStatus}\n` +
            `   └ Modelo: ${aiModel}\n` +
            `🔑 <b>Token Bot:</b> ...${tenant.telegram_token.slice(-5)}\n\n` +
            `<i>Configure suas credenciais abaixo:</i>`;

        const buttons = [
            [Markup.button.callback("💳 Configurar SyncPay", "owner_setup_syncpay")],
            [Markup.button.callback("🧠 Configurar IA", "owner_setup_ai")],
            [Markup.button.callback("💸 Renovar Assinatura (R$ 49,90)", "owner_renew_sub")],
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

    // --- SETUP SYNCPAY ---
    bot.action("owner_setup_syncpay", async (ctx) => {
        if (!isOwner(ctx)) return;
        ctx.session.stage = "OWNER_WAIT_SYNCPAY_ID";
        await ctx.save();
        await ctx.reply("💳 <b>Configuração SyncPay (Passo 1/2)</b>\n\nPor favor, envie o seu <b>Client ID</b> da SyncPay:", { parse_mode: "HTML" });
    });

    // --- SETUP IA ---
    bot.action("owner_setup_ai", async (ctx) => {
        if (!isOwner(ctx)) return;
        ctx.session.stage = "OWNER_WAIT_OPENAI_KEY";
        await ctx.save();
        await ctx.reply(
            "⚠️ <b>Atenção:</b> Para a IA funcionar, você precisa usar a <b>SUA</b> API Key.\n\n" +
            "Envie agora a sua chave (começa com sk-...).\n" +
            "Se não enviar, a inteligência do bot ficará desligada.",
            { parse_mode: "HTML" }
        );
    });

    bot.action("owner_reload_bot", async (ctx) => {
        if (!isOwner(ctx)) return;
        await ctx.answerCbQuery("🔄 Reiniciando...", { show_alert: true });
        // Recarrega do banco para pegar mudanças de API Key/Model confirmadas
        try {
            const { data } = await supabase.from('tenants').select('*').eq('id', tenant.id).single();
            if (data) {
                Object.assign(tenant, data); // Atualiza objeto em memória
                await ctx.reply("✅ Configurações recarregadas com sucesso!");
                return renderOwnerDashboard(ctx);
            }
        } catch (e) {
            await ctx.reply("❌ Erro ao recarregar.");
        }
    });

    // Capture Text Handling for Wizard
    bot.on("text", async (ctx, next) => {
        // Ignorar se não for dono
        if (!isOwner(ctx)) return next();

        const text = ctx.message.text;

        // Se for comando (começa com /), deixa passar para os handlers de comando
        // EXCETO /cancelar, que queremos que resete o wizard aqui mesmo
        if (text.startsWith("/") && text !== "/cancelar") {
            return next();
        }

        if (text === "/cancelar") {
            ctx.session.stage = "READY";
            await ctx.save();
            await ctx.reply("❌ Operação cancelada.");
            return renderOwnerDashboard(ctx);
        }

        const stage = ctx.session.stage;

        // --- SYNCPAY FLOW ---
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

            if (error) return ctx.reply(`❌ Erro: ${error.message}`);

            ctx.session.stage = "READY";
            ctx.session.temp_sync_id = null;
            await ctx.save();

            // Atualizar memória
            ctx.tenant.syncpay_client_id = clientId;
            ctx.tenant.syncpay_client_secret = secret;

            await ctx.reply("✅ SyncPay configurado!", { parse_mode: "HTML" });
            return renderOwnerDashboard(ctx);
        }

        // --- OPENAI FLOW ---
        if (stage === "OWNER_WAIT_OPENAI_KEY") {
            const key = ctx.message.text.trim();
            if (!key.startsWith("sk-")) return ctx.reply("❌ Key inválida. Deve começar com 'sk-'. Tente novamente ou /cancelar.");

            // Salva a Key e pergunta o modelo
            ctx.session.temp_openai_key = key;
            ctx.session.stage = "OWNER_WAIT_OPENAI_MODEL";
            await ctx.save();

            const buttons = [
                [Markup.button.callback("GPT-4o Mini (Padrão)", "set_model_4o_mini")],
                [Markup.button.callback("GPT-4o (Potente)", "set_model_4o")],
                [Markup.button.callback("GPT-3.5 Turbo (Antigo)", "set_model_35")]
            ];

            return ctx.reply("🤖 <b>Escolha o Modelo de IA:</b>", { parse_mode: "HTML", ...Markup.inlineKeyboard(buttons) });
        }

        return next();
    });

    // --- MODEL SELECTION ACTIONS ---
    const saveModel = async (ctx, modelName) => {
        const key = ctx.session.temp_openai_key;
        if (!key) return ctx.reply("❌ Sessão expirada. Comece de novo.");

        const { error } = await supabase
            .from('tenants')
            .update({
                openai_api_key: key,
                openai_model: modelName
            })
            .eq('id', ctx.tenant.id);

        if (error) return ctx.reply(`❌ Erro ao salvar: ${error.message}`);

        ctx.session.stage = "READY";
        ctx.session.temp_openai_key = null;
        await ctx.save();

        // Atualizar memória
        ctx.tenant.openai_api_key = key;
        ctx.tenant.openai_model = modelName;

        await ctx.reply(`✅ <b>IA Configurada!</b>\nModelo: ${modelName}`, { parse_mode: "HTML" });
        return renderOwnerDashboard(ctx);
    };

    // --- RENOVAÇÃO DE ASSINATURA ---
    bot.action("owner_renew_sub", async (ctx) => {
        if (!isOwner(ctx)) return;
        await ctx.answerCbQuery("Gerando Pix...");
        await ctx.reply("⏳ <b>Gerando cobrança...</b> Aguarde um momento.", { parse_mode: "HTML" });

        try {
            const charge = await generateSubscriptionCharge(ctx.tenant);

            const pixCode = charge.qrcode_text;
            const qrImage = charge.qrcode_image_url;

            // Envia Imagem QR Code
            if (qrImage) {
                await ctx.replyWithPhoto(qrImage, { caption: "📱 Escaneie para pagar" });
            }

            // Envia Copia e Cola
            await ctx.reply(
                `💰 <b>Renovação de Assinatura</b>\n` +
                `Valor: R$ 49,90\n` +
                `ID: <code>${charge.id}</code>\n\n` +
                `Copie o código abaixo e pague no seu banco:`,
                { parse_mode: "HTML" }
            );
            await ctx.reply(`<code>${pixCode}</code>`, { parse_mode: "HTML" });

            await ctx.reply("ℹ️ Assim que o pagamento for confirmado, seu plano será renovado automaticamente por +30 dias.");

        } catch (e) {
            log(`Erro renovação [${ctx.tenant.name}]: ${e.message}`, "ERROR");
            await ctx.reply(`❌ Erro ao gerar cobrança: ${e.message}`);
        }
    });

    bot.action("set_model_4o_mini", (ctx) => saveModel(ctx, "gpt-4o-mini"));
    bot.action("set_model_4o", (ctx) => saveModel(ctx, "gpt-4o"));
    bot.action("set_model_35", (ctx) => saveModel(ctx, "gpt-3.5-turbo"));


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

    // -- Lógica de Chat da IA --
    bot.on("text", async (ctx) => {
        // Ignorar se estiver em uma "sessão" de wizard (Owner)
        if (ctx.session?.stage && ctx.session.stage !== "READY") return;

        // Se for comando, ignora (já tratado)
        if (ctx.message.text.startsWith("/")) return;

        const openai = getOpenAI(ctx.tenant);

        // Se não tiver OpenAI configurada
        if (!openai) {
            // Se for o dono, avisa como configurar. Se for usuário comum, diz que está em manutenção.
            if (String(ctx.chat.id) === String(ctx.tenant.owner_chat_id)) {
                return ctx.reply("⚠️ <b>IA Não Configurada.</b>\nUse /admin para adicionar sua API Key.", { parse_mode: "HTML" });
            } else {
                return ctx.reply("🤖 O administrador ainda não ativou minha inteligência.");
            }
        }

        const model = ctx.tenant.openai_model || DEFAULT_MODEL;

        try {
            await ctx.sendChatAction("typing");

            const response = await openai.chat.completions.create({
                model: model,
                messages: [
                    { role: "system", content: "Você é um assistente útil e inteligente." },
                    { role: "user", content: ctx.message.text }
                ],
            });

            ctx.reply(response.choices[0].message.content);
        } catch (e) {
            log(`Erro OpenAI [${ctx.tenant.name}]: ${e.message}`, "ERROR");
            ctx.reply("❌ Ocorreu um erro ao processar sua mensagem.");
        }
    });

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

// -- Webhook MESTRE (Recebe pagamentos das assinaturas) --
app.post("/webhook/master", async (req, res) => {
    const { id, type, status, charges, external_id } = req.body;

    log(`[Webhook Master] Recebido: ${type} | Status: ${status} | ExtID: ${external_id}`, "SYSTEM");

    // Verificar se é uma assinatura (SUB_)
    if (!external_id || !external_id.startsWith("SUB_")) {
        return res.json({ ignored: true, reason: "Not a subscription payment" });
    }

    // Verificar se foi pago
    if (status !== "PAID" && status !== "RECEIVED") {
        return res.json({ ignored: true, reason: "Status not PAID" });
    }

    const tenantIdPromise = external_id.split("SUB_")[1];
    if (!tenantIdPromise) return res.status(400).json({ error: "Invalid External ID" });

    const tenantId = tenantIdPromise;

    try {
        // 1. Buscar Tenant Atual
        const { data: tenant, error: fetchError } = await supabase
            .from('tenants')
            .select('*')
            .eq('id', tenantId)
            .single();

        if (fetchError || !tenant) {
            log(`[Webhook Master] Tenant não encontrado: ${tenantId}`, "ERROR");
            return res.status(404).json({ error: "Tenant not found" });
        }

        // 2. Calcular Nova Data (+30 dias a partir de agora ou da data atual se ainda não venceu)
        let baseDate = new Date();
        if (tenant.expiration_date && new Date(tenant.expiration_date) > baseDate) {
            baseDate = new Date(tenant.expiration_date);
        }

        baseDate.setDate(baseDate.getDate() + 30);
        const newExpiration = baseDate.toISOString();

        // 3. Atualizar Banco
        await supabase
            .from('tenants')
            .update({
                expiration_date: newExpiration,
                is_active: true // Reativa se estiver bloqueado
            })
            .eq('id', tenantId);

        log(`[Webhook Master] Assinatura renovada para Tenant ${tenant.name} até ${newExpiration}`, "SYSTEM");

        // 4. Notificar via Telegram (Se bot estiver rodando)
        if (activeBots.has(tenant.id)) {
            const botInstance = activeBots.get(tenant.id);
            if (tenant.owner_chat_id) {
                botInstance.telegram.sendMessage(
                    tenant.owner_chat_id,
                    `✅ <b>Pagamento Confirmado!</b>\n\nSua assinatura foi renovada com sucesso.\nNovo vencimento: <b>${new Date(newExpiration).toLocaleDateString("pt-BR")}</b>`,
                    { parse_mode: "HTML" }
                ).catch(e => log(`Erro ao notificar tenant: ${e.message}`, "ERROR"));
            }
        }

        return res.json({ success: true, new_expiration: newExpiration });

    } catch (e) {
        log(`[Webhook Master] Erro processamento: ${e.message}`, "ERROR");
        return res.status(500).json({ error: e.message });
    }
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

    // Definir Menu de Comandos do Master Bot
    masterBot.telegram.setMyCommands([
        { command: "novo_cliente", description: "Criar novo tenant" },
        { command: "clientes", description: "Listar clientes e vencimentos" },
        { command: "renovar", description: "Renovar assinatura" },
        { command: "bloquear", description: "Bloquear acesso" },
        { command: "meu_id", description: "Ver meu ID" }
    ]);

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
            // Validação básica de token
            if (!token.includes(":")) return ctx.reply("❌ Token inválido. Tente novamente:");

            session.data.telegram_token = token;
            session.stage = "WAIT_OWNER_ID";
            return ctx.reply("👤 Qual o Telegram ID (Chat ID) do Dono?\n(Ele usará isso para acessar o painel /admin)");
        }

        if (session.stage === "WAIT_OWNER_ID") {
            session.data.owner_chat_id = ctx.message.text.trim();

            ctx.reply("⏳ Criando tenant e iniciando bot...");

            // Salvar no Banco
            const { data, error } = await supabase.from('tenants').insert({
                name: session.data.name,
                telegram_token: session.data.telegram_token,
                owner_chat_id: session.data.owner_chat_id,
                is_active: true,
                expiration_date: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
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
