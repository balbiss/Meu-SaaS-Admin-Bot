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
const WEBHOOK_BASE = (process.env.WEBHOOK_URL || `http://localhost:${PORT}`).replace(/\/$/, "");

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

// Helper para pegar Preço Global
async function getGlobalPrice() {
    const { data } = await supabase.from('system_config').select('value').eq('key', 'default_price').single();
    return data ? parseFloat(data.value) : 90.90;
}

// Helper para contar usuários únicos (instances)
async function getTenantUserCount(tenantId) {
    const { count, error } = await supabase
        .from('bot_sessions')
        .select('chat_id', { count: 'exact', head: true })
        .eq('tenant_id', tenantId);
    return error ? 0 : count;
}

// Helper para verificar se usuário já existe
async function checkUserExists(tenantId, chatId) {
    const { data } = await supabase
        .from('bot_sessions')
        .select('chat_id')
        .eq('tenant_id', tenantId)
        .eq('chat_id', String(chatId))
        .single();
    return !!data;
}

// -- Helper de Pagamento MESTRE (Renovação) --
async function generateSubscriptionCharge(tenant) {
    if (!MASTER_SYNCPAY_ID || !MASTER_SYNCPAY_SECRET) {
        throw new Error("Sistema de cobrança não configurado pelo Admin Mestre.");
    }
    const defaultPrice = await getGlobalPrice();
    const price = tenant.subscription_price || defaultPrice;
    const expiryMinutes = 60; // 1 hora para pagar

    // 1. Auth no SyncPay (Como MESTRE)
    // Documentação sugere: POST /api/partner/v1/auth-token
    const tokenRes = await fetch("https://api.syncpayments.com.br/api/partner/v1/auth-token", {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            client_id: MASTER_SYNCPAY_ID,
            client_secret: MASTER_SYNCPAY_SECRET
        })
    });

    if (!tokenRes.ok) {
        const errText = await tokenRes.text();
        throw new Error(`Falha Auth Master (${tokenRes.status}): ${errText.substring(0, 500)}...`);
    }
    const { access_token } = await tokenRes.json();

    // 2. Gerar Cobrança Pix
    // Endpoint oficial: POST /api/partner/v1/cash-in
    const chargeUrl = "https://api.syncpayments.com.br/api/partner/v1/cash-in";
    log(`Gerando Pix em: ${chargeUrl}`);

    const chargeRes = await fetch(chargeUrl, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${access_token}`,
            "Accept": "application/json"
        },
        body: JSON.stringify({
            amount: price, // Valor float (ex: 49.90)
            description: `Renovação SaaS - ${tenant.name}`,
            webhook_url: `${WEBHOOK_BASE}/webhook/master`, // Webhook do Mestre
            client: {
                name: tenant.name,
                email: `tenant_${tenant.id}@venux.com`,
                phone: "11999999999", // Placeholder, obrigatório 10-11 digitos
                cpf: "00000000000"    // Placeholder, obrigatório 11 digitos
            }
        })
    });

    if (!chargeRes.ok) {
        const err = await chargeRes.text();
        throw new Error(`Erro ao gerar Pix: ${err.substring(0, 500)}...`);
    }

    const data = await chargeRes.json();
    // Retorna formato unificado
    return {
        id: data.identifier,
        qrcode_text: data.pix_code,
        qrcode_image_url: null // API não retorna imagem direta, apenas o código
    };
}

// -- SaaS Bot Factory --
async function startTenantBot(tenant) {
    if (activeBots.has(tenant.id)) {
        log(`Bot já está rodando. Reiniciando...`, tenant.name);
        try { activeBots.get(tenant.id).stop(); } catch (e) { }
    }

    // Load initial user count
    const initialUserCount = await getTenantUserCount(tenant.id);
    tenant.activeUserCount = initialUserCount;

    log(`Iniciando Bot [${tenant.name}]... (Usuários: ${initialUserCount}/${tenant.max_users || 10})`, "SYSTEM");

    const bot = new Telegraf(tenant.telegram_token);

    // Inject Tenant Context Middleware
    bot.use(async (ctx, next) => {
        ctx.tenant = tenant;

        // -- VALIDAÇÃO DE VENCIMENTO --
        if (tenant.expiration_date) {
            const now = new Date();
            const expiration = new Date(tenant.expiration_date);
            if (now > expiration && String(ctx.chat.id) !== tenant.owner_chat_id) {
                return ctx.reply("🚫 <b>Seu plano venceu!</b>\nEntre em contato com o suporte para renovar.", { parse_mode: "HTML" });
            }
        }

        // -- VALIDAÇÃO DE LIMITE DE USUÁRIOS --
        // Se for o dono, sempre libera
        if (String(ctx.chat.id) !== tenant.owner_chat_id) {
            const cacheKey = `${tenant.id}_${ctx.chat.id}`;
            const isCached = sessionCache.has(cacheKey);

            // Se não está no cache (potencial novo usuário na sessão atual do servidor)
            if (!isCached) {
                // Verifica se já está no banco (usuário antigo retornando)
                const existsInDb = await checkUserExists(tenant.id, ctx.chat.id);

                if (!existsInDb) {
                    // NOVO USUÁRIO REAL
                    const maxUsers = tenant.max_users || 10;
                    if (tenant.activeUserCount >= maxUsers) {
                        return ctx.reply(`🚫 <b>Limite de Usuários Atingido!</b>\n\nEste bot atingiu o limite máximo de ${maxUsers} usuários simultâneos contratados.\nEntre em contato com o administrador.`, { parse_mode: "HTML" });
                    }
                    // Se passou, incrementa (será salvo no saveSession depois)
                    tenant.activeUserCount++;
                    log(`[${tenant.name}] Novo usuário! Total: ${tenant.activeUserCount}/${maxUsers}`, "INFO");
                }
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
            // const qrImage = charge.qrcode_image_url; // Removido a pedido

            // Envia Copia e Cola
            await ctx.reply(
                `💰 <b>Renovação de Assinatura</b>\n` +
                `Valor: R$ ${charge.value.toFixed(2).replace('.', ',')}\n` +
                `Cliente: <b>${ctx.tenant.name}</b>\n\n` +
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
// -- Webhook MESTRE (Recebe pagamentos das assinaturas) --
app.post("/webhook/master", async (req, res) => {
    // SyncPay envia o payload dentro de "data"
    const payload = req.body.data || req.body;
    const { id, status, client } = payload;

    log(`[Webhook Master] Recebido! Status: ${status} | ID: ${id}`, "SYSTEM");

    // Verificar status de sucesso (SyncPay usa 'completed' para Pix pago)
    // Aceitamos PAID, RECEIVED (outros gateways) ou COMPLETED (SyncPay)
    if (status !== "completed" && status !== "PAID" && status !== "RECEIVED") {
        return res.json({ ignored: true, reason: `Status ${status} not eligible` });
    }

    // Tentar extrair Tenant ID do Email do Cliente (estratégia sem banco)
    // Email enviado: "tenant_{ID}@venux.com"
    let tenantId = null;
    if (client && client.email) {
        const match = client.email.match(/tenant_(\d+)@/);
        if (match) tenantId = match[1];
    }

    // Fallback: Tentar external_id (se enviado no futuro)
    if (!tenantId && payload.external_id && payload.external_id.startsWith("SUB_")) {
        tenantId = payload.external_id.split("SUB_")[1];
    }

    if (!tenantId) {
        log(`[Webhook Master] ID do Tenant não identificado no payload.`, "ERROR");
        console.log("Payload recebido:", JSON.stringify(payload, null, 2));
        return res.status(400).json({ error: "Tenant ID not found in payload" });
    }

    try {
        // 1. Buscar Tenant Atual
        const { data: tenant, error: fetchError } = await supabase
            .from('tenants')
            .select('*')
            .eq('id', tenantId)
            .single();

        if (fetchError || !tenant) {
            log(`[Webhook Master] Tenant não encontrado no Banco: ${tenantId}`, "ERROR");
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

        log(`[Webhook Master] 💰 Assinatura renovada! Tenant: ${tenant.name} (${tenant.id}) até ${new Date(newExpiration).toLocaleDateString("pt-BR")}`, "SYSTEM");

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

    // --- MENU PRINCIPAL ---
    masterBot.command("start", (ctx) => {
        ctx.reply(
            "👑 <b>Painel Master SaaS</b>\n\nEscolha uma opção:",
            {
                parse_mode: "HTML",
                ...Markup.inlineKeyboard([
                    [Markup.button.callback("👥 Gerenciar Clientes", "list_tenants")],
                    [Markup.button.callback("➕ Novo Cliente", "new_tenant_start")],
                    [Markup.button.callback("💲 Alterar Preço Global", "cmd_set_global_price")]
                ])
            }
        );
    });

    // --- LISTAR CLIENTES (Menus interativos) ---
    masterBot.action("list_tenants", async (ctx) => {
        const { data: tenants } = await supabase.from('tenants').select('*').order('id');

        if (!tenants || tenants.length === 0) return ctx.reply("Nenhum cliente encontrado.");

        const buttons = tenants.map(t => {
            const statusIcon = t.is_active ? "✅" : "🚫";
            return [Markup.button.callback(`${statusIcon} ${t.name}`, `manage_tenant_${t.id}`)];
        });

        await ctx.editMessageText("👥 <b>Selecione um Cliente:</b>", {
            parse_mode: "HTML",
            ...Markup.inlineKeyboard(buttons)
        });
    });

    // --- LOGICA DE PREÇO GLOBAL ---
    masterBot.action("cmd_set_global_price", async (ctx) => {
        const currentPrice = await getGlobalPrice();
        masterSessions.set(ctx.chat.id, { stage: "WAIT_GLOBAL_PRICE", data: {} });
        await ctx.reply(`💲 <b>Preço Global Atual: R$ ${currentPrice.toFixed(2)}</b>\n\nDigite o novo valor para TODOS os clientes sem preço fixo (ex: 129.90):`, { parse_mode: "HTML" });
    });

    // --- DETALHES DO CLIENTE ---
    masterBot.action(/manage_tenant_(.+)/, async (ctx) => {
        const id = ctx.match[1];
        console.log(`[DEBUG] Manage Tenant ID: ${id}`);
        const { data: t } = await supabase.from('tenants').select('*').eq('id', id).single();

        if (!t) return ctx.reply(`Cliente não encontrado (ID: ${id}).`);

        const vcto = t.expiration_date ? new Date(t.expiration_date).toLocaleDateString('pt-BR') : "Sem data";
        const price = t.subscription_price ? `R$ ${t.subscription_price.toFixed(2)} (Fixo)` : `Padrão (Global)`;
        const status = t.is_active ? "Ativo" : "Bloqueado";
        const limits = t.max_users || 10;

        const msg = `🏢 <b>Cliente:</b> ${t.name}\n` +
            `🆔 ID: ${t.id}\n` +
            `📊 Status: ${status}\n` +
            `👥 Usuários: ${limits} max\n` +
            `💲 Preço: ${price}\n` +
            `📅 Vence em: ${vcto}`;

        await ctx.editMessageText(msg, {
            parse_mode: "HTML",
            ...Markup.inlineKeyboard([
                [Markup.button.callback("👥 Alterar Limite", `cmd_limit_${id}`)],
                [Markup.button.callback("💲 Definir Preço Fixo", `cmd_price_${id}`)],
                [Markup.button.callback("📅 Renovar Assinatura", `cmd_renew_${id}`)],
                [Markup.button.callback(t.is_active ? "🚫 Bloquear" : "✅ Desbloquear", `cmd_toggle_active_${id}`)],
                [Markup.button.callback("🔙 Voltar", "list_tenants")]
            ])
        });
    });

    // --- AÇÕES DO CLIENTE (Wizards) ---

    // 0. LIMITE DE USUÁRIOS
    masterBot.action(/cmd_limit_(.+)/, async (ctx) => {
        const id = ctx.match[1];
        masterSessions.set(ctx.chat.id, { stage: "WAIT_LIMIT_VALUE", data: { id } });
        await ctx.reply(`👥 <b>Alterar Limite de Usuários (Cliente ID ${id})</b>\n\nDigite o novo número máximo de usuários (ex: 50):`, { parse_mode: "HTML" });
    });

    // 1. PREÇO
    masterBot.action(/cmd_price_(.+)/, async (ctx) => {
        const id = ctx.match[1];
        masterSessions.set(ctx.chat.id, { stage: "WAIT_PRICE_VALUE", data: { id } });
        await ctx.reply(`💲 <b>Alterar Preço Fixo (Cliente ID ${id})</b>\n\nDigite o novo valor (ex: 99.90).\nPara voltar ao global, digite 0.`, { parse_mode: "HTML" });
    });

    // 2. RENOVAR
    masterBot.action(/cmd_renew_(.+)/, async (ctx) => {
        const id = ctx.match[1];
        masterSessions.set(ctx.chat.id, { stage: "WAIT_RENEW_DAYS", data: { id } });
        await ctx.reply(`📅 <b>Renovar Assinatura (Cliente ID ${id})</b>\n\nDigite quantos dias deseja adicionar (ex: 30):`, { parse_mode: "HTML" });
    });

    // 3. BLOQUEAR/DESBLOQUEAR (Toggle)
    masterBot.action(/cmd_toggle_active_(.+)/, async (ctx) => {
        const id = ctx.match[1];
        const { data: t } = await supabase.from('tenants').select('is_active, name').eq('id', id).single();
        const newState = !t.is_active;

        await supabase.from('tenants').update({ is_active: newState }).eq('id', id);

        // Se bloqueou, para o bot
        if (!newState && activeBots.has(parseInt(id))) {
            activeBots.get(parseInt(id)).stop();
            activeBots.delete(parseInt(id));
        }
        // Se desbloqueou, teria que reiniciar (loadTenants cuida disso se reiniciar server, ou podemos forçar start aqui)
        if (newState) {
            const { data: updatedTenant } = await supabase.from('tenants').select('*').eq('id', id).single();
            startTenantBot(updatedTenant);
        }

        ctx.reply(`✅ Cliente <b>${t.name}</b> foi ${newState ? "Desbloqueado" : "Bloqueado"}.`, { parse_mode: "HTML" });
        // Retorna para lista chamando a action (trick)
        // ctx.match = [null, "list_tenants"]; // Não funciona bem direto, melhor mandar msg nova ou editar
    });

    // --- COMANDOS INTELIGENTES (Text Handler) ---
    masterBot.action("new_tenant_start", (ctx) => {
        masterSessions.set(ctx.chat.id, { stage: "WAIT_NAME", data: {} });
        ctx.reply("📝 <b>Novo Cliente</b>\n\nQual o Nome do cliente/empresa?", { parse_mode: "HTML" });
    });

    // --- TEXT HANDLER CENTRAL ---
    masterBot.on("text", async (ctx) => {
        const session = masterSessions.get(ctx.chat.id);
        if (!session) return;

        const text = ctx.message.text.trim();

        // CANCELAR
        if (text === "/cancelar") {
            masterSessions.delete(ctx.chat.id);
            return ctx.reply("❌ Operação cancelada.");
        }

        // --- WIZARD: NOVO CLIENTE ---
        if (session.stage === "WAIT_NAME") {
            session.data.name = text;
            session.stage = "WAIT_TOKEN";
            return ctx.reply("🤖 Qual o Token do Bot dele?");
        }

        if (session.stage === "WAIT_TOKEN") {
            if (!text.includes(":")) return ctx.reply("❌ Token inválido. Tente novamente:");
            session.data.telegram_token = text;
            session.stage = "WAIT_OWNER_ID";
            return ctx.reply("👤 Qual o Telegram ID (Chat ID) do Dono?\n(Ele usará isso para acessar o painel /admin)");
        }

        if (session.stage === "WAIT_OWNER_ID") {
            session.data.owner_chat_id = text;
            ctx.reply("⏳ Criando tenant...");

            const { data, error } = await supabase.from('tenants').insert({
                name: session.data.name,
                telegram_token: session.data.telegram_token,
                owner_chat_id: session.data.owner_chat_id,
                is_active: true,
                expiration_date: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
            }).select().single();

            if (error) {
                masterSessions.delete(ctx.chat.id);
                return ctx.reply(`❌ Erro: ${error.message}`);
            }

            startTenantBot(data);
            masterSessions.delete(ctx.chat.id);
            return ctx.reply(`✅ <b>Sucesso!</b>\nCliente <b>${data.name}</b> criado.`);
        }

        // --- WIZARD: ALTERAR LIMITE ---
        if (session.stage === "WAIT_LIMIT_VALUE") {
            const limit = parseInt(text);
            if (isNaN(limit)) return ctx.reply("❌ Valor inválido. Digite um número inteiro.");

            await supabase.from('tenants').update({ max_users: limit }).eq('id', session.data.id);

            // Atualizar tenant em memória se estiver rodando
            if (activeBots.has(parseInt(session.data.id))) {
                // Reiniciar para pegar limite novo
                const { data: updatedTenant } = await supabase.from('tenants').select('*').eq('id', session.data.id).single();
                startTenantBot(updatedTenant);
            }

            masterSessions.delete(ctx.chat.id);
            loadTenants();
            return ctx.reply(`✅ Limite atualizado para <b>${limit} usuários</b>`, { parse_mode: "HTML" });
        }

        // --- WIZARD: ALTERAR PREÇO FIXO ---
        if (session.stage === "WAIT_PRICE_VALUE") {
            const price = parseFloat(text.replace(",", "."));
            if (isNaN(price)) return ctx.reply("❌ Valor inválido. Digite um número (ex: 99.90).");

            // Se for 0, remove o preço customizado (null)
            const finalPrice = price === 0 ? null : price;

            await supabase.from('tenants').update({ subscription_price: finalPrice }).eq('id', session.data.id);
            masterSessions.delete(ctx.chat.id);
            loadTenants();
            return ctx.reply(`✅ Preço atualizado para <b>${finalPrice ? "R$ " + finalPrice.toFixed(2) : "PADRÃO (Global)"}</b>`, { parse_mode: "HTML" });
        }

        // --- WIZARD: ALTERAR PREÇO GLOBAL ---
        if (session.stage === "WAIT_GLOBAL_PRICE") {
            const price = parseFloat(text.replace(",", "."));
            if (isNaN(price)) return ctx.reply("❌ Valor inválido.");

            const { error } = await supabase.from('system_config').upsert({ key: 'default_price', value: String(price) });

            if (error) return ctx.reply(`❌ Erro: ${error.message}`);

            masterSessions.delete(ctx.chat.id);
            return ctx.reply(`✅ <b>Preço Global Atualizado!</b>\nNovo valor: R$ ${price.toFixed(2)}\n\n(Clientes sem preço fixo pagarão este valor na próxima renovação).`, { parse_mode: "HTML" });
        }

        // --- WIZARD: RENOVAR ---
        if (session.stage === "WAIT_RENEW_DAYS") {
            const days = parseInt(text);
            if (isNaN(days)) return ctx.reply("❌ Valor inválido. Digite um número inteiro (ex: 30).");

            const { data: tenant } = await supabase.from('tenants').select('*').eq('id', session.data.id).single();
            let newDate = new Date(tenant.expiration_date || Date.now());
            if (newDate < new Date()) newDate = new Date();
            newDate.setDate(newDate.getDate() + days);

            await supabase.from('tenants').update({ expiration_date: newDate, is_active: true }).eq('id', session.data.id);
            masterSessions.delete(ctx.chat.id);
            loadTenants();
            return ctx.reply(`✅ Renovado por +${days} dias.\nNovo vencimento: <b>${newDate.toLocaleDateString("pt-BR")}</b>`, { parse_mode: "HTML" });
        }
    });

    masterBot.command("meu_id", (ctx) => ctx.reply(`🆔 Seu ID: <code>${ctx.chat.id}</code>`, { parse_mode: "HTML" }));

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
