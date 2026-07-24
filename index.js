/*
 * DeathWish — Discord.js v14 multi-guild partner bot
 *
 * Required environment variables:
 *   DISCORD_TOKEN
 *   BACKUP_MASTER_ENCRYPTION_KEY
 *   GITHUB_OWNER
 *   GITHUB_REPO_2        (encrypted backup repository)
 *   GITHUB_TOKEN
 *   GITHUB_BRANCH       (optional, defaults to main)
 *   BOT_OWNER_ID        (optional, defaults to the original DeathWish owner)
 *   PORT                (optional, defaults to 3000)
 *
 * The database and every GitHub backup are guild-scoped. Never commit the
 * .db file, this file with secrets added, or an environment file.
 */

try {
  require('dotenv').config();
} catch {
  // dotenv is optional when the host already injects environment variables.
}

const crypto = require('node:crypto');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const express = require('express');
const {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
  REST,
  Routes,
  SlashCommandBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  ChannelSelectMenuBuilder,
  StringSelectMenuBuilder,
  ChannelType,
  ButtonBuilder,
  ButtonStyle,
} = require('discord.js');

const BOT_OWNER_ID = process.env.BOT_OWNER_ID || '923263340325781515';
const TOKEN = process.env.DISCORD_TOKEN;
const PORT = Number(process.env.PORT || 3000);
const COOLDOWN_MS = 3 * 60 * 1000;
const DAILY_PARTNER_LIMIT = 4;
const MAX_BACKUP_PASSWORD_ATTEMPTS = 10;

const DEFAULT_PARTNER_MESSAGE =
  '✦˚ ༘✶ **DeathWish** ϟ\n\n' +
  '╭───────────── ❥\n\n' +
  '✦ ₊ **Kendimize ait özel bot sistemleri** ile farklı bir Discord deneyimi.\n\n' +
  '✦ ₊ **Partner sistemi**, etkinlikler ve sürekli gelişen özellikler.\n\n' +
  '✦ ₊ Aktif sohbet, eğlenceli üyeler ve saygılı bir ortam.\n\n' +
  '> İlk üyelerden biri olup gelişimimize ortak ol!\n>\n' +
  '╰───────────── ❥ **Aramıza Katıl!**\n\n' +
  '♡**DeathWish seni bekliyor.**';

if (!TOKEN) {
  throw new Error('DISCORD_TOKEN ortam değişkeni bulunamadı.');
}

const db = new DatabaseSync(path.join(__dirname, 'deathwish-partner.db'));

// New table names deliberately avoid colliding with the old single-guild
// database tables. A user can replace this index without losing old data.
db.exec(`
  CREATE TABLE IF NOT EXISTS guild_settings (
    guildId TEXT PRIMARY KEY,
    setupCompleted INTEGER NOT NULL DEFAULT 0,
    partnerMessage TEXT NOT NULL DEFAULT '',
    partnerTriggerChannelId TEXT,
    partnerLogChannelId TEXT,
    partnerRankingChannelId TEXT,
    hakkimdaChannelId TEXT,
    partnerCommandChannelId TEXT,
    autoPartnerEnabled INTEGER NOT NULL DEFAULT 1,
    partnerMessageEnabled INTEGER NOT NULL DEFAULT 1,
    partnerGifEnabled INTEGER NOT NULL DEFAULT 1,
    partnerLinkEnabled INTEGER NOT NULL DEFAULT 1,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS guild_permissions (
    guildId TEXT NOT NULL,
    userId TEXT NOT NULL,
    permission TEXT NOT NULL,
    grantedBy TEXT NOT NULL,
    createdAt TEXT NOT NULL,
    PRIMARY KEY (guildId, userId, permission)
  );

  CREATE TABLE IF NOT EXISTS guild_partner_stats (
    guildId TEXT NOT NULL,
    userId TEXT NOT NULL,
    totalPartners INTEGER NOT NULL DEFAULT 0,
    lastPartnerAt TEXT,
    PRIMARY KEY (guildId, userId)
  );

  CREATE TABLE IF NOT EXISTS guild_partner_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guildId TEXT NOT NULL,
    userId TEXT NOT NULL,
    partnerServerName TEXT NOT NULL,
    partnerInvite TEXT NOT NULL,
    createdAt TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS guild_profile_messages (
    guildId TEXT NOT NULL,
    userId TEXT NOT NULL,
    messageId TEXT NOT NULL,
    channelId TEXT NOT NULL,
    PRIMARY KEY (guildId, userId)
  );

  CREATE TABLE IF NOT EXISTS guild_partner_state (
    guildId TEXT NOT NULL,
    userId TEXT NOT NULL,
    pending INTEGER NOT NULL DEFAULT 0,
    lastRequestAt TEXT,
    PRIMARY KEY (guildId, userId)
  );

  CREATE TABLE IF NOT EXISTS guild_partner_daily_limit (
    guildId TEXT NOT NULL,
    userId TEXT NOT NULL,
    date TEXT NOT NULL,
    count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (guildId, userId, date)
  );

  CREATE TABLE IF NOT EXISTS guild_blacklist (
    guildId TEXT NOT NULL,
    invite TEXT NOT NULL,
    reason TEXT NOT NULL,
    createdAt TEXT NOT NULL,
    PRIMARY KEY (guildId, invite)
  );

  CREATE TABLE IF NOT EXISTS github_backup_settings (
    guildId TEXT PRIMARY KEY,
    guildName TEXT NOT NULL,
    encryptedPassword TEXT,
    passwordCreatedAt TEXT,
    failedAttempts INTEGER NOT NULL DEFAULT 0,
    backupLocked INTEGER NOT NULL DEFAULT 0,
    lastBackupAt TEXT,
    githubBackupPath TEXT
  );
`);

const nowIso = () => new Date().toISOString();
const todayKey = () => nowIso().slice(0, 10);

const guildRenameJobs = new Map();

function ensureGuild(guild) {
  const now = nowIso();
  db.prepare(
    `INSERT INTO guild_settings (guildId, partnerMessage, createdAt, updatedAt)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(guildId) DO UPDATE SET updatedAt = excluded.updatedAt`
  ).run(guild.id, DEFAULT_PARTNER_MESSAGE, now, now);
  const guildName = guild.name || `Guild ${guild.id}`;
  const existingBackup = db.prepare('SELECT * FROM github_backup_settings WHERE guildId = ?').get(guild.id);
  if (!existingBackup) {
    db.prepare('INSERT INTO github_backup_settings (guildId, guildName) VALUES (?, ?)').run(guild.id, guildName);
    return;
  }

  // A guild can be renamed at any time. Migration is started here as well as
  // from guildUpdate so a restart cannot leave the old GitHub folder behind.
  if (existingBackup.guildName !== guildName) {
    const oldFolder = existingBackup.githubBackupPath || backupFolder({ id: guild.id, name: existingBackup.guildName });
    const newFolder = backupFolder(guild);
    if (oldFolder === newFolder || !existingBackup.githubBackupPath) {
      db.prepare('UPDATE github_backup_settings SET guildName = ?, githubBackupPath = ? WHERE guildId = ?').run(
        guildName,
        existingBackup.githubBackupPath ? newFolder : null,
        guild.id,
      );
    } else {
      startGuildBackupRename(guild, existingBackup, oldFolder, newFolder);
    }
  }
}

function getSettings(guildId) {
  return db.prepare('SELECT * FROM guild_settings WHERE guildId = ?').get(guildId);
}

function updateSettings(guildId, values) {
  const allowed = new Set([
    'setupCompleted',
    'partnerMessage',
    'partnerTriggerChannelId',
    'partnerLogChannelId',
    'partnerRankingChannelId',
    'hakkimdaChannelId',
    'partnerCommandChannelId',
    'autoPartnerEnabled',
    'partnerMessageEnabled',
    'partnerGifEnabled',
    'partnerLinkEnabled',
  ]);
  const entries = Object.entries(values).filter(([key]) => allowed.has(key));
  if (!entries.length) return;
  const assignments = entries.map(([key]) => `${key} = ?`).join(', ');
  db.prepare(`UPDATE guild_settings SET ${assignments}, updatedAt = ? WHERE guildId = ?`).run(
    ...entries.map(([, value]) => value),
    nowIso(),
    guildId,
  );
}

function resetGuild(guildId) {
  const now = nowIso();
  db.prepare(
    `UPDATE guild_settings
     SET setupCompleted = 0, partnerMessage = ?, partnerTriggerChannelId = NULL,
         partnerLogChannelId = NULL, partnerRankingChannelId = NULL,
         hakkimdaChannelId = NULL, partnerCommandChannelId = NULL,
         autoPartnerEnabled = 1, partnerMessageEnabled = 1,
         partnerGifEnabled = 1, partnerLinkEnabled = 1, updatedAt = ?
     WHERE guildId = ?`,
  ).run(DEFAULT_PARTNER_MESSAGE, now, guildId);
}

function isBotOwner(userId) {
  return userId === BOT_OWNER_ID;
}

function isGuildOwner(guild, userId) {
  return Boolean(guild && guild.ownerId === userId);
}

const PERMISSIONS = [
  'FULL_BOT_ADMIN',
  'SETUP_MANAGE',
  'PARTNER_MANAGE',
  'PARTNER_USE',
  'PARTNER_MESSAGE_MANAGE',
  'PARTNER_CHANNEL_MANAGE',
  'PARTNER_STATS_VIEW',
  'BLACKLIST_MANAGE',
  'GITHUB_BACKUP_MANAGE',
];

