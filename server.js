require("dotenv").config();

const express = require("express");
const path = require("path");
const {
  Client,
  GatewayIntentBits,
  ChannelType,
  PermissionsBitField
} = require("discord.js");

const app = express();

const BOT_TOKEN = process.env.BOT_TOKEN;
const GUILD_ID = process.env.GUILD_ID;
const PANEL_PASSWORD = process.env.PANEL_PASSWORD || "1234";
const PORT = process.env.PORT || 3000;

const MAX_CHANNELS = 500;
const MAX_MESSAGES_PER_CHANNEL = 50;

let client = null;
let clientReady = false;

if (BOT_TOKEN) {
  try {
    client = new Client({
      intents: [GatewayIntentBits.Guilds]
    });

    client.once("ready", () => {
      clientReady = true;
      console.log(`[NUKE] Bot Discord online como ${client.user.tag}`);
    });

    client.login(BOT_TOKEN).catch(err => {
      console.warn("[NUKE] Falha ao logar bot via BOT_TOKEN do .env:", err.message);
    });
  } catch (err) {
    console.warn("[NUKE] Erro ao instanciar discord.js client:", err.message);
  }
} else {
  console.log("[NUKE] BOT_TOKEN não configurado no .env. O painel aceitará o token via frontend/login.");
}

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

function getToken(req) {
  return req.headers["x-bot-token"] || BOT_TOKEN || "";
}

function getGuildId(req) {
  return req.headers["x-guild-id"] || req.body?.guildId || GUILD_ID || "";
}

function checkPassword(req, res, next) {
  const password = req.headers["x-panel-password"];

  if (PANEL_PASSWORD && password && password !== PANEL_PASSWORD) {
    return res.status(401).json({
      ok: false,
      message: "Senha do painel incorreta."
    });
  }

  next();
}

async function discordRestFetch(endpoint, options = {}, token) {
  if (!token) {
    throw new Error("Token do bot não fornecido.");
  }

  const url = `https://discord.com/api/v10${endpoint}`;
  const headers = {
    Authorization: `Bot ${token}`,
    "Content-Type": "application/json",
    ...(options.headers || {})
  };

  const response = await fetch(url, {
    ...options,
    headers
  });

  if (response.status === 204) {
    return null;
  }

  const data = await response.json().catch(() => null);

  if (!response.ok) {
    const errorMsg = data?.message || `Discord API HTTP ${response.status}`;
    throw new Error(errorMsg);
  }

  return data;
}

// Rota de login
app.post("/api/login", checkPassword, async (req, res) => {
  const token = getToken(req);
  let botData = null;

  if (clientReady && client?.user) {
    botData = {
      tag: client.user.tag,
      username: client.user.username,
      avatar: client.user.displayAvatarURL ? client.user.displayAvatarURL() : null,
      id: client.user.id
    };
  } else if (token) {
    try {
      const user = await discordRestFetch("/users/@me", { method: "GET" }, token);
      if (user) {
        botData = {
          tag: `${user.username}${user.discriminator && user.discriminator !== '0' ? '#' + user.discriminator : ''}`,
          username: user.username,
          avatar: user.avatar ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png` : null,
          id: user.id
        };
      }
    } catch {
      // continua sem quebrar
    }
  }

  res.json({
    ok: true,
    message: "Login autorizado.",
    bot: botData
  });
});

// Validação ultrarrápida de token
app.post("/api/validate-token", async (req, res) => {
  const token = req.body?.token || getToken(req);
  if (!token) {
    return res.status(400).json({ ok: false, message: "Token não fornecido." });
  }

  try {
    const user = await discordRestFetch("/users/@me", { method: "GET" }, token);
    return res.json({
      ok: true,
      message: "Token válido.",
      bot: {
        tag: `${user.username}${user.discriminator && user.discriminator !== '0' ? '#' + user.discriminator : ''}`,
        username: user.username,
        avatar: user.avatar ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png` : null,
        id: user.id
      }
    });
  } catch (error) {
    return res.status(401).json({
      ok: false,
      message: `Token inválido: ${error.message}`
    });
  }
});

async function getGuild(guildId) {
  if (!clientReady || !client) {
    return null;
  }
  const guild = await client.guilds.fetch(guildId);
  const me = await guild.members.fetchMe();

  if (!me.permissions.has(PermissionsBitField.Flags.ManageChannels)) {
    throw new Error("O bot precisa da permissão Gerenciar Canais.");
  }

  return guild;
}

