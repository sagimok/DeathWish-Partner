// ══════════════════════════════════════════════════════════════
//  DeathWish Partner — Discord.js v14 Partner Botu (TEK DOSYA)
// ══════════════════════════════════════════════════════════════
// Node.js + discord.js v14 + node:sqlite + express kullanır.
// Bu dosya, index.js + db.js + match.js'in birleştirilmiş halidir.
// ══════════════════════════════════════════════════════════════

require('dotenv').config();

const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  ChannelSelectMenuBuilder,
  ChannelType,
  ButtonBuilder,
  ButtonStyle,
} = require('discord.js');
const express = require('express');

// ══════════════════════════════════════════════════════════════
//  VERİTABANI (eskiden db.js) — Node'un yerleşik node:sqlite modülü
// ══════════════════════════════════════════════════════════════
const dbPath = path.join(__dirname, 'deathwish-partner.db');
const db = new DatabaseSync(dbPath);

db.exec(`
  CREATE TABLE IF NOT EXISTS blacklist (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    invite TEXT UNIQUE,
    reason TEXT,
    createdAt TEXT
  );

  CREATE TABLE IF NOT EXISTS partner_state (
    userId TEXT PRIMARY KEY,
    pending INTEGER NOT NULL DEFAULT 0,
    lastRequestAt TEXT
  );

  CREATE TABLE IF NOT EXISTS partner_daily_limit (
    userId TEXT NOT NULL,
    date TEXT NOT NULL,
    count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (userId, date)
  );

  CREATE TABLE IF NOT EXISTS bot_config (
    key TEXT PRIMARY KEY,
    value TEXT
  );
`);

// ── KIRMIZI LİSTE (blacklist) ──
function addBlacklist(invite, reason) {
  const createdAt = new Date().toISOString();
  const existing = db.prepare('SELECT id FROM blacklist WHERE invite = ?').get(invite);
  if (existing) {
    db.prepare('UPDATE blacklist SET reason = ?, createdAt = ? WHERE invite = ?').run(reason, createdAt, invite);
    return 'updated';
  }
  db.prepare('INSERT INTO blacklist (invite, reason, createdAt) VALUES (?, ?, ?)').run(invite, reason, createdAt);
  return 'inserted';
}
function removeBlacklist(invite) {
  const result = db.prepare('DELETE FROM blacklist WHERE invite = ?').run(invite);
  return result.changes > 0;
}
function listBlacklist() {
  return db.prepare('SELECT * FROM blacklist ORDER BY createdAt DESC').all();
}
function isBlacklisted(invite) {
  return !!db.prepare('SELECT id FROM blacklist WHERE invite = ?').get(invite);
}

// ── PARTNER DURUMU (bekleyen istek / cooldown) ──
function getPartnerState(userId) {
  return db.prepare('SELECT * FROM partner_state WHERE userId = ?').get(userId) || null;
}
function setPartnerState(userId, pending, lastRequestAt) {
  db.prepare(
    `INSERT INTO partner_state (userId, pending, lastRequestAt) VALUES (?, ?, ?)
     ON CONFLICT(userId) DO UPDATE SET pending = excluded.pending, lastRequestAt = excluded.lastRequestAt`
  ).run(userId, pending ? 1 : 0, lastRequestAt);
}
function closePendingRequest(userId) {
  db.prepare('UPDATE partner_state SET pending = 0 WHERE userId = ?').run(userId);
}

// ── GÜNLÜK LİMİT ──
function getDailyRequestCount(userId, dateKey) {
  const row = db.prepare('SELECT count FROM partner_daily_limit WHERE userId = ? AND date = ?').get(userId, dateKey);
  return row ? row.count : 0;
}
function incrementDailyRequestCount(userId, dateKey) {
  db.prepare(
    `INSERT INTO partner_daily_limit (userId, date, count) VALUES (?, ?, 1)
     ON CONFLICT(userId, date) DO UPDATE SET count = count + 1`
  ).run(userId, dateKey);
}

// ── BOT AYARLARI (/setup ile değiştirilir) ──
function getConfigValue(key) {
  const row = db.prepare('SELECT value FROM bot_config WHERE key = ?').get(key);
  return row ? row.value : null;
}
function setConfigValue(key, value) {
  db.prepare(
    `INSERT INTO bot_config (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(key, value);
}

// ══════════════════════════════════════════════════════════════
//  TETİKLEYİCİ KELİME TESPİTİ (eskiden match.js) — fuzzy eşleşme dahil
// ══════════════════════════════════════════════════════════════
// Sadece "partner yetkili" (veya buna çok benzer yazımlar) tetikler —
// "partner" ya da "yetkili" tek başına yeterli değildir.
const TRIGGER_PHRASES_RAW = ['partner yetkili', 'partner dm'];

function normalize(str) {
  return str
    .toLowerCase()
    .replace(/ı/g, 'i')
    .replace(/ş/g, 's')
    .replace(/ğ/g, 'g')
    .replace(/ü/g, 'u')
    .replace(/ö/g, 'o')
    .replace(/ç/g, 'c')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  let prev = new Array(n + 1);
  let curr = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

function maxDistanceFor(length) {
  if (length <= 4) return 1;
  if (length <= 8) return 2;
  return 3;
}

function fuzzyContains(haystack, needle, maxDistance) {
  if (!needle) return false;
  if (haystack.includes(needle)) return true;

  const nLen = needle.length;
  const minSize = Math.max(1, nLen - 2);
  const maxSize = nLen + 2;

  for (let size = minSize; size <= maxSize; size++) {
    for (let i = 0; i + size <= haystack.length; i++) {
      const window = haystack.substr(i, size);
      if (levenshtein(window, needle) <= maxDistance) return true;
    }
  }
  return false;
}

const TRIGGER_PHRASES = TRIGGER_PHRASES_RAW.map((phrase) => {
  const norm = normalize(phrase);
  return { norm, compact: norm.replace(/\s+/g, '') };
});

function messageMatchesPartnerTrigger(content) {
  if (!content) return false;
  const norm = normalize(content);
  if (!norm) return false;
  const compact = norm.replace(/\s+/g, '');

  for (const { norm: phraseNorm, compact: phraseCompact } of TRIGGER_PHRASES) {
    if (norm.includes(phraseNorm)) return true;
    if (fuzzyContains(compact, phraseCompact, maxDistanceFor(phraseCompact.length))) return true;
  }
  return false;
}

// ──────────────────────────────────────────────────────────────
//  AYARLAR
// ──────────────────────────────────────────────────────────────
const TOKEN = process.env.DISCORD_TOKEN;
const PORT = process.env.PORT || 3000;

const PARTNER_COMMAND_CHANNEL_IDS = ['1525062234844303370'];
const DEFAULT_PARTNER_LOG_CHANNEL_ID = '1524203801689456800';
const SETUP_ROLE_ID = '1524107651510702160';

// Mesajda bu rol etiketlenmezse (@rol) partner sistemi bu kanalda tetiklenmez.
const PARTNER_TRIGGER_ROLE_ID = '1524399674688274583';

const COOLDOWN_MS = 3 * 60 * 1000;
const DAILY_PARTNER_LIMIT = 4;

// Buton onayı bekleyen kullanıcılar: userId → { now, todayKey }
// State ve sayaç YALNIZCA "Evet" butonuna basılınca yazılır.
const pendingConfirmations = new Map();

const DEFAULT_PARTNER_MESSAGE =
  '✦˚ ༘✶ **Deathwish** ϟ\n\n' +
  '╭───────────── ❥\n\n' +
  '✦ ₊ **Kendimize ait özel bot sistemleri** ile farklı bir Discord deneyimi.\n\n' +
  '✦ ₊ **Partner sistemi**, etkinlikler ve sürekli gelişen özellikler.\n\n' +
  '✦ ₊ Aktif sohbet, eğlenceli üyeler ve saygılı bir ortam.\n\n' +
  '✦ ₊ Sürekli güncellenen komutlar, görevler ve özel sistemler.\n\n' +
  '✦ ₊ Toxiclikten uzak, kaliteli bir topluluk oluşturmayı hedefliyoruz.\n\n' +
  '✦ ₊ Yeni açılmış ve her geçen gün büyüyen bir sunucu.\n\n' +
  '> İlk üyelerden biri olup gelişimimize ortak ol!\n>\n' +
  '╰───────────── ❥ **Aramıza Katıl!**\n\n' +
  '・https://discord.gg/XUDVj9R2wE\n\n' +
  '・https://cdn.discordapp.com/attachments/1525921244271345826/1526688439108501645/880b88af3f08dceced216e76a629b1e4.jpg?ex=6a57eee8&is=6a569d68&hm=d15dbff53ae43e11d9b76694586ec39ed03abc94d7702d35710def2fc2178a3b&\n\n' +
  '♡**Deathwish seni bekliyor.**\n' +
  '@everyone ♡! @here';

if (!TOKEN) {
  console.error('⛔ DISCORD_TOKEN bulunamadı! Ortam değişkenlerini kontrol et.');
  process.exit(1);
}

function getPartnerMessage() {
  return getConfigValue('partner_message') || DEFAULT_PARTNER_MESSAGE;
}
function getLogChannelId() {
  return getConfigValue('log_channel_id') || DEFAULT_PARTNER_LOG_CHANNEL_ID;
}

// ──────────────────────────────────────────────────────────────
//  ROL KONTROL YARDIMCISI
//  GuildMembers intent olmadığında interaction.member.roles
//  bir Collection değil düz string[] dizisi olarak gelebilir.
//  Her iki durumu da destekler.
// ──────────────────────────────────────────────────────────────
function memberHasRole(interaction, roleId) {
  const roles = interaction.member?.roles;
  if (!roles) return false;
  // GuildMember.roles → GuildMemberRoleManager (Collection ile .cache.has())
  if (typeof roles.cache?.has === 'function') return roles.cache.has(roleId);
  // APIInteractionGuildMember.roles → string[]
  if (Array.isArray(roles)) return roles.includes(roleId);
  return false;
}

// ──────────────────────────────────────────────────────────────
//  DAVET LİNKİ TESPİTİ
// ──────────────────────────────────────────────────────────────
function extractInviteLink(content) {
  const inviteRegex = /(https?:\/\/)?(www\.)?(discord\.gg\/[a-zA-Z0-9-]+|discord\.com\/invite\/[a-zA-Z0-9-]+)/i;
  const match = content.match(inviteRegex);
  return match ? match[0] : null;
}
function getTodayKey() {
  return new Date().toISOString().slice(0, 10);
}
function formatRemaining(ms) {
  const totalSeconds = Math.ceil(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes} dakika ${seconds} saniye`;
}

// ──────────────────────────────────────────────────────────────
//  EXPRESS WEB SUNUCUSU (keepalive)
// ──────────────────────────────────────────────────────────────
const app = express();
app.get('/', (_req, res) => res.send('Bot Aktif'));
app.listen(PORT, () => console.log(`🌐 Web sunucusu ${PORT} portunda çalışıyor.`));

// ──────────────────────────────────────────────────────────────
//  DISCORD CLIENT
// ──────────────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel, Partials.Message],
});

// ──────────────────────────────────────────────────────────────
//  CLIENT HATA / BAĞLANTI KOPMA DİNLEYİCİLERİ
//  Bunlar olmadan gateway bağlantısı sessizce kopabilir: process
//  (ve dolayısıyla Render'daki express sunucusu) ayakta kalmaya
//  devam eder ama bot Discord'da "offline" görünür.
// ──────────────────────────────────────────────────────────────
client.on('error', (err) => console.error('⛔ Client error:', err));
client.on('shardError', (err, shardId) => console.error(`⛔ Shard ${shardId} error:`, err));
client.on('shardDisconnect', (event, shardId) => console.warn(`⚠️ Shard ${shardId} koptu (code: ${event?.code}).`));
client.on('shardReconnecting', (shardId) => console.log(`🔄 Shard ${shardId} yeniden bağlanmayı deniyor...`));
client.on('shardResume', (shardId) => console.log(`✅ Shard ${shardId} bağlantısı yeniden kuruldu.`));

// ──────────────────────────────────────────────────────────────
//  SLASH KOMUTLARI TANIMI
// ──────────────────────────────────────────────────────────────
const commands = [
  new SlashCommandBuilder()
    .setName('kirmiziliste')
    .setDescription('Kırmızı liste (blacklist) yönetimi')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand((sub) =>
      sub
        .setName('ekle')
        .setDescription('Kırmızı listeye bir sunucu davet linki ekler')
        .addStringOption((opt) => opt.setName('link').setDescription('Discord davet linki').setRequired(true))
        .addStringOption((opt) => opt.setName('sebep').setDescription('Kırmızı listeye ekleme sebebi').setRequired(true))
    )
    .addSubcommand((sub) =>
      sub
        .setName('sil')
        .setDescription('Kırmızı listeden bir sunucu davet linkini siler')
        .addStringOption((opt) => opt.setName('link').setDescription('Discord davet linki').setRequired(true))
    )
    .addSubcommand((sub) => sub.setName('liste').setDescription('Kırmızı listedeki tüm kayıtları gösterir'))
    .toJSON(),
  new SlashCommandBuilder()
    .setName('setup')
    .setDescription('Partner mesajını ve mesajların düşeceği kanalı ayarla (sadece yetkili rolü)')
    .toJSON(),
];