function hasPermission(guild, userId, permission) {
  if (!guild || !PERMISSIONS.includes(permission)) return false;
  if (isBotOwner(userId) || isGuildOwner(guild, userId)) return true;
  const row = db
    .prepare(
      `SELECT permission FROM guild_permissions
       WHERE guildId = ? AND userId = ? AND permission IN (?, 'FULL_BOT_ADMIN')
       LIMIT 1`,
    )
    .get(guild.id, userId, permission);
  return Boolean(row);
}

function canManagePermissions(guild, userId) {
  return isBotOwner(userId) || isGuildOwner(guild, userId) || hasPermission(guild, userId, 'FULL_BOT_ADMIN');
}

function canGrantPermission(guild, actorId, permission) {
  if (isBotOwner(actorId) || isGuildOwner(guild, actorId)) return true;
  return permission !== 'FULL_BOT_ADMIN' && hasPermission(guild, actorId, 'FULL_BOT_ADMIN');
}

function setPermission(guildId, userId, permission, grantedBy) {
  db.prepare(
    `INSERT INTO guild_permissions (guildId, userId, permission, grantedBy, createdAt)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(guildId, userId, permission) DO UPDATE SET grantedBy = excluded.grantedBy`,
  ).run(guildId, userId, permission, grantedBy, nowIso());
}

function removePermission(guildId, userId, permission) {
  return db
    .prepare('DELETE FROM guild_permissions WHERE guildId = ? AND userId = ? AND permission = ?')
    .run(guildId, userId, permission).changes > 0;
}

function permissionList(guildId) {
  return db
    .prepare('SELECT userId, permission, grantedBy, createdAt FROM guild_permissions WHERE guildId = ? ORDER BY permission')
    .all(guildId);
}

function getPartnerState(guildId, userId) {
  return db.prepare('SELECT * FROM guild_partner_state WHERE guildId = ? AND userId = ?').get(guildId, userId);
}

function setPartnerState(guildId, userId, pending, lastRequestAt) {
  db.prepare(
    `INSERT INTO guild_partner_state (guildId, userId, pending, lastRequestAt)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(guildId, userId) DO UPDATE SET pending = excluded.pending, lastRequestAt = excluded.lastRequestAt`,
  ).run(guildId, userId, pending ? 1 : 0, lastRequestAt);
}

function getPendingStates(userId) {
  return db.prepare('SELECT * FROM guild_partner_state WHERE userId = ? AND pending = 1 ORDER BY lastRequestAt DESC').all(userId);
}

function getDailyCount(guildId, userId, date) {
  return (
    db.prepare('SELECT count FROM guild_partner_daily_limit WHERE guildId = ? AND userId = ? AND date = ?').get(guildId, userId, date)
      ?.count || 0
  );
}

function incrementDailyCount(guildId, userId, date) {
  db.prepare(
    `INSERT INTO guild_partner_daily_limit (guildId, userId, date, count)
     VALUES (?, ?, ?, 1)
     ON CONFLICT(guildId, userId, date) DO UPDATE SET count = count + 1`,
  ).run(guildId, userId, date);
}

function extractInviteLink(content) {
  const match = String(content || '').match(
    /(https?:\/\/)?(www\.)?(discord\.gg\/[a-zA-Z0-9-]+|discord\.com\/invite\/[a-zA-Z0-9-]+)/i,
  );
  return match ? (match[0].startsWith('http') ? match[0] : `https://${match[0]}`) : null;
}

function normalize(text) {
  return String(text || '')
    .toLocaleLowerCase('tr-TR')
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

function messageMatchesPartnerTrigger(content) {
  const value = normalize(content);
  return ['partner yetkili', 'partner dm', 'partner basvuru'].some((phrase) => value.includes(phrase));
}

function formatRemaining(milliseconds) {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1000));
  return `${Math.floor(seconds / 60)} dakika ${seconds % 60} saniye`;
}

function getPeriodStart(period) {
  const date = new Date();
  if (period === 'today') date.setUTCHours(0, 0, 0, 0);
  if (period === 'week') {
    date.setUTCHours(0, 0, 0, 0);
    date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  }
  if (period === 'month') {
    date.setUTCHours(0, 0, 0, 0);
    date.setUTCDate(1);
  }
  return date.toISOString();
}

function getUserStats(guildId, userId) {
  const stats = db.prepare('SELECT * FROM guild_partner_stats WHERE guildId = ? AND userId = ?').get(guildId, userId) || {
    totalPartners: 0,
  };
  const countSince = (start) =>
    db
      .prepare('SELECT COUNT(*) AS count FROM guild_partner_history WHERE guildId = ? AND userId = ? AND createdAt >= ?')
      .get(guildId, userId, start).count;
  const rank =
    db
      .prepare(
        `SELECT COUNT(*) + 1 AS rank FROM guild_partner_stats
         WHERE guildId = ? AND totalPartners > COALESCE(
           (SELECT totalPartners FROM guild_partner_stats WHERE guildId = ? AND userId = ?), 0
         )`,
      )
      .get(guildId, guildId, userId).rank || 1;
  const last = db
    .prepare(
      `SELECT partnerServerName, partnerInvite, createdAt
       FROM guild_partner_history WHERE guildId = ? AND userId = ?
       ORDER BY id DESC LIMIT 1`,
    )
    .get(guildId, userId);
  return {
    today: countSince(getPeriodStart('today')),
    week: countSince(getPeriodStart('week')),
    month: countSince(getPeriodStart('month')),
    total: stats.totalPartners || 0,
    rank,
    last,
  };
}

function getGuildSettingsForBackup(guildId) {
  return {
    settings: getSettings(guildId),
    permissions: db.prepare('SELECT * FROM guild_permissions WHERE guildId = ?').all(guildId),
    partnerStats: db.prepare('SELECT * FROM guild_partner_stats WHERE guildId = ?').all(guildId),
    partnerHistory: db.prepare('SELECT * FROM guild_partner_history WHERE guildId = ?').all(guildId),
    profileMessages: db.prepare('SELECT * FROM guild_profile_messages WHERE guildId = ?').all(guildId),
    blacklist: db.prepare('SELECT * FROM guild_blacklist WHERE guildId = ?').all(guildId),
  };
}

function deriveKey(secret, salt) {
  return crypto.scryptSync(String(secret), salt, 32);
}

function encryptText(value, password, purpose) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = deriveKey(password, salt);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  return JSON.stringify({
    format: 'deathwish-encrypted-v1',
    purpose,
    kdf: 'scrypt',
    cipher: 'aes-256-gcm',
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  });
}

function decryptText(serialized, password) {
  const envelope = JSON.parse(serialized);
  if (envelope.format !== 'deathwish-encrypted-v1') throw new Error('Geçersiz şifreli veri formatı.');
  const key = deriveKey(password, Buffer.from(envelope.salt, 'base64'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(envelope.authTag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

function masterKey() {
  const value = process.env.BACKUP_MASTER_ENCRYPTION_KEY;
  if (!value) throw new Error('BACKUP_MASTER_ENCRYPTION_KEY ortam değişkeni bulunamadı.');
  return value;
}

function githubConfig() {
  const config = {
    owner: process.env.GITHUB_OWNER,
    repo: process.env.GITHUB_REPO_2 || process.env.GITHUB_REPO,
    branch: process.env.GITHUB_BRANCH || 'main',
    token: process.env.GITHUB_TOKEN,
  };
  const missing = Object.entries(config)
    .filter(([key, value]) => key !== 'branch' && !value)
    .map(([key]) => key);
  if (missing.length) throw new Error(`GitHub ortam değişkenleri eksik: ${missing.join(', ')}`);
  return config;
}

function githubUrl(config, filePath = '') {
  const encodedPath = filePath
    .split('/')
    .filter(Boolean)
    .map(encodeURIComponent)
    .join('/');
  return `https://api.github.com/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}/contents/${encodedPath}`;
}

async function githubRequest(method, filePath, body) {
  const config = githubConfig();
  const response = await fetch(githubUrl(config, filePath) + (method === 'GET' ? `?ref=${encodeURIComponent(config.branch)}` : ''), {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${config.token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'DeathWish-Discord-Bot',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { message: text };
  }
  if (!response.ok) {
    throw new Error(`GitHub API ${response.status}: ${data.message || 'Bilinmeyen hata'}`);
  }
  return data;
}

async function githubList(filePath) {
  try {
    const data = await githubRequest('GET', filePath);
    return Array.isArray(data) ? data : [];
  } catch (error) {
    if (String(error.message).includes('GitHub API 404')) return [];
    throw error;
  }
}

async function githubGetFile(filePath) {
  const data = await githubRequest('GET', filePath);
  if (!data.content) throw new Error('GitHub dosyasında içerik bulunamadı.');
  return Buffer.from(data.content.replace(/\n/g, ''), 'base64').toString('utf8');
}

async function githubGetFileRecord(filePath) {
  const data = await githubRequest('GET', filePath);
  if (!data.content || !data.sha) throw new Error('GitHub dosyasında içerik veya SHA bulunamadı.');
  return {
    content: Buffer.from(data.content.replace(/\n/g, ''), 'base64').toString('utf8'),
    sha: data.sha,
  };
}

async function githubPutFile(filePath, content, message) {
  let sha;
  try {
    sha = (await githubRequest('GET', filePath)).sha;
  } catch (error) {
    if (!String(error.message).includes('GitHub API 404')) throw error;
  }
  const config = githubConfig();
  const payload = {
    message,
    content: Buffer.from(content, 'utf8').toString('base64'),
    branch: config.branch,
    ...(sha ? { sha } : {}),
  };
  return githubRequest('PUT', filePath, payload);
}

async function githubDeleteFile(filePath, sha, message) {
  return githubRequest('DELETE', filePath, {
    message,
    sha,
    branch: githubConfig().branch,
  });
}

function guildSlug(name, guildId) {
  const slug = String(name || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 70);
  return slug || `guild-${guildId}`;
}

function backupFolder(guild) {
  // Keep the readable server name while making same-name guilds impossible
  // to collide with each other.
  return `backups/${guildSlug(guild.name, guild.id)}-${guild.id}`;
}

function backupFilename(guild) {
  const timestamp = nowIso().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  return `${guildSlug(guild.name, guild.id)}-backup-${timestamp}-${crypto.randomBytes(3).toString('hex')}.enc`;
}

async function renameGuildBackupFiles(guild, previousGuildName, oldFolder, newFolder) {
  if (oldFolder === newFolder) return;
  const entries = await githubList(oldFolder);
  const oldSlug = guildSlug(previousGuildName, guild.id);
  const newSlug = guildSlug(guild.name, guild.id);
  for (const entry of entries) {
    if (entry.type !== 'file' || !entry.name.endsWith('.enc')) continue;
    const oldPath = `${oldFolder}/${entry.name}`;
    const record = await githubGetFileRecord(oldPath);
    const oldBaseName = entry.name.replace(/\.enc$/i, '').replace(new RegExp(`^${oldSlug}-`), '');
    const newName = `${newSlug}-${oldBaseName}.enc`;
    const newPath = `${newFolder}/${newName}`;
    await githubPutFile(newPath, record.content, `Rename DeathWish backup for ${guild.name}`);
    await githubDeleteFile(oldPath, record.sha, `Remove old DeathWish backup path for ${guild.name}`);
  }
}

async function startGuildBackupRename(guild, existingBackup, oldFolder, newFolder) {
  if (guildRenameJobs.has(guild.id)) return guildRenameJobs.get(guild.id);
  const job = (async () => {
    try {
      await renameGuildBackupFiles(guild, existingBackup.guildName, oldFolder, newFolder);
      db.prepare('UPDATE github_backup_settings SET guildName = ?, githubBackupPath = ? WHERE guildId = ?').run(
        guild.name || `Guild ${guild.id}`,
        newFolder,
        guild.id,
      );
      console.log(`GitHub backup klasörü güncellendi: ${oldFolder} -> ${newFolder}`);
    } catch (error) {
      // Keep the old DB path if GitHub is temporarily unavailable. The next
      // guildUpdate/ready event retries without losing the encryption key.
      console.error(`Guild ${guild.id} backup adı güncellenemedi:`, error);
    } finally {
      guildRenameJobs.delete(guild.id);
    }
  })();
  guildRenameJobs.set(guild.id, job);
  return job;
}

function getBackupSettings(guild) {
  ensureGuild(guild);
  return db.prepare('SELECT * FROM github_backup_settings WHERE guildId = ?').get(guild.id);
}

function getPasswordGuildRows(search = '') {
  const normalizedSearch = normalize(search);
  const rows = db
    .prepare(
      `SELECT guildId, guildName, encryptedPassword, backupLocked, failedAttempts
       FROM github_backup_settings
       ORDER BY guildName COLLATE NOCASE`,
    )
    .all();
  if (!normalizedSearch) return rows;
  return rows.filter((row) => normalize(`${row.guildName} ${row.guildId}`).includes(normalizedSearch));
}

function passwordGuildComponents(ownerId, search = '') {
  const rows = getPasswordGuildRows(search);
  const visibleRows = rows.slice(0, 25);
  const components = [];
  if (visibleRows.length) {
    const select = new StringSelectMenuBuilder()
      .setCustomId(`password_guild_select:${ownerId}`)
      .setPlaceholder('Şifresini görmek istediğin sunucuyu seç')
      .setMinValues(1)
      .setMaxValues(1)
      .addOptions(
        visibleRows.map((row) => ({
          label: String(row.guildName || `Guild ${row.guildId}`).slice(0, 100),
          value: row.guildId,
          description: `ID: ${row.guildId}`.slice(0, 100),
        })),
      );
    components.push(new ActionRowBuilder().addComponents(select));
  }
  components.push(
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`password_search:${ownerId}`)
        .setLabel('Sunucu ara')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(`password_refresh:${ownerId}`)
        .setLabel('Listeyi yenile')
        .setStyle(ButtonStyle.Secondary),
    ),
  );
  return { rows, visibleRows, components };
}

function passwordPanelPayload(ownerId, search = '') {
  const { rows, components } = passwordGuildComponents(ownerId, search);
  const queryText = search ? `\nArama: \`${String(search).slice(0, 80)}\`` : '';
  const resultText = rows.length
    ? `${rows.length} sunucu bulundu. Aşağıdan bir sunucu seç.${rows.length > 25 ? '\nİlk 25 sonuç gösteriliyor; daha net arama yapabilirsin.' : ''}`
    : 'Aramana uygun, oluşturulmuş backup şifresi bulunamadı.';
  return {
    content: `🔐 **GITHUB BACKUP ŞİFRELERİ**${queryText}\n\n${resultText}`,
    components,
    ephemeral: true,
  };
}

function passwordDetailPayload(ownerId, guildId) {
  const row = db
    .prepare(
      `SELECT guildId, guildName, encryptedPassword, backupLocked, failedAttempts
       FROM github_backup_settings
       WHERE guildId = ?`,
    )
    .get(guildId);
  if (!row) {
    return {
      content: '⚠️ Bu sunucu için oluşturulmuş bir backup şifresi bulunamadı.',
      components: passwordGuildComponents(ownerId).components,
      ephemeral: true,
    };
  }
  if (!row.encryptedPassword) {
    return {
      content:
        `⚠️ **${row.guildName}** için henüz backup şifresi oluşturulmamış.\n` +
        'Bu sunucunun yetkilisi `/github sifre-olustur` komutunu kullanmalı.',
      components: passwordGuildComponents(ownerId).components,
      ephemeral: true,
    };
  }
  let password;
  try {
    password = decryptText(row.encryptedPassword, masterKey());
  } catch {
    return {
      content: '❌ Bu sunucunun backup şifresi çözülemedi. Master encryption key kontrol edilmeli.',
      components: passwordGuildComponents(ownerId).components,
      ephemeral: true,
    };
  }
  return {
    content:
      `🔐 **${row.guildName}**\n` +
      `Guild ID: \`${row.guildId}\`\n\n` +
      `Backup şifresi:\n\`${password}\`\n\n` +
      `Backup durumu: ${row.backupLocked ? 'Kilitli' : 'Açık'}\n` +
      `Hatalı deneme: ${row.failedAttempts}/10`,
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`password_back:${ownerId}`).setLabel('Sunucu listesine dön').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`password_search:${ownerId}`).setLabel('Sunucu ara').setStyle(ButtonStyle.Primary),
      ),
    ],
    ephemeral: true,
  };
}

async function handlePasswordInteraction(interaction) {
  if (!interaction.isButton() && !interaction.isStringSelectMenu() && !interaction.isModalSubmit()) return false;
  const customId = interaction.customId || '';
  if (
    !customId.startsWith('password_search:') &&
    !customId.startsWith('password_refresh:') &&
    !customId.startsWith('password_back:') &&
    !customId.startsWith('password_guild_select:') &&
    !customId.startsWith('password_search_modal:')
  ) {
    return false;
  }

  const ownerId = customId.split(':')[1];
  if (!isBotOwner(interaction.user.id) || ownerId !== interaction.user.id) {
    await interaction.reply({ content: '⛔ Bu panel yalnızca bot sahibine aittir.', ephemeral: true }).catch(() => null);
    return true;
  }

  if (customId.startsWith('password_search:')) {
    const modal = new ModalBuilder()
      .setCustomId(`password_search_modal:${ownerId}`)
      .setTitle('Sunucu Backup Şifresi Ara');
    const input = new TextInputBuilder()
      .setCustomId('search')
      .setLabel('Sunucu adı veya Guild ID')
      .setDescription('Arama boş bırakılırsa tüm sunucular listelenir.')
      .setStyle(TextInputStyle.Short)
      .setRequired(false)
      .setMaxLength(100)
      .setPlaceholder('Deathwish veya 123456789012345678');
    modal.addComponents(new ActionRowBuilder().addComponents(input));
    await interaction.showModal(modal);
    return true;
  }

  if (customId.startsWith('password_refresh:') || customId.startsWith('password_back:')) {
    const payload = passwordPanelPayload(ownerId);
    delete payload.ephemeral;
    if (interaction.isButton()) await interaction.update(payload);
    return true;
  }

  if (customId.startsWith('password_search_modal:')) {
    const search = interaction.fields.getTextInputValue('search') || '';
    await interaction.reply(passwordPanelPayload(ownerId, search));
    return true;
  }

  if (customId.startsWith('password_guild_select:')) {
    const guildId = interaction.values[0];
    const payload = passwordDetailPayload(ownerId, guildId);
    delete payload.ephemeral;
    await interaction.update(payload);
    return true;
  }

  return false;
}

function createBackupPassword() {
  const raw = crypto.randomBytes(12).toString('hex').toUpperCase();
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}-${raw.slice(20, 24)}`;
}

function getDecryptedBackupPassword(guild) {
  const settings = getBackupSettings(guild);
  if (!settings.encryptedPassword) throw new Error('Bu sunucu için önce /github sifre-olustur kullanılmalı.');
  return decryptText(settings.encryptedPassword, masterKey());
}

function increaseFailedAttempt(guildId) {
  const settings = db.prepare('SELECT * FROM github_backup_settings WHERE guildId = ?').get(guildId);
  const failedAttempts = (settings?.failedAttempts || 0) + 1;
  const locked = failedAttempts >= MAX_BACKUP_PASSWORD_ATTEMPTS ? 1 : 0;
  db.prepare('UPDATE github_backup_settings SET failedAttempts = ?, backupLocked = ? WHERE guildId = ?').run(
    failedAttempts,
    locked,
    guildId,
  );
  return { failedAttempts, locked: Boolean(locked) };
}

function ensureBackupUnlocked(guild) {
  const settings = getBackupSettings(guild);
  if (settings.backupLocked) throw new Error('Bu sunucunun GitHub backup sistemi 10 hatalı deneme nedeniyle kilitlendi.');
  return settings;
}

async function createGuildBackup(guild) {
  const renameJob = guildRenameJobs.get(guild.id);
  if (renameJob) await renameJob;
  const settings = ensureBackupUnlocked(guild);
  const password = getDecryptedBackupPassword(guild);
  const payload = {
    format: 'deathwish-guild-backup-v1',
    guildId: guild.id,
    guildName: guild.name,
    createdAt: nowIso(),
    data: getGuildSettingsForBackup(guild.id),
  };
  const encrypted = encryptText(JSON.stringify(payload), password, 'guild-backup');
  const filePath = `${backupFolder(guild)}/${backupFilename(guild)}`;
  await githubPutFile(filePath, encrypted, `DeathWish encrypted backup: ${guild.name}`);
  db.prepare(
    'UPDATE github_backup_settings SET lastBackupAt = ?, githubBackupPath = ?, failedAttempts = 0 WHERE guildId = ?',
  ).run(nowIso(), backupFolder(guild), guild.id);
  return { filePath, settings };
}

async function listGuildBackups(guild) {
  const entries = await githubList(backupFolder(guild));
  return entries
    .filter((entry) => entry.type === 'file' && entry.name.endsWith('.enc'))
    .sort((a, b) => String(b.name).localeCompare(String(a.name)));
}

async function restoreGuildBackup(guild, requestedName, password) {
  const settings = ensureBackupUnlocked(guild);
  const entries = await listGuildBackups(guild);
  const fileName = String(requestedName || '').trim() || entries[0]?.name;
  if (!fileName || fileName.includes('/') || !fileName.endsWith('.enc')) {
    throw new Error('Geçerli bir backup dosya adı girilmedi.');
  }
  if (!entries.some((entry) => entry.name === fileName)) throw new Error('Bu sunucuya ait backup bulunamadı.');
  const filePath = `${backupFolder(guild)}/${fileName}`;
  const encrypted = await githubGetFile(filePath);
  let parsed;
  try {
    parsed = JSON.parse(decryptText(encrypted, password));
  } catch {
    const attempt = increaseFailedAttempt(guild.id);
    if (attempt.locked) throw new Error('Şifre hatalı. 10 başarısız deneme nedeniyle backup sistemi kilitlendi.');
    throw new Error(`Şifre hatalı. Kalan deneme: ${MAX_BACKUP_PASSWORD_ATTEMPTS - attempt.failedAttempts}`);
  }
  if (parsed.format !== 'deathwish-guild-backup-v1' || parsed.guildId !== guild.id) {
    throw new Error('Backup doğrulaması başarısız: bu dosya başka bir sunucuya ait.');
  }
  applyGuildBackup(guild, parsed.data);
  db.prepare('UPDATE github_backup_settings SET failedAttempts = 0, lastBackupAt = ? WHERE guildId = ?').run(nowIso(), guild.id);
  return fileName;
}

function applyGuildBackup(guild, backup) {
  const settings = backup?.settings;
  if (!settings || settings.guildId !== guild.id) throw new Error('Backup ayarları bu sunucuya ait değil.');
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM guild_permissions WHERE guildId = ?').run(guild.id);
    db.prepare('DELETE FROM guild_partner_stats WHERE guildId = ?').run(guild.id);
    db.prepare('DELETE FROM guild_partner_history WHERE guildId = ?').run(guild.id);
    db.prepare('DELETE FROM guild_profile_messages WHERE guildId = ?').run(guild.id);
    db.prepare('DELETE FROM guild_blacklist WHERE guildId = ?').run(guild.id);

    updateSettings(guild.id, {
      setupCompleted: settings.setupCompleted,
      partnerMessage: settings.partnerMessage,
      partnerTriggerChannelId: settings.partnerTriggerChannelId,
      partnerLogChannelId: settings.partnerLogChannelId,
      partnerRankingChannelId: settings.partnerRankingChannelId,
      hakkimdaChannelId: settings.hakkimdaChannelId,
      partnerCommandChannelId: settings.partnerCommandChannelId,
      autoPartnerEnabled: settings.autoPartnerEnabled,
      partnerMessageEnabled: settings.partnerMessageEnabled,
      partnerGifEnabled: settings.partnerGifEnabled,
      partnerLinkEnabled: settings.partnerLinkEnabled,
    });

    const permissionInsert = db.prepare(
      `INSERT INTO guild_permissions (guildId, userId, permission, grantedBy, createdAt)
       VALUES (?, ?, ?, ?, ?)`,
    );
    for (const row of backup.permissions || []) {
      if (row.guildId === guild.id && PERMISSIONS.includes(row.permission)) {
        permissionInsert.run(guild.id, row.userId, row.permission, row.grantedBy, row.createdAt || nowIso());
      }
    }

    const statsInsert = db.prepare(
      `INSERT INTO guild_partner_stats (guildId, userId, totalPartners, lastPartnerAt) VALUES (?, ?, ?, ?)`,
    );
    for (const row of backup.partnerStats || []) {
      if (row.guildId === guild.id) statsInsert.run(guild.id, row.userId, row.totalPartners || 0, row.lastPartnerAt || null);
    }

    const historyInsert = db.prepare(
      `INSERT INTO guild_partner_history (id, guildId, userId, partnerServerName, partnerInvite, createdAt)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const row of backup.partnerHistory || []) {
      if (row.guildId === guild.id) {
        historyInsert.run(row.id, guild.id, row.userId, row.partnerServerName, row.partnerInvite, row.createdAt || nowIso());
      }
    }

    const profileInsert = db.prepare(
      `INSERT INTO guild_profile_messages (guildId, userId, messageId, channelId) VALUES (?, ?, ?, ?)`,
    );
    for (const row of backup.profileMessages || []) {
      if (row.guildId === guild.id) profileInsert.run(guild.id, row.userId, row.messageId, row.channelId);
    }

    const blacklistInsert = db.prepare(
      `INSERT INTO guild_blacklist (guildId, invite, reason, createdAt) VALUES (?, ?, ?, ?)`,
    );
    for (const row of backup.blacklist || []) {
      if (row.guildId === guild.id) blacklistInsert.run(guild.id, row.invite, row.reason, row.createdAt || nowIso());
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function isBlacklisted(guildId, invite) {
  return Boolean(db.prepare('SELECT invite FROM guild_blacklist WHERE guildId = ? AND invite = ?').get(guildId, invite));
}

function addBlacklist(guildId, invite, reason) {
  db.prepare(
    `INSERT INTO guild_blacklist (guildId, invite, reason, createdAt) VALUES (?, ?, ?, ?)
     ON CONFLICT(guildId, invite) DO UPDATE SET reason = excluded.reason, createdAt = excluded.createdAt`,
  ).run(guildId, invite, reason, nowIso());
}

function removeBlacklist(guildId, invite) {
  return db.prepare('DELETE FROM guild_blacklist WHERE guildId = ? AND invite = ?').run(guildId, invite).changes > 0;
}

function listBlacklist(guildId) {
  return db.prepare('SELECT * FROM guild_blacklist WHERE guildId = ? ORDER BY createdAt DESC').all(guildId);
}

const pendingConfirmations = new Map();

async function updateRankingMessage(guild, userId, partnerServerName) {
  const settings = getSettings(guild.id);
  if (!settings?.partnerRankingChannelId) return;
  const channel = await client.channels.fetch(settings.partnerRankingChannelId).catch(() => null);
  if (!channel || typeof channel.send !== 'function') return;
  const old = db.prepare('SELECT * FROM guild_profile_messages WHERE guildId = ? AND userId = ?').get(guild.id, userId);
  if (old) {
    const oldMessage = await channel.messages?.fetch(old.messageId).catch(() => null);
    await oldMessage?.delete().catch(() => null);
  }
  const stats = getUserStats(guild.id, userId);
  const sent = await channel.send({
    embeds: [
      new EmbedBuilder()
        .setColor(0x8b5cf6)
        .setTitle('Yeni partner')
        .setDescription(
          `<@${userId}> bu sunucuya yeni bir partner getirdi.\n\n` +
            `**Genel sıralama:** ${stats.rank}\n` +
            `**Bugün:** ${stats.today}  •  **Bu hafta:** ${stats.week}\n` +
            `**Bu ay:** ${stats.month}  •  **Toplam:** ${stats.total}\n\n` +
            `**Partner sunucusu:** ${partnerServerName}`,
        )
        .setTimestamp(),
    ],
    allowedMentions: { users: [userId] },
  });
  db.prepare(
    `INSERT INTO guild_profile_messages (guildId, userId, messageId, channelId) VALUES (?, ?, ?, ?)
     ON CONFLICT(guildId, userId) DO UPDATE SET messageId = excluded.messageId, channelId = excluded.channelId`,
  ).run(guild.id, userId, sent.id, channel.id);
}

async function completePartner(guild, userId, inviteLink, sourceMessage) {
  if (isBlacklisted(guild.id, inviteLink)) throw new Error('Bu davet bağlantısı bu sunucunun kırmızı listesinde.');
  let partnerServerName = 'Bilinmeyen sunucu';
  try {
    const invite = await client.fetchInvite(inviteLink);
    partnerServerName = invite.guild?.name || invite.guild?.id || partnerServerName;
  } catch {
    // A valid-looking invite can be unavailable to the bot; keep the link in history.
  }
  const createdAt = nowIso();
  db.prepare(
    `INSERT INTO guild_partner_stats (guildId, userId, totalPartners, lastPartnerAt)
     VALUES (?, ?, 1, ?)
     ON CONFLICT(guildId, userId) DO UPDATE SET totalPartners = totalPartners + 1, lastPartnerAt = excluded.lastPartnerAt`,
  ).run(guild.id, userId, createdAt);
  db.prepare(
    `INSERT INTO guild_partner_history (guildId, userId, partnerServerName, partnerInvite, createdAt)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(guild.id, userId, partnerServerName, inviteLink, createdAt);
  setPartnerState(guild.id, userId, false, String(Date.now()));

  const settings = getSettings(guild.id);
  if (settings?.partnerLogChannelId) {
    const logChannel = await client.channels.fetch(settings.partnerLogChannelId).catch(() => null);
    await logChannel?.send({
      embeds: [
        new EmbedBuilder()
          .setColor(0x22c55e)
          .setTitle('Partner tamamlandı')
          .addFields(
            { name: 'Kullanıcı', value: `<@${userId}>`, inline: true },
            { name: 'Sunucu', value: partnerServerName, inline: true },
            { name: 'Davet', value: inviteLink, inline: false },
          )
          .setTimestamp(),
      ],
      allowedMentions: { users: [userId] },
    }).catch(() => null);
  }
  await updateRankingMessage(guild, userId, partnerServerName);
  return partnerServerName;
}

async function processPartnerTrigger(message) {
  if (!message.guild) return;
  ensureGuild(message.guild);
  const settings = getSettings(message.guild.id);
  if (!settings.autoPartnerEnabled || settings.partnerTriggerChannelId !== message.channel.id) return;
  if (!messageMatchesPartnerTrigger(message.content)) return;
  if (!hasPermission(message.guild, message.author.id, 'PARTNER_USE')) {
    await message.reply('⛔ Partner sistemini kullanma yetkin yok.').catch(() => null);
    return;
  }
  if (!settings.partnerMessageEnabled) {
    await message.reply('⚠️ Partner mesajı bu sunucuda kapalı.').catch(() => null);
    return;
  }
  const state = getPartnerState(message.guild.id, message.author.id);
  if (state?.pending) {
    await message.reply('⏳ Zaten aktif bir partner isteğin bulunuyor. DM üzerinden davet linkini gönder.').catch(() => null);
    return;
  }
  const date = todayKey();
  if (getDailyCount(message.guild.id, message.author.id, date) >= DAILY_PARTNER_LIMIT) {
    await message.reply(`❌ Günlük partner limitin doldu (${DAILY_PARTNER_LIMIT}/${DAILY_PARTNER_LIMIT}).`).catch(() => null);
    return;
  }
  const last = Number(state?.lastRequestAt || 0);
  if (last && Date.now() - last < COOLDOWN_MS) {
    await message.reply(`⏳ Yeni başvuru için ${formatRemaining(COOLDOWN_MS - (Date.now() - last))} beklemelisin.`).catch(() => null);
    return;
  }

  const key = `${message.guild.id}:${message.author.id}`;
  pendingConfirmations.set(key, { guildId: message.guild.id, userId: message.author.id, now: Date.now(), date });
  const yes = new ButtonBuilder().setCustomId(`partner_yes:${message.guild.id}:${message.author.id}`).setLabel('Evet').setStyle(ButtonStyle.Success);
  const no = new ButtonBuilder().setCustomId(`partner_no:${message.guild.id}:${message.author.id}`).setLabel('Hayır').setStyle(ButtonStyle.Danger);
  await message.reply({
    content: `👋 ${message.author}, partner işlemini benimle başlatmak ister misin?`,
    components: [new ActionRowBuilder().addComponents(yes, no)],
  }).catch(() => null);
}

async function processDirectMessage(message) {
  if (message.guild) return;
  const states = getPendingStates(message.author.id);
  if (!states.length) {
    await message.reply('ℹ️ Aktif partner isteğin yok. Partner kanalındaki başvuru ifadesiyle yeni istek başlatabilirsin.').catch(() => null);
    return;
  }
  if (states.length > 1) {
    await message.reply('⚠️ Birden fazla sunucuda aktif partner isteğin var. Önceki işlemleri tamamlayıp tekrar dene.').catch(() => null);
    return;
  }
  const state = states[0];
  const guild = client.guilds.cache.get(state.guildId);
  const inviteLink = extractInviteLink(message.content);
  if (!guild) {
    setPartnerState(state.guildId, message.author.id, false, state.lastRequestAt);
    await message.reply('❌ Bu partner isteğinin sunucusu artık erişilebilir değil.').catch(() => null);
    return;
  }
  if (!inviteLink) {
    await message.reply('❌ Mesajında Discord davet bağlantısı bulunamadı. Aktif isteğin açık; tekrar gönderebilirsin.').catch(() => null);
    return;
  }
  if (isBlacklisted(guild.id, inviteLink)) {
    await message.reply('🚫 Bu davet bağlantısı kırmızı listede. Başka bir davet bağlantısı gönder.').catch(() => null);
    return;
  }
  try {
    const partnerServerName = await completePartner(guild, message.author.id, inviteLink, message);
    await message.reply(`✅ Partner işlemi tamamlandı: **${partnerServerName}**`).catch(() => null);
  } catch (error) {
    await message.reply(`❌ Partner işlemi tamamlanamadı: ${error.message}`).catch(() => null);
  }
}

function setupEmbed(guild) {
  ensureGuild(guild);
  const s = getSettings(guild.id);
  const channel = (id) => (id ? `<#${id}>` : 'Ayarlanmadı');
  return new EmbedBuilder()
    .setColor(0x8b5cf6)
    .setTitle('DeathWish — Sunucu Kurulum Paneli')
    .setDescription('Bu panel yalnızca bu sunucunun ayarlarını değiştirir. Her sunucu kendi verilerini ve kanallarını kullanır.')
    .addFields(
      { name: 'Partner tetikleme', value: channel(s.partnerTriggerChannelId), inline: true },
      { name: 'Partner log', value: channel(s.partnerLogChannelId), inline: true },
      { name: 'Partner sıralama', value: channel(s.partnerRankingChannelId), inline: true },
      { name: 'Hakkımda kanalı', value: channel(s.hakkimdaChannelId), inline: true },
      { name: 'Komut kanalı', value: channel(s.partnerCommandChannelId), inline: true },
      {
        name: 'Durum',
        value: `${s.setupCompleted ? 'Kurulum tamamlandı' : 'Kurulum tamamlanmadı'}\n` +
          `Otomatik partner: ${s.autoPartnerEnabled ? 'Açık' : 'Kapalı'}\n` +
          `Partner mesajı: ${s.partnerMessageEnabled ? 'Açık' : 'Kapalı'}`,
        inline: true,
      },
    )
    .setFooter({ text: `Guild ID: ${guild.id}` });
}

function setupButtons(userId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`setup_channels:${userId}`).setLabel('Kanallar').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`setup_message:${userId}`).setLabel('Partner mesajı').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`setup_features:${userId}`).setLabel('Partner ayarları').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`setup_reset:${userId}`).setLabel('Kurulumu sıfırla').setStyle(ButtonStyle.Danger),
  );
}