async function changeServerName(newName, req) {
  const safeName = String(newName || "").trim();

  if (safeName.length < 2 || safeName.length > 100) {
    throw new Error("O nome do servidor precisa ter entre 2 e 100 caracteres.");
  }

  const token = getToken(req);
  const guildId = getGuildId(req);

  if (!guildId) {
    throw new Error("ID do servidor (Guild ID) não configurado.");
  }

  // Tentar via client.js se disponível
  try {
    const guild = await getGuild(guildId);
    if (guild) {
      const me = await guild.members.fetchMe();
      if (!me.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
        throw new Error("O bot precisa da permissão Gerenciar Servidor.");
      }
      await guild.setName(safeName, "Nome alterado pelo painel Thiagtf.");
      return { newName: safeName };
    }
  } catch (err) {
    if (!token) throw err;
  }

  // Fallback via Discord REST API v10
  await discordRestFetch(`/guilds/${guildId}`, {
    method: "PATCH",
    body: JSON.stringify({ name: safeName })
  }, token);

  return { newName: safeName };
}

async function deleteChannelsByType(type, req) {
  const token = getToken(req);
  const guildId = getGuildId(req);

  if (!guildId) {
    throw new Error("ID do servidor (Guild ID) não configurado.");
  }

  let channelList = [];

  // Tenta pelo Discord.js se o client estiver pronto
  if (clientReady && client) {
    try {
      const guild = await getGuild(guildId);
      if (guild) {
        const channels = await guild.channels.fetch();
        channelList = Array.from(channels.values()).filter(channel => {
          if (!channel) return false;
          if (type === "text") return channel.type === ChannelType.GuildText;
          if (type === "voice") return channel.type === ChannelType.GuildVoice;
          if (type === "all") return channel.type === ChannelType.GuildText || channel.type === ChannelType.GuildVoice;
          return false;
        }).map(c => ({ id: c.id, name: c.name, channelObj: c }));
      }
    } catch {
      channelList = [];
    }
  }

  // Fallback para REST se lista estiver vazia
  if (channelList.length === 0 && token) {
    const rawChannels = await discordRestFetch(`/guilds/${guildId}/channels`, { method: "GET" }, token);
    channelList = (rawChannels || []).filter(channel => {
      if (!channel) return false;
      // Discord channel types: 0 = GUILD_TEXT, 2 = GUILD_VOICE
      if (type === "text") return channel.type === 0;
      if (type === "voice") return channel.type === 2;
      if (type === "all") return channel.type === 0 || channel.type === 2;
      return false;
    }).map(c => ({ id: c.id, name: c.name }));
  }

  let deleted = 0;
  const errors = [];
  
  // Concorrência rápida em lotes de 15 sem sleeps desnecessários
  const batchSize = 15;

  for (let i = 0; i < channelList.length; i += batchSize) {
    const batch = channelList.slice(i, i + batchSize);

    const results = await Promise.allSettled(
      batch.map(item => {
        if (item.channelObj && typeof item.channelObj.delete === "function") {
          return item.channelObj.delete("Ação feita pelo painel Thiagtf.");
        }
        return discordRestFetch(`/channels/${item.id}`, { method: "DELETE" }, token);
      })
    );

    results.forEach((result, index) => {
      if (result.status === "fulfilled") {
        deleted++;
      } else {
        errors.push(`${batch[index].name}: ${result.reason?.message || "erro"}`);
      }
    });
  }

  return {
    deleted,
    errors
  };
}