// ──────────────────────────────────────────────────────────────
//  SLASH KOMUTLARINI REST API İLE OTOMATİK REGISTER ETME
// ──────────────────────────────────────────────────────────────
async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  try {
    console.log('🔄 Slash komutları register ediliyor...');
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
    console.log('✅ Slash komutları başarıyla register edildi.');
  } catch (err) {
    console.error('⛔ Slash komutları register edilirken hata oluştu:', err);
  }
}

// ──────────────────────────────────────────────────────────────
//  CLIENT READY
// ──────────────────────────────────────────────────────────────
client.once('ready', async () => {
  console.log(`✅ ${client.user.tag} olarak giriş yapıldı.`);
  await registerCommands();
});

// ──────────────────────────────────────────────────────────────
//  MESAJ DİNLEME (Sunucu kanalı + DM)
// ──────────────────────────────────────────────────────────────
client.on('messageCreate', async (message) => {
  try {
    if (message.author.bot) return;

    // ── SUNUCU KANALI: partner tetikleyici kelime/ifade ───────
    if (message.guild) {
      if (!PARTNER_COMMAND_CHANNEL_IDS.includes(message.channel.id)) return;
      // Bu kanalda tetikleyici: mesajda belirtilen rolün etiketlenmesi (@rol) yeterlidir.
      const mentionsTriggerRole = message.mentions.roles.has(PARTNER_TRIGGER_ROLE_ID);
      if (!mentionsTriggerRole) return;

      const userId = message.author.id;
      const state = getPartnerState(userId);

      if (state && state.pending) {
        await message.reply('⏳ Zaten aktif bir partner isteğiniz bulunuyor. Lütfen önce DM üzerinden partner mesajınızı gönderin.');
        return;
      }

      const todayKey = getTodayKey();
      const dailyCount = getDailyRequestCount(userId, todayKey);
      if (dailyCount >= DAILY_PARTNER_LIMIT) {
        await message.reply(`❌ Bugünkü partner hakkınızı kullandınız. Günlük limit: ${DAILY_PARTNER_LIMIT}/${DAILY_PARTNER_LIMIT}.`);
        return;
      }

      const now = Date.now();
      const lastRequestAt = state?.lastRequestAt ? Number(state.lastRequestAt) : null;
      if (lastRequestAt && now - lastRequestAt < COOLDOWN_MS) {
        const remaining = COOLDOWN_MS - (now - lastRequestAt);
        await message.reply(`⏳ Tekrar partner başvurusu yapmadan önce **${formatRemaining(remaining)}** beklemelisin.`);
        return;
      }

      // State henüz yazılmıyor — kullanıcı önce onay butonuna basmalı
      pendingConfirmations.set(userId, { now, todayKey });

      const yesBtn = new ButtonBuilder()
        .setCustomId(`partner_yes:${userId}`)
        .setLabel('✅ Evet')
        .setStyle(ButtonStyle.Success);

      const noBtn = new ButtonBuilder()
        .setCustomId(`partner_no:${userId}`)
        .setLabel('❌ Hayır')
        .setStyle(ButtonStyle.Danger);

      const row = new ActionRowBuilder().addComponents(yesBtn, noBtn);

      await message.reply({
        content: `👋 ${message.author}, partner işlemini **benimle** yapmak ister misin?`,
        components: [row],
      });
      return;
    }

    // ── DM: Kullanıcının davet linki içeren cevabı ────────────
    if (!message.guild) {
      const userId = message.author.id;
      const state = getPartnerState(userId);

      if (!state || !state.pending) {
        await message.reply(
          'ℹ️ Şu anda aktif bir partner isteğiniz yok. Yeni istek için partner kanalında "partner" ile ilgili bir ifade yazmalısınız.'
        );
        return;
      }

      closePendingRequest(userId);

      const inviteLink = extractInviteLink(message.content);

      if (!inviteLink) {
        await message.reply('❌ Attığınız mesajda Discord davet bağlantısı bulunamadı.');
        return;
      }

      if (isBlacklisted(inviteLink)) {
        await message.reply('🚫 Bu sunucu kırmızı listededir.');
        return;
      }

      const logChannel = await client.channels.fetch(getLogChannelId()).catch(() => null);
      if (logChannel) {
        await logChannel.send({
          content: message.content,
          allowedMentions: { parse: [] },
        });
      }

      await message.reply('✅ Partner mesajınız başarıyla yetkililere iletildi.');
    }
  } catch (err) {
    console.error('⛔ messageCreate işlenirken hata oluştu:', err);
  }
});