async function showSetupPanel(interaction, edit = false) {
  const payload = { embeds: [setupEmbed(interaction.guild)], components: [setupButtons(interaction.user.id)] };
  if (edit) return interaction.editReply(payload);
  return interaction.reply({ ...payload, ephemeral: true });
}

function channelSelectionRows(userId) {
  const fields = [
    ['partnerTriggerChannelId', 'Partner Tetikleme Kanalı'],
    ['partnerLogChannelId', 'Partner Log Kanalı'],
    ['partnerRankingChannelId', 'Partner Sıralama Kanalı'],
    ['hakkimdaChannelId', 'Hakkımda Kanalı'],
    ['partnerCommandChannelId', 'Partner Komut Kanalı'],
  ];
  return fields.map(([key, label]) =>
    new ActionRowBuilder().addComponents(
      new ChannelSelectMenuBuilder()
        .setCustomId(`setup_channel:${key}:${userId}`)
        .setPlaceholder(label)
        .setChannelTypes([ChannelType.GuildText, ChannelType.GuildAnnouncement])
        .setMinValues(1)
        .setMaxValues(1),
    ),
  );
}

const commands = [
  new SlashCommandBuilder().setName('setup').setDescription('Bu sunucunun DeathWish ayarlarını yönetir.').toJSON(),
  new SlashCommandBuilder().setName('hakkimda').setDescription('Bu sunucudaki partner istatistiklerini gösterir.').toJSON(),
  new SlashCommandBuilder()
    .setName('yetki')
    .setDescription('Bu sunucudaki DeathWish yetkilerini yönetir.')
    .addSubcommand((s) => s.setName('listele').setDescription('Yetkileri listeler.'))
    .addSubcommand((s) =>
      s
        .setName('ver')
        .setDescription('Bir kullanıcıya yetki verir.')
        .addUserOption((o) => o.setName('kullanici').setDescription('Kullanıcı').setRequired(true))
        .addStringOption((o) =>
          o
            .setName('yetki')
            .setDescription('Verilecek yetki')
            .setRequired(true)
            .addChoices(...PERMISSIONS.map((permission) => ({ name: permission, value: permission }))),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName('al')
        .setDescription('Bir kullanıcının yetkisini alır.')
        .addUserOption((o) => o.setName('kullanici').setDescription('Kullanıcı').setRequired(true))
        .addStringOption((o) =>
          o
            .setName('yetki')
            .setDescription('Alınacak yetki')
            .setRequired(true)
            .addChoices(...PERMISSIONS.map((permission) => ({ name: permission, value: permission }))),
        ),
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName('partner-yetki')
    .setDescription('Partner kullanma yetkilerini yönetir.')
    .addSubcommand((s) =>
      s
        .setName('ver')
        .setDescription('Partner yetkisi verir.')
        .addUserOption((o) => o.setName('kullanici').setDescription('Kullanıcı').setRequired(true)),
    )
    .addSubcommand((s) =>
      s
        .setName('al')
        .setDescription('Partner yetkisini alır.')
        .addUserOption((o) => o.setName('kullanici').setDescription('Kullanıcı').setRequired(true)),
    )
    .addSubcommand((s) => s.setName('listele').setDescription('Partner yetkililerini listeler.'))
    .toJSON(),
  new SlashCommandBuilder()
    .setName('kirmiziliste')
    .setDescription('Bu sunucunun partner kırmızı listesini yönetir.')
    .addSubcommand((s) =>
      s
        .setName('ekle')
        .setDescription('Davet bağlantısını ekler.')
        .addStringOption((o) => o.setName('link').setDescription('Discord daveti').setRequired(true))
        .addStringOption((o) => o.setName('sebep').setDescription('Sebep').setRequired(true)),
    )
    .addSubcommand((s) =>
      s
        .setName('sil')
        .setDescription('Davet bağlantısını siler.')
        .addStringOption((o) => o.setName('link').setDescription('Discord daveti').setRequired(true)),
    )
    .addSubcommand((s) => s.setName('liste').setDescription('Kırmızı listeyi gösterir.'))
    .toJSON(),
  new SlashCommandBuilder()
    .setName('sifre-olustur')
    .setDescription('Bu sunucu için tek seferlik backup şifresi oluşturur.')
    .toJSON(),
  new SlashCommandBuilder()
    .setName('backup-olustur')
    .setDescription('Bu sunucunun şifreli backup dosyasını oluşturur.')
    .toJSON(),
  new SlashCommandBuilder()
    .setName('backup-geri-yukle')
    .setDescription('Bir backup dosyasını şifre ile geri yükler.')
    .toJSON(),
  new SlashCommandBuilder()
    .setName('backup-listele')
    .setDescription('Bot sahibine özel: bu sunucunun backup dosyalarını listeler.')
    .setDefaultMemberPermissions('0')
    .toJSON(),
  new SlashCommandBuilder()
    .setName('kilitleri-goster')
    .setDescription('Bot sahibine özel: kilitli backup sistemlerini gösterir.')
    .setDefaultMemberPermissions('0')
    .toJSON(),
  new SlashCommandBuilder()
    .setName('kilit-ac')
    .setDescription('Bot sahibine özel: bir guild backup kilidini açar.')
    .addStringOption((o) => o.setName('guildid').setDescription('Guild ID').setRequired(true))
    .setDefaultMemberPermissions('0')
    .toJSON(),
  new SlashCommandBuilder()
    .setName('sifreleri-goster')
    .setDescription('Yalnızca bot sahibine gerçek backup şifrelerini gösterir.')
    .setDefaultMemberPermissions('0')
    .toJSON(),
];

const app = express();
app.get('/', (_req, res) => res.status(200).send('DeathWish Bot Aktif'));
app.listen(PORT, () => console.log(`DeathWish web sunucusu ${PORT} portunda çalışıyor.`));

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.DirectMessages],
  partials: [Partials.Channel, Partials.Message],
});

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  const registeredCommands = await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
  const ownerOnlyNames = new Set([
    'backup-listele',
    'kilitleri-goster',
    'kilit-ac',
    'sifreleri-goster',
  ]);

  // Add a user-specific allow rule for the bot owner in every guild. The
  // default "0" permission keeps these commands out of normal users'
  // command menus. Some guilds may reject a user override when the owner is
  // not a member; runtime checks below still keep those commands protected.
  for (const guild of client.guilds.cache.values()) {
    for (const command of registeredCommands.filter((item) => ownerOnlyNames.has(item.name))) {
      try {
        await rest.put(Routes.applicationCommandPermissions(client.user.id, guild.id, command.id), {
          body: {
            permissions: [{ id: BOT_OWNER_ID, type: 1, permission: true }],
          },
        });
      } catch (error) {
        console.error(`Bot sahibi için ${command.name} komut izni ${guild.id} sunucusunda ayarlanamadı:`, error);
      }
    }
  }
}

function requireGuild(interaction) {
  if (!interaction.guild) throw new Error('Bu komut yalnızca bir Discord sunucusunda kullanılabilir.');
  ensureGuild(interaction.guild);
  return interaction.guild;
}

async function handleSetupInteraction(interaction) {
  const guild = requireGuild(interaction);
  if (!hasPermission(guild, interaction.user.id, 'SETUP_MANAGE')) {
    await interaction.reply({ content: '⛔ Bu kurulumu yalnızca sunucu sahibi, bot sahibi veya yetkili yönetebilir.', ephemeral: true });
    return true;
  }
  if (interaction.isChatInputCommand() && interaction.commandName === 'setup') {
    await showSetupPanel(interaction);
    return true;
  }
  if (interaction.isButton()) {
    const [action, ownerId] = interaction.customId.split(':');
    if (!action.startsWith('setup_')) return false;
    if (ownerId !== interaction.user.id) {
      await interaction.reply({ content: '⛔ Bu kurulum paneli başka bir kullanıcıya ait.', ephemeral: true });
      return true;
    }
    if (action === 'setup_channels') {
      await interaction.reply({ content: 'Her alan için ilgili kanalı seç:', components: channelSelectionRows(interaction.user.id), ephemeral: true });
      return true;
    }
    if (action === 'setup_message') {
      const modal = new ModalBuilder().setCustomId(`setup_message_modal:${interaction.user.id}`).setTitle('Partner Mesajını Ayarla');
      const input = new TextInputBuilder()
        .setCustomId('message')
        .setLabel('Bu sunucunun partner mesajı')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
        .setMaxLength(4000)
        .setValue((getSettings(guild.id).partnerMessage || DEFAULT_PARTNER_MESSAGE).slice(0, 4000));
      modal.addComponents(new ActionRowBuilder().addComponents(input));
      await interaction.showModal(modal);
      return true;
    }
    if (action === 'setup_features') {
      const modal = new ModalBuilder().setCustomId(`setup_features_modal:${interaction.user.id}`).setTitle('Partner Ayarları');
      for (const [id, label] of [
        ['auto', 'Otomatik partner açık mı? (evet/hayir)'],
        ['message', 'Partner mesajı açık mı? (evet/hayir)'],
        ['gif', 'GIF izni açık mı? (evet/hayir)'],
        ['link', 'Link izni açık mı? (evet/hayir)'],
      ]) {
        const input = new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(5).setValue('evet');
        modal.addComponents(new ActionRowBuilder().addComponents(input));
      }
      await interaction.showModal(modal);
      return true;
    }
    if (action === 'setup_reset') {
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`setup_reset_yes:${interaction.user.id}`).setLabel('Evet, sıfırla').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(`setup_reset_no:${interaction.user.id}`).setLabel('Vazgeç').setStyle(ButtonStyle.Secondary),
      );
      await interaction.reply({ content: 'Bu sunucunun kanal ve partner ayarları sıfırlanacak. Emin misin?', components: [row], ephemeral: true });
      return true;
    }
    if (action === 'setup_reset_yes') {
      resetGuild(guild.id);
      await interaction.update({ content: '✅ Bu sunucunun setup ayarları sıfırlandı.', components: [] });
      return true;
    }
    if (action === 'setup_reset_no') {
      await interaction.update({ content: 'İşlem iptal edildi.', components: [] });
      return true;
    }
  }
  if (interaction.isChannelSelectMenu() && interaction.customId.startsWith('setup_channel:')) {
    const [, key, ownerId] = interaction.customId.split(':');
    if (ownerId !== interaction.user.id) {
      await interaction.reply({ content: '⛔ Bu seçim başka bir kullanıcıya ait.', ephemeral: true });
      return true;
    }
    updateSettings(guild.id, { [key]: interaction.values[0], setupCompleted: 1 });
    await interaction.reply({ content: `✅ ${key} bu sunucu için kaydedildi.`, ephemeral: true });
    return true;
  }
  if (interaction.isModalSubmit() && interaction.customId.startsWith('setup_message_modal:')) {
    const [, ownerId] = interaction.customId.split(':');
    if (ownerId !== interaction.user.id) return true;
    updateSettings(guild.id, { partnerMessage: interaction.fields.getTextInputValue('message'), setupCompleted: 1 });
    await interaction.reply({ content: '✅ Bu sunucunun partner mesajı kaydedildi.', ephemeral: true });
    return true;
  }
  if (interaction.isModalSubmit() && interaction.customId.startsWith('setup_features_modal:')) {
    const [, ownerId] = interaction.customId.split(':');
    if (ownerId !== interaction.user.id) return true;
    const yes = (id) => normalize(interaction.fields.getTextInputValue(id)) === 'evet';
    updateSettings(guild.id, {
      autoPartnerEnabled: yes('auto') ? 1 : 0,
      partnerMessageEnabled: yes('message') ? 1 : 0,
      partnerGifEnabled: yes('gif') ? 1 : 0,
      partnerLinkEnabled: yes('link') ? 1 : 0,
      setupCompleted: 1,
    });
    await interaction.reply({ content: '✅ Partner ayarları bu sunucu için kaydedildi.', ephemeral: true });
    return true;
  }
  return false;
}