async function createTextChannels({ amount, baseName, message, messageAmount }, req) {
  const token = getToken(req);
  const guildId = getGuildId(req);

  if (!guildId) {
    throw new Error("ID do servidor (Guild ID) não configurado.");
  }

  const safeAmount = Math.min(Math.max(Number(amount), 1), MAX_CHANNELS);
  const safeMessageAmount = Math.min(
    Math.max(Number(messageAmount), 0),
    MAX_MESSAGES_PER_CHANNEL
  );

  const created = [];
  const createdChannelIds = [];
  const errors = [];

  let guild = null;
  if (clientReady && client) {
    try {
      guild = await getGuild(guildId);
    } catch {
      guild = null;
    }
  }

  // Criação PARALELA simultânea de todos os canais solicitados (Super rápido)
  const channelCreationTasks = [];
  for (let i = 1; i <= safeAmount; i++) {
    const chName = `${baseName}-${i}`;
    if (guild) {
      channelCreationTasks.push(
        guild.channels.create({
          name: chName,
          type: ChannelType.GuildText,
          reason: "Canais criados pelo painel Thiagtf."
        }).then(ch => ({ id: ch.id, name: ch.name }))
      );
    } else {
      channelCreationTasks.push(
        discordRestFetch(`/guilds/${guildId}/channels`, {
          method: "POST",
          body: JSON.stringify({
            name: chName,
            type: 0 // GuildText
          })
        }, token).then(ch => ({ id: ch.id, name: ch.name }))
      );
    }
  }

  const creationResults = await Promise.allSettled(channelCreationTasks);
  creationResults.forEach((res, idx) => {
    if (res.status === "fulfilled" && res.value?.id) {
      created.push(res.value.name);
      createdChannelIds.push(res.value.id);
    } else {
      errors.push(`Canal ${idx + 1}: ${res.reason?.message || "falha ao criar"}`);
    }
  });

  // Disparo PARALELO de mensagens em todos os canais criados (Sem travar em loop sequencial)
  if (message && safeMessageAmount > 0 && createdChannelIds.length > 0) {
    const msgTasks = [];
    for (const channelId of createdChannelIds) {
      for (let m = 1; m <= safeMessageAmount; m++) {
        msgTasks.push(
          discordRestFetch(`/channels/${channelId}/messages`, {
            method: "POST",
            body: JSON.stringify({ content: message })
          }, token).catch(err => {
            errors.push(`Mensagem no canal ${channelId}: ${err.message}`);
          })
        );
      }
    }
    await Promise.allSettled(msgTasks);
  }

  return {
    created,
    errors
  };
}

app.post("/api/delete-text", checkPassword, async (req, res) => {
  try {
    const result = await deleteChannelsByType("text", req);

    res.json({
      ok: true,
      message: `Canais de texto apagados: ${result.deleted}`,
      result
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      message: error.message
    });
  }
});

app.post("/api/delete-voice", checkPassword, async (req, res) => {
  try {
    const result = await deleteChannelsByType("voice", req);

    res.json({
      ok: true,
      message: `Canais de voz apagados: ${result.deleted}`,
      result
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      message: error.message
    });
  }
});

app.post("/api/delete-all", checkPassword, async (req, res) => {
  try {
    const result = await deleteChannelsByType("all", req);

    res.json({
      ok: true,
      message: `Canais de texto e voz apagados: ${result.deleted}`,
      result
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      message: error.message
    });
  }
});

app.post("/api/create-text", checkPassword, async (req, res) => {
  try {
    const { amount, baseName, message, messageAmount } = req.body;

    if (!baseName || baseName.length < 2) {
      return res.status(400).json({
        ok: false,
        message: "Digite um nome base para os canais."
      });
    }

    const result = await createTextChannels({
      amount,
      baseName,
      message,
      messageAmount
    }, req);

    res.json({
      ok: true,
      message: `Canais criados: ${result.created.length}`,
      result
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      message: error.message
    });
  }
});

app.post("/api/change-server-name", checkPassword, async (req, res) => {
  try {
    const { newName } = req.body;

    const result = await changeServerName(newName, req);

    res.json({
      ok: true,
      message: `Nome do servidor alterado para: ${result.newName}`,
      result
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      message: error.message
    });
  }
});

app.post("/api/reset", checkPassword, async (req, res) => {
  try {
    const { amount, baseName, message, messageAmount, newName } = req.body;

    if (!baseName || baseName.length < 2) {
      return res.status(400).json({
        ok: false,
        message: "Digite o nome base dos novos canais."
      });
    }

    // 1. Renomeia se nome foi especificado
    let renamed = null;
    if (newName && String(newName).trim().length >= 2) {
      renamed = await changeServerName(newName, req);
    }

    // 2. Apaga canais de texto e voz de forma rápida e simultânea
    const deletedAll = await deleteChannelsByType("all", req);

    // 3. Cria novos canais e dispara mensagens em paralelo
    const created = await createTextChannels({
      amount,
      baseName,
      message,
      messageAmount
    }, req);

    res.json({
      ok: true,
      message: "Reset concluído com sucesso e velocidade máxima.",
      result: {
        ordem: [
          "1 - Nome do servidor alterado",
          "2 - Canais de texto e voz apagados em paralelo",
          "3 - Canais de texto criados em paralelo",
          "4 - Mensagens enviadas em paralelo"
        ],
        renamed,
        deleted: deletedAll.deleted,
        created: created.created.length,
        errors: [...(deletedAll.errors || []), ...(created.errors || [])]
      }
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      message: error.message
    });
  }
});

// Fallback SPA para todas as rotas não-API
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Iniciar servidor se não estiver sendo importado pelo Vercel
if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`[NUKE] Painel rodando em http://localhost:${PORT}`);
  });
}

module.exports = app;