// ══════════════════════════════════════════════════════════════
//  DeathWish Partner — Discord.js v14 Partner Botu (TEK DOSYA)
// ══════════════════════════════════════════════════════════════
// Bu dosya tamamen bağımsız çalışan tek parça bir bottur.
// Node.js + discord.js v14 + better-sqlite3 + express kullanır.
// ══════════════════════════════════════════════════════════════

require('dotenv').config();

const {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits,
} = require('discord.js');
const Database = require('better-sqlite3');
const express = require('express');

// ──────────────────────────────────────────────────────────────
//  AYARLAR
// ──────────────────────────────────────────────────────────────
const TOKEN = process.env.DISCORD_TOKEN;
const PORT = process.env.PORT || 3000;

// Botun "@Bot partner" komutunu dinleyeceği tek kanal.
const PARTNER_COMMAND_CHANNEL_ID = '1524140987109081229';
// Geçerli partner mesajlarının EMBED olarak loglanacağı kanal.
const PARTNER_LOG_CHANNEL_ID = '1524203801689456800';

// Kullanıcı başına bekleme süresi (3 dakika, milisaniye cinsinden).
const COOLDOWN_MS = 3 * 60 * 1000;

// Botun DM'de göndereceği sabit partner mesajı. Format birebir korunur.
const PARTNER_MESSAGE =
  '˚ ༘✶ Deathwish ϟ\n' +
  '╭━━━━━━━━━━━━━━━━━━━━━━╮\n' +
  '✦ ˚⊹ ₊ Eğlenceli ve toxiclikten uzak bir sunucuyuz.\n' +
  '✦ ˚⊹ ₊ Komik modlar ve aktif olmaya çalışan chat vardır.\n' +
  '✦ ˚⊹ ₊ Yeni bir sunucudur gelişmeye açık bir sunucudur. Sende aramıza katıl.\n' +
  '╰━━━━━━━━━━━━━━━━━━━━━━╮\n' +
  '╰───── ❥ https://discord.gg/XUDVj9R2wE\n' +
  '╰───── ❥ https://cdn.discordapp.com/attachments/1524203614992863452/1524776756785975386/CC__Lelouch.jfif\n' +
  '@everyone ♡! @here';

if (!TOKEN) {
  console.error('⛔ DISCORD_TOKEN bulunamadı! .env dosyasını kontrol et.');
  process.exit(1);
}

// ──────────────────────────────────────────────────────────────
//  VERİTABANI (SQLite — better-sqlite3)
// ──────────────────────────────────────────────────────────────
const db = new Database('deathwish-partner.db');

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
`);

// Yeni bir kırmızı liste kaydı ekler. Aynı invite varsa günceller.
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

// Bir invite'ı kırmızı listeden siler. Silinen kayıt varsa true döner.
function removeBlacklist(invite) {
  const result = db.prepare('DELETE FROM blacklist WHERE invite = ?').run(invite);
  return result.changes > 0;
}

// Kırmızı listedeki tüm kayıtları döner.
function listBlacklist() {
  return db.prepare('SELECT * FROM blacklist ORDER BY createdAt DESC').all();
}

// Verilen invite linkinin kırmızı listede olup olmadığını kontrol eder.
function isBlacklisted(invite) {
  return !!db.prepare('SELECT id FROM blacklist WHERE invite = ?').get(invite);
}

// ──────────────────────────────────────────────────────────────
//  SPAM KORUMASI (SQLite tabanlı — Map/Set kullanılmaz, bellek sızıntısı olmaz)
// ──────────────────────────────────────────────────────────────
// Günde en fazla kaç partner isteği oluşturulabileceği.
const DAILY_PARTNER_LIMIT = 4;

// Kullanıcının mevcut partner durumunu (bekleyen istek var mı, son istek zamanı) döner.
function getPartnerState(userId) {
  return db.prepare('SELECT * FROM partner_state WHERE userId = ?').get(userId) || null;
}

// Kullanıcının bekleyen istek durumunu ve son istek zamanını kaydeder/günceller.
function setPartnerState(userId, pending, lastRequestAt) {
  db.prepare(
    `INSERT INTO partner_state (userId, pending, lastRequestAt) VALUES (?, ?, ?)
     ON CONFLICT(userId) DO UPDATE SET pending = excluded.pending, lastRequestAt = excluded.lastRequestAt`
  ).run(userId, pending ? 1 : 0, lastRequestAt);
}

// Kullanıcının bekleyen isteğini kapatır (DM mesajı işlendikten sonra çağrılır).
function closePendingRequest(userId) {
  db.prepare('UPDATE partner_state SET pending = 0 WHERE userId = ?').run(userId);
}

// Bugünün tarihini YYYY-MM-DD formatında döner (günlük limit sıfırlama anahtarı).
function getTodayKey() {
  return new Date().toISOString().slice(0, 10);
}

// Kullanıcının bugün kaç partner isteği oluşturduğunu döner.
function getDailyRequestCount(userId, dateKey) {
  const row = db.prepare('SELECT count FROM partner_daily_limit WHERE userId = ? AND date = ?').get(userId, dateKey);
  return row ? row.count : 0;
}

// Kullanıcının bugünkü partner istek sayacını 1 artırır (yoksa oluşturur).
function incrementDailyRequestCount(userId, dateKey) {
  db.prepare(
    `INSERT INTO partner_daily_limit (userId, date, count) VALUES (?, ?, 1)
     ON CONFLICT(userId, date) DO UPDATE SET count = count + 1`
  ).run(userId, dateKey);
}

// Kalan bekleme süresini "X dakika Y saniye" formatında döner.
function formatRemaining(ms) {
  const totalSeconds = Math.ceil(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes} dakika ${seconds} saniye`;
}