async function handleBackupCommand(interaction) {
  const guild = requireGuild(interaction);
  if (!hasPermission(guild, interaction.user.id, 'GITHUB_BACKUP_MANAGE')) {
    await interaction.reply({ content: '⛔ GitHub backup yetkin yok.', ephemeral: true });
    return;
  }
  if (interaction.commandName === 'sifre-olustur') {
    const settings = getBackupSettings(guild);
    if (settings.encryptedPassword) {
      await interaction.reply({ content: '❌ Bu sunucu için backup şifresi zaten oluşturuldu. Güvenlik nedeniyle yeniden gösterilemez.', ephemeral: true });
      return;
    }
    const password = createBackupPassword();
    db.prepare(
      `UPDATE github_backup_settings SET encryptedPassword = ?, passwordCreatedAt = ?, failedAttempts = 0, backupLocked = 0
       WHERE guildId = ?`,
    ).run(encryptText(password, masterKey(), 'backup-password'), nowIso(), guild.id);
    await interaction.reply({
      content: `🔐 **${guild.name}** backup şifren oluşturuldu:\n\n\`${password}\`\n\n⚠️ Bu şifre yalnızca bu kez gösterildi. Güvenli bir yere kaydet.`,
      ephemeral: true,
    });
    return;
  }
  if (interaction.commandName === 'backup-olustur') {
    await interaction.deferReply({ ephemeral: true });
    const result = await createGuildBackup(guild);
    await interaction.editReply(`✅ Yalnızca **${guild.name}** verilerini içeren şifreli backup GitHub Repo 2'ye kaydedildi.\nDosya: \`${result.filePath}\``);
    return;
  }
  if (interaction.commandName === 'backup-geri-yukle') {
    ensureBackupUnlocked(guild);
    const modal = new ModalBuilder().setCustomId(`restore_backup_modal:${guild.id}:${interaction.user.id}`).setTitle('Backup Geri Yükle');
    const file = new TextInputBuilder()
      .setCustomId('file')
      .setLabel('Dosya adı (boş bırakırsan en yenisi)')
      .setStyle(TextInputStyle.Short)
      .setRequired(false)
      .setMaxLength(120)
      .setPlaceholder('backup-20260724T203000Z-abc123.enc');
    const password = new TextInputBuilder()
      .setCustomId('password')
      .setLabel('Bu sunucunun backup şifresi')
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMaxLength(80);
    modal.addComponents(new ActionRowBuilder().addComponents(file), new ActionRowBuilder().addComponents(password));
    await interaction.showModal(modal);
  }
}