// ──────────────────────────────────────────────────────────────
//  ETKİLEŞİM İŞLEYİCİSİ (slash komutlar, modal, seçim menüsü)
// ──────────────────────────────────────────────────────────────
client.on('interactionCreate', async (interaction) => {
  try {
    // ── /setup ───────────────────────────────────────────────
    if (interaction.isChatInputCommand() && interaction.commandName === 'setup') {
      if (!memberHasRole(interaction, SETUP_ROLE_ID)) {
        await interaction.reply({ content: '⛔ Bu komutu kullanmak için gerekli role sahip değilsin.', ephemeral: true });
        return;
      }

      const modal = new ModalBuilder().setCustomId('setup_partner_message_modal').setTitle('Partner Mesajını Ayarla');

      const textInput = new TextInputBuilder()
        .setCustomId('partner_message_input')
        .setLabel('Partner mesajı (gif ve discord linki desteklenir)')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
        .setMaxLength(4000)
        .setValue(getPartnerMessage().slice(0, 4000));

      modal.addComponents(new ActionRowBuilder().addComponents(textInput));

      await interaction.showModal(modal);
      return;
    }

    // ── Modal: partner mesajı kaydedildi, kanal seçimi ───────
    if (interaction.isModalSubmit() && interaction.customId === 'setup_partner_message_modal') {
      const newMessage = interaction.fields.getTextInputValue('partner_message_input');
      setConfigValue('partner_message', newMessage);

      const channelSelect = new ChannelSelectMenuBuilder()
        .setCustomId('setup_log_channel_select')
        .setPlaceholder('Partner mesajlarının düşeceği kanalı seç')
        .setChannelTypes([ChannelType.GuildText, ChannelType.GuildAnnouncement]);

      const row = new ActionRowBuilder().addComponents(channelSelect);

      await interaction.reply({
        content: '✅ Partner mesajı kaydedildi. Şimdi partner mesajlarının hangi kanala düşeceğini seç:',
        components: [row],
        ephemeral: true,
      });
      return;
    }

    // ── Kanal seçimi tamamlandı ───────────────────────────────
    if (interaction.isChannelSelectMenu() && interaction.customId === 'setup_log_channel_select') {
      const channelId = interaction.values[0];
      setConfigValue('log_channel_id', channelId);

      await interaction.update({
        content: `✅ Kurulum tamamlandı! Partner mesajları artık <#${channelId}> kanalına düşecek.`,
        components: [],
      });
      return;
    }

    // ── Partner onay butonları ────────────────────────────────
    if (interaction.isButton()) {
      const [action, ownerId] = interaction.customId.split(':');
      if (action !== 'partner_yes' && action !== 'partner_no') return;

      // Sadece butonu tetikleyen kullanıcı basabilir
      if (interaction.user.id !== ownerId) {
        await interaction.reply({ content: '⛔ Bu buton sana ait değil.', ephemeral: true });
        return;
      }

      // Discord, butona basıldıktan sonra 3 saniye içinde bir yanıt (ack)
      // bekler. Aşağıda DB işlemleri + kullanıcıya DM atma denemesi
      // (network isteği) olduğu için bu süre kolayca aşılabilir ve
      // interaction.update() "Unknown interaction" (10062) hatası
      // fırlatabilir. Bunu önlemek için EN BAŞTA deferUpdate() ile
      // hemen ack veriyoruz, geri kalan her şeyi editReply() ile
      // güncelliyoruz (editReply'nin 3sn sınırı yoktur, 15 dakikaya
      // kadar geçerlidir).
      await interaction.deferUpdate();

      if (action === 'partner_no') {
        pendingConfirmations.delete(ownerId);
        await interaction.editReply({ content: '❌ Partner işlemi iptal edildi.', components: [] });
        return;
      }

      // Evet — onay verildi
      const pending = pendingConfirmations.get(ownerId);
      if (!pending) {
        await interaction.editReply({ content: '⚠️ Bu istek zaten işlendi veya süresi doldu.', components: [] });
        return;
      }
      pendingConfirmations.delete(ownerId);

      const { now, todayKey } = pending;
      setPartnerState(ownerId, true, String(now));
      incrementDailyRequestCount(ownerId, todayKey);

      try {
        const user = await interaction.client.users.fetch(ownerId);
        await user.send(getPartnerMessage());
        await interaction.editReply({
          content: `📩 <@${ownerId}>, DM üzerinden partner mesajı gönderildi! Lütfen DM'lerini kontrol et ve davet linkini oradan gönder.`,
          components: [],
        });
      } catch {
        // Kullanıcının DM'leri kapalıysa (ya da DM gönderimi başka bir
        // sebeple başarısız olursa) buraya düşer: state geri alınır ve
        // kullanıcıya DM'lerinin kapalı olduğu açıkça söylenir.
        setPartnerState(ownerId, false, String(now));
        await interaction.editReply({
          content: `❌ <@${ownerId}>, DM'lerin kapalı olduğu için partner mesajı gönderilemedi. Lütfen sunucu ayarlarından bu sunucudan gelen DM'lere izin ver ve tekrar dene.`,
          components: [],
        });
      }
      return;
    }

    // ── /kirmiziliste ─────────────────────────────────────────
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName !== 'kirmiziliste') return;

    if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
      await interaction.reply({ content: '⛔ Bu komutu kullanmak için Administrator yetkisine sahip olmalısın.', ephemeral: true });
      return;
    }

    const sub = interaction.options.getSubcommand();

    if (sub === 'ekle') {
      const link = interaction.options.getString('link');
      const reason = interaction.options.getString('sebep');
      const result = addBlacklist(link, reason);
      const action = result === 'updated' ? 'güncellendi' : 'eklendi';
      await interaction.reply({ content: `✅ **${link}** kırmızı listeye ${action}.\nSebep: ${reason}`, ephemeral: true });
      return;
    }

    if (sub === 'sil') {
      const link = interaction.options.getString('link');
      const removed = removeBlacklist(link);
      if (!removed) {
        await interaction.reply({ content: `⚠️ **${link}** kırmızı listede bulunamadı.`, ephemeral: true });
        return;
      }
      await interaction.reply({ content: `✅ **${link}** kırmızı listeden silindi.`, ephemeral: true });
      return;
    }

    if (sub === 'liste') {
      const rows = listBlacklist();
      if (rows.length === 0) {
        await interaction.reply({ content: 'ℹ️ Kırmızı liste şu anda boş.', ephemeral: true });
        return;
      }

      const embed = new EmbedBuilder()
        .setTitle('🚫 Kırmızı Liste')
        .setColor(0xed4245)
        .setDescription(
          rows
            .map(
              (row, i) =>
                `**${i + 1}.** ${row.invite}\n└ Sebep: ${row.reason}\n└ Eklenme: ${new Date(row.createdAt).toLocaleString('tr-TR')}`
            )
            .join('\n\n')
        )
        .setTimestamp();

      await interaction.reply({ embeds: [embed], ephemeral: true });
    }
  } catch (err) {
    console.error('⛔ interactionCreate işlenirken hata oluştu:', err);
  }
});

// ──────────────────────────────────────────────────────────────
//  HATA YÖNETİMİ
// ──────────────────────────────────────────────────────────────
process.on('unhandledRejection', (reason) => {
  console.error('⛔ UnhandledRejection:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('⛔ UncaughtException:', err);
});

// ──────────────────────────────────────────────────────────────
//  WATCHDOG — client.isReady() false ise process'i sonlandırır.
//  Render, process çöktüğünde otomatik olarak yeniden başlatır.
//  Bu sayede "process yaşıyor ama Discord'a bağlı değil" (Render'da
//  live, Discord'da offline) durumu kalıcı hale gelmez.
// ──────────────────────────────────────────────────────────────
setInterval(() => {
  if (!client.isReady()) {
    console.error('⛔ Client Discord\'a bağlı değil, process yeniden başlatılmak üzere sonlandırılıyor.');
    process.exit(1);
  }
}, 60_000);

// ──────────────────────────────────────────────────────────────
//  BOT GİRİŞİ
// ──────────────────────────────────────────────────────────────
client.login(TOKEN);