// ──────────────────────────────────────────────────────────────
//  DAVET LİNKİ TESPİTİ
// ──────────────────────────────────────────────────────────────
// Mesaj içinde discord.gg veya discord.com/invite formatında bir link arar.
// Bulunursa tam eşleşen linki, bulunamazsa null döner.
function extractInviteLink(content) {
  const inviteRegex = /(https?:\/\/)?(www\.)?(discord\.gg\/[a-zA-Z0-9-]+|discord\.com\/invite\/[a-zA-Z0-9-]+)/i;
  const match = content.match(inviteRegex);
  return match ? match[0] : null;
}

// ──────────────────────────────────────────────────────────────
//  EXPRESS WEB SUNUCUSU (Render keepalive)
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

    // ── SUNUCU KANALI: "@Bot partner" komutu ──────────────────
    if (message.guild) {
      if (message.channel.id !== PARTNER_COMMAND_CHANNEL_ID) return;

      const isMentioned = message.mentions.has(client.user);
      const containsPartnerWord = message.content.toLowerCase().includes('partner');
      if (!isMentioned || !containsPartnerWord) return;

      const userId = message.author.id;
      const state = getPartnerState(userId);

      // 1) Zaten bekleyen (henüz DM'den cevap vermediği) bir isteği varsa yenisini açma.
      if (state && state.pending) {
        await message.reply('⏳ Zaten aktif bir partner isteğiniz bulunuyor. Lütfen önce DM üzerinden partner mesajınızı gönderin.');
        return;
      }

      // 2) Günlük limit kontrolü (SQLite'ta saklanır, bot yeniden başlasa bile sıfırlanmaz).
      const todayKey = getTodayKey();
      const dailyCount = getDailyRequestCount(userId, todayKey);
      if (dailyCount >= DAILY_PARTNER_LIMIT) {
        await message.reply(`❌ Bugünkü partner hakkınızı kullandınız. Günlük limit: ${DAILY_PARTNER_LIMIT}/${DAILY_PARTNER_LIMIT}.`);
        return;
      }

      // 3) 3 dakikalık cooldown kontrolü (mevcut özellik, korunuyor).
      const now = Date.now();
      const lastRequestAt = state?.lastRequestAt ? Number(state.lastRequestAt) : null;
      if (lastRequestAt && now - lastRequestAt < COOLDOWN_MS) {
        const remaining = COOLDOWN_MS - (now - lastRequestAt);
        await message.reply(`⏳ Tekrar partner başvurusu yapmadan önce **${formatRemaining(remaining)}** beklemelisin.`);
        return;
      }

      // Tüm kontroller geçildi: isteği "bekleyen" olarak işaretle, cooldown'u güncelle ve günlük sayacı artır.
      setPartnerState(userId, true, String(now));
      incrementDailyRequestCount(userId, todayKey);

      try {
        await message.author.send(PARTNER_MESSAGE);
      } catch (dmError) {
        await message.reply('DM\'ni açmadan partner sistemini kullanamazsın.');
      }
      return;
    }

    // ── DM: Kullanıcının davet linki içeren cevabı ────────────
    if (!message.guild) {
      const userId = message.author.id;
      const state = getPartnerState(userId);

      // Bekleyen isteği yoksa (hiç @Bot partner yazmamış ya da hakkını zaten kullanmış) mesajı kabul etme.
      if (!state || !state.pending) {
        await message.reply('ℹ️ Şu anda aktif bir partner isteğiniz yok. Yeni istek için sunucuda **@Bot partner** yazmalısınız.');
        return;
      }

      // Kullanıcının DM'den gönderebileceği tek mesaj budur — sonuç ne olursa olsun bekleyen istek kapanır.
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

      // Log kanalına, kullanıcının gönderdiği partner mesajını OLDUĞU GİBİ (verbatim) ilet.
      // Embed veya ek alan kullanılmaz — mesaj tam olarak nasılsa öyle atılır.
      const logChannel = await client.channels.fetch(PARTNER_LOG_CHANNEL_ID).catch(() => null);
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
//  SLASH KOMUT İŞLEYİCİSİ
// ──────────────────────────────────────────────────────────────
client.on('interactionCreate', async (interaction) => {
  try {
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
//  BOT GİRİŞİ
// ──────────────────────────────────────────────────────────────
client.login(TOKEN);