async function handleOwnerOnlyBackupList(interaction) {
  if (!isBotOwner(interaction.user.id)) {
    await interaction.reply({ content: '⛔ Bu komut yalnızca bot sahibine açıktır.', ephemeral: true });
    return;
  }
  const guild = requireGuild(interaction);
  await interaction.deferReply({ ephemeral: true });
  const entries = await listGuildBackups(guild);
  await interaction.editReply(
    entries.length
      ? `📁 **${guild.name}** backup dosyaları:\n${entries.map((entry) => `• \`${entry.name}\``).join('\n')}`
      : 'ℹ️ Bu sunucu için backup bulunamadı.',
  );
}

async function handleOwnerOnlyLockedList(interaction) {
  if (!isBotOwner(interaction.user.id)) {
    await interaction.reply({ content: '⛔ Bu komut yalnızca bot sahibine açıktır.', ephemeral: true });
    return;
  }
  const locked = db.prepare('SELECT guildId, guildName, failedAttempts FROM github_backup_settings WHERE backupLocked = 1').all();
  await interaction.reply({
    content: locked.length
      ? `🔒 Kilitli backup sistemleri:\n${locked.map((row) => `• ${row.guildName} — ${row.guildId} (${row.failedAttempts}/10)`).join('\n')}`
      : '✅ Kilitli backup sistemi yok.',
    ephemeral: true,
  });
}

async function handleOwnerOnlyUnlock(interaction) {
  if (!isBotOwner(interaction.user.id)) {
    await interaction.reply({ content: '⛔ Bu komut yalnızca bot sahibine açıktır.', ephemeral: true });
    return;
  }
  const guildId = interaction.options.getString('guildid', true);
  const result = db.prepare('UPDATE github_backup_settings SET failedAttempts = 0, backupLocked = 0 WHERE guildId = ?').run(guildId);
  await interaction.reply({
    content: result.changes ? `✅ ${guildId} backup kilidi açıldı.` : '⚠️ Guild bulunamadı.',
    ephemeral: true,
  });
}

async function handleInteraction(interaction) {
  if (interaction.isChatInputCommand() && interaction.commandName === 'setup') {
    await handleSetupInteraction(interaction);
    return;
  }
  if (
    (interaction.isButton() && interaction.customId.startsWith('setup_')) ||
    (interaction.isChannelSelectMenu() && interaction.customId.startsWith('setup_channel:')) ||
    (interaction.isModalSubmit() && (interaction.customId.startsWith('setup_message_modal:') || interaction.customId.startsWith('setup_features_modal:')))
  ) {
    await handleSetupInteraction(interaction);
    return;
  }
  if (
    (interaction.isButton() && (
      interaction.customId.startsWith('password_search:') ||
      interaction.customId.startsWith('password_refresh:') ||
      interaction.customId.startsWith('password_back:')
    )) ||
    (interaction.isStringSelectMenu() && interaction.customId.startsWith('password_guild_select:')) ||
    (interaction.isModalSubmit() && interaction.customId.startsWith('password_search_modal:'))
  ) {
    await handlePasswordInteraction(interaction);
    return;
  }
  if (interaction.isModalSubmit() && interaction.customId.startsWith('restore_backup_modal:')) {
    const [, guildId, ownerId] = interaction.customId.split(':');
    if (ownerId !== interaction.user.id || !interaction.guild || interaction.guild.id !== guildId) {
      await interaction.reply({ content: '⛔ Bu geri yükleme isteği bu kullanıcıya veya sunucuya ait değil.', ephemeral: true });
      return;
    }
    await interaction.deferReply({ ephemeral: true });
    try {
      const restored = await restoreGuildBackup(
        interaction.guild,
        interaction.fields.getTextInputValue('file'),
        interaction.fields.getTextInputValue('password'),
      );
      await interaction.editReply(`✅ \`${restored}\` backup dosyası doğrulandı ve yalnızca **${interaction.guild.name}** sunucusuna geri yüklendi.`);
    } catch (error) {
      await interaction.editReply(`❌ ${error.message}`);
    }
    return;
  }
  if (interaction.isButton() && interaction.customId.startsWith('partner_')) {
    const [, guildId, ownerId] = interaction.customId.split(':');
    if (ownerId !== interaction.user.id) {
      await interaction.reply({ content: '⛔ Bu buton sana ait değil.', ephemeral: true });
      return;
    }
    await interaction.deferUpdate();
    const key = `${guildId}:${ownerId}`;
    const pending = pendingConfirmations.get(key);
    if (interaction.customId.startsWith('partner_no:')) {
      pendingConfirmations.delete(key);
      await interaction.editReply({ content: '❌ Partner işlemi iptal edildi.', components: [] });
      return;
    }
    if (!pending) {
      await interaction.editReply({ content: '⚠️ Bu istek zaten işlendi veya süresi doldu.', components: [] });
      return;
    }
    pendingConfirmations.delete(key);
    const guild = client.guilds.cache.get(guildId);
    if (!guild) {
      await interaction.editReply({ content: '❌ Sunucu artık erişilebilir değil.', components: [] });
      return;
    }
    setPartnerState(guildId, ownerId, true, String(pending.now));
    incrementDailyCount(guildId, ownerId, pending.date);
    try {
      const user = await client.users.fetch(ownerId);
      const settings = getSettings(guildId);
      await user.send(settings.partnerMessage || DEFAULT_PARTNER_MESSAGE);
      await interaction.editReply({ content: `📩 <@${ownerId}> DM üzerinden **${guild.name}** partner mesajı gönderildi. Davet linkini DM'ye gönder.`, components: [] });
    } catch {
      setPartnerState(guildId, ownerId, false, String(pending.now));
      await interaction.editReply({ content: '❌ DM gönderilemedi. DM ayarlarını açıp tekrar dene.', components: [] });
    }
    return;
  }
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName === 'backup-listele') {
    try {
      await handleOwnerOnlyBackupList(interaction);
    } catch (error) {
      if (interaction.deferred || interaction.replied) await interaction.editReply(`❌ ${error.message}`).catch(() => null);
      else await interaction.reply({ content: `❌ ${error.message}`, ephemeral: true }).catch(() => null);
    }
    return;
  }
  if (interaction.commandName === 'kilitleri-goster') {
    try {
      await handleOwnerOnlyLockedList(interaction);
    } catch (error) {
      if (interaction.deferred || interaction.replied) await interaction.editReply(`❌ ${error.message}`).catch(() => null);
      else await interaction.reply({ content: `❌ ${error.message}`, ephemeral: true }).catch(() => null);
    }
    return;
  }
  if (interaction.commandName === 'kilit-ac') {
    try {
      await handleOwnerOnlyUnlock(interaction);
    } catch (error) {
      if (interaction.deferred || interaction.replied) await interaction.editReply(`❌ ${error.message}`).catch(() => null);
      else await interaction.reply({ content: `❌ ${error.message}`, ephemeral: true }).catch(() => null);
    }
    return;
  }
  if (
    interaction.commandName === 'sifre-olustur' ||
    interaction.commandName === 'backup-olustur' ||
    interaction.commandName === 'backup-geri-yukle'
  ) {
    try {
      await handleBackupCommand(interaction);
    } catch (error) {
      if (interaction.deferred || interaction.replied) await interaction.editReply(`❌ ${error.message}`).catch(() => null);
      else await interaction.reply({ content: `❌ ${error.message}`, ephemeral: true }).catch(() => null);
    }
    return;
  }
  if (interaction.commandName === 'sifreleri-goster') {
    if (!isBotOwner(interaction.user.id)) {
      await interaction.reply({ content: '⛔ Bu komut yalnızca bot sahibine açıktır.', ephemeral: true });
      return;
    }
    await interaction.reply(passwordPanelPayload(interaction.user.id));
    return;
  }

  let guild;
  try {
    guild = requireGuild(interaction);
  } catch (error) {
    await interaction.reply({ content: `❌ ${error.message}`, ephemeral: true });
    return;
  }

  if (interaction.commandName === 'hakkimda') {
    const settings = getSettings(guild.id);
    if (!settings.hakkimdaChannelId) {
      await interaction.reply({ content: '⚠️ Önce /setup panelinden Hakkımda kanalını seçmelisin.', ephemeral: true });
      return;
    }
    if (interaction.channelId !== settings.hakkimdaChannelId) {
      await interaction.reply({ content: `❌ Bu komut yalnızca <#${settings.hakkimdaChannelId}> kanalında kullanılabilir.`, ephemeral: true });
      return;
    }
    const stats = getUserStats(guild.id, interaction.user.id);
    await interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(0x8b5cf6)
          .setTitle(`${interaction.user.username} — Partner İstatistikleri`)
          .setDescription(
            `**Genel sıralama:** ${stats.rank}\n\n` +
              `**Bugün:** ${stats.today}\n**Bu hafta:** ${stats.week}\n**Bu ay:** ${stats.month}\n**Toplam:** ${stats.total}\n\n` +
              `**Son partner:** ${stats.last ? `${stats.last.partnerServerName} — ${stats.last.createdAt}` : 'Henüz yok'}`,
          ),
      ],
    });
    return;
  }

  if (interaction.commandName === 'yetki' || interaction.commandName === 'partner-yetki') {
    if (!canManagePermissions(guild, interaction.user.id)) {
      await interaction.reply({ content: '⛔ Yetki yönetimi için guild owner, bot owner veya FULL_BOT_ADMIN olmalısın.', ephemeral: true });
      return;
    }
    const sub = interaction.options.getSubcommand();
    if (interaction.commandName === 'partner-yetki' && sub !== 'listele') {
      const target = interaction.options.getUser('kullanici', true);
      const action = sub === 'ver' ? setPermission(guild.id, target.id, 'PARTNER_USE', interaction.user.id) : removePermission(guild.id, target.id, 'PARTNER_USE');
      await interaction.reply({ content: sub === 'ver' ? `✅ ${target} PARTNER_USE yetkisi aldı.` : `✅ ${target} PARTNER_USE yetkisi alındı.`, ephemeral: true });
      return;
    }
    if (interaction.commandName === 'partner-yetki' && sub === 'listele') {
      const users = permissionList(guild.id).filter((row) => row.permission === 'PARTNER_USE');
      await interaction.reply({ content: users.length ? users.map((row) => `• <@${row.userId}>`).join('\n') : 'ℹ️ Partner yetkilisi yok.', ephemeral: true });
      return;
    }
    if (sub === 'listele') {
      const rows = permissionList(guild.id);
      await interaction.reply({ content: rows.length ? rows.map((row) => `• <@${row.userId}> — ${row.permission}`).join('\n') : 'ℹ️ Bu sunucuda özel yetki yok.', ephemeral: true });
      return;
    }
    const target = interaction.options.getUser('kullanici', true);
    const permission = interaction.options.getString('yetki', true);
    if (target.id === interaction.user.id || target.id === BOT_OWNER_ID || isGuildOwner(guild, target.id)) {
      await interaction.reply({ content: '⛔ Kendini, bot sahibini veya guild ownerı bu şekilde yönetemezsin.', ephemeral: true });
      return;
    }
    if (!canGrantPermission(guild, interaction.user.id, permission)) {
      await interaction.reply({ content: '⛔ Bu yetkiyi verme/alma seviyen yok.', ephemeral: true });
      return;
    }
    if (sub === 'ver') {
      setPermission(guild.id, target.id, permission, interaction.user.id);
      await interaction.reply({ content: `✅ ${target} kullanıcısına ${permission} verildi.`, ephemeral: true });
    } else {
      const removed = removePermission(guild.id, target.id, permission);
      await interaction.reply({ content: removed ? `✅ ${target} kullanıcısından ${permission} alındı.` : 'ℹ️ Bu yetki kaydı bulunamadı.', ephemeral: true });
    }
    return;
  }

  if (interaction.commandName === 'kirmiziliste') {
    if (!hasPermission(guild, interaction.user.id, 'BLACKLIST_MANAGE')) {
      await interaction.reply({ content: '⛔ Kırmızı liste yetkin yok.', ephemeral: true });
      return;
    }
    const sub = interaction.options.getSubcommand();
    if (sub === 'ekle') {
      const link = interaction.options.getString('link', true);
      addBlacklist(guild.id, link, interaction.options.getString('sebep', true));
      await interaction.reply({ content: `✅ ${link} bu sunucunun kırmızı listesine eklendi.`, ephemeral: true });
    } else if (sub === 'sil') {
      const removed = removeBlacklist(guild.id, interaction.options.getString('link', true));
      await interaction.reply({ content: removed ? '✅ Kayıt silindi.' : '⚠️ Kayıt bulunamadı.', ephemeral: true });
    } else {
      const rows = listBlacklist(guild.id);
      await interaction.reply({ content: rows.length ? rows.map((row) => `• ${row.invite} — ${row.reason}`).join('\n').slice(0, 1900) : 'ℹ️ Bu sunucunun kırmızı listesi boş.', ephemeral: true });
    }
  }
}

client.once('ready', async () => {
  for (const guild of client.guilds.cache.values()) ensureGuild(guild);
  await registerCommands();
  console.log(`DeathWish ${client.user.tag} olarak giriş yaptı; ${client.guilds.cache.size} guild hazır.`);
});

client.on('guildCreate', (guild) => ensureGuild(guild));
client.on('guildUpdate', (oldGuild, newGuild) => {
  if (oldGuild.name !== newGuild.name) ensureGuild(newGuild);
});
client.on('messageCreate', async (message) => {
  try {
    if (message.author.bot) return;
    if (message.guild) await processPartnerTrigger(message);
    else await processDirectMessage(message);
  } catch (error) {
    console.error('messageCreate hatası:', error);
  }
});
client.on('interactionCreate', async (interaction) => {
  try {
    await handleInteraction(interaction);
  } catch (error) {
    console.error('interactionCreate hatası:', error);
    if (interaction.deferred || interaction.replied) await interaction.editReply(`❌ ${error.message}`).catch(() => null);
    else await interaction.reply({ content: `❌ ${error.message}`, ephemeral: true }).catch(() => null);
  }
});

client.on('error', (error) => console.error('Discord client hatası:', error));
client.on('shardError', (error, shardId) => console.error(`Shard ${shardId} hatası:`, error));
process.on('unhandledRejection', (reason) => console.error('Unhandled rejection:', reason));
process.on('uncaughtException', (error) => console.error('Uncaught exception:', error));

client.login(TOKEN);
