require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder, REST, Routes, SlashCommandBuilder } = require('discord.js');
const mongoose = require('mongoose');
const express = require('express');
const http = require('http');
const path = require('path');
const multer = require('multer');

// --- 1. KONEKSI DATABASE ---
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log('✅ Database Terhubung!'))
    .catch(err => console.error('❌ Database Error:', err));

const memberSchema = new mongoose.Schema({
    userId: String, username: String,
    warnCount: { type: Number, default: 0 },
    totalAlpa: { type: Number, default: 0 },
    xp: { type: Number, default: 0 },
    lastImageTime: Date,
    statusIzin: { type: String, default: null }, 
    izinTimestamp: Date,
    warnExpiry: Date // Timer kapan hukuman warning selesai
});
const MemberData = mongoose.model('MemberData', memberSchema);

// --- 2. SETUP BOT DISCORD ---
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds, 
        GatewayIntentBits.GuildMembers, 
        GatewayIntentBits.GuildMessages, 
        GatewayIntentBits.MessageContent, 
        GatewayIntentBits.GuildVoiceStates
    ]
});

// A. REGISTER SLASH COMMAND
const commands = [
    new SlashCommandBuilder().setName('regis').setDescription('Daftar ke sistem MeWoai'),
    new SlashCommandBuilder().setName('izin').setDescription('Ajukan izin tidak hadir').addStringOption(o => o.setName('alasan').setRequired(true).setDescription('Alasan izin')),
    new SlashCommandBuilder().setName('ban').setDescription('Admin Only').addUserOption(o => o.setName('target').setRequired(true).setDescription('Target'))
];

const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);
(async () => { 
    try {
        await rest.put(Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID), { body: commands });
        console.log('✅ Slash Commands Ready!');
    } catch (e) { console.error(e); }
})();

// B. SYSTEM AUTO-RESTORE ROLE (Jalan Setiap 1 Menit)
client.once('ready', () => {
    console.log(`🤖 SYSTEM MEWOAI ONLINE: ${client.user.tag}`);

    setInterval(async () => {
        const now = new Date();
        // Cari member yang masa hukumannya sudah habis
        const expiredMembers = await MemberData.find({ warnExpiry: { $lte: now } });

        for (const m of expiredMembers) {
            const guild = client.guilds.cache.get(process.env.GUILD_ID);
            if (!guild) continue;
            
            const member = await guild.members.fetch(m.userId).catch(() => null);
            if (member) {
                // 1. Cabut Role Warning
                await member.roles.remove([process.env.ROLE_WARN1, process.env.ROLE_WARN2, process.env.ROLE_WARN3]).catch(() => {});
                
                // 2. KEMBALIKAN ROLE MEMBER
                await member.roles.add(process.env.ROLE_MEMBER).catch(console.error);
                
                console.log(`✅ Hukuman ${m.username} selesai. Role Member dikembalikan.`);
            }

            // 3. Reset timer
            m.warnExpiry = null;
            await m.save();
        }
    }, 60000); // Cek setiap 60 detik
});

// C. EVENT HANDLER (Slash Command)
client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;
    
    // Command: REGIS
    if (interaction.commandName === 'regis') {
        let user = await MemberData.findOne({ userId: interaction.user.id });
        if (user) return interaction.reply({ content: '❌ Kamu sudah terdaftar!', ephemeral: true });
        
        await MemberData.create({ userId: interaction.user.id, username: interaction.user.username });
        
        const roleMember = interaction.guild.roles.cache.get(process.env.ROLE_MEMBER);
        if (roleMember) await interaction.member.roles.add(roleMember);
        
        interaction.reply({ content: '✅ Berhasil daftar & Role Member diterima!', ephemeral: true });
    }

    // Command: IZIN
    if (interaction.commandName === 'izin') {
        const alasan = interaction.options.getString('alasan');
        await MemberData.findOneAndUpdate(
            { userId: interaction.user.id },
            { statusIzin: alasan, izinTimestamp: new Date(), username: interaction.user.username },
            { upsert: true }
        );
        interaction.reply({ content: `✅ Izin tercatat: "${alasan}".`, ephemeral: true });
    }
});

// D. SYSTEM XP & ANTI SPAM
client.on('messageCreate', async message => {
    if (message.author.bot) return;
    let user = await MemberData.findOne({ userId: message.author.id });
    if (!user) return; 

    // Filter Gambar (2 Menit)
    if (message.attachments.size > 0) {
        const now = new Date();
        if (user.lastImageTime && (now - user.lastImageTime) < 120000) {
            await message.delete();
            return message.channel.send(`⚠️ ${message.author}, Tunggu 2 menit sebelum kirim gambar lagi!`).then(m => setTimeout(()=>m.delete(), 3000));
        }
        user.lastImageTime = now;
        user.xp += 15;
    } else {
        user.xp += 5;
    }
    await user.save();
});

client.login(process.env.TOKEN);

// --- 3. SETUP WEB DASHBOARD (BACKEND) ---
const app = express();
const server = http.createServer(app);
app.set('view engine', 'ejs');
app.use(express.static('public'));
app.use(express.urlencoded({ extended: true }));

const upload = multer({ storage: multer.diskStorage({
    destination: './public/uploads/', filename: (req, f, cb) => cb(null, Date.now() + path.extname(f.originalname))
})});

// --- ROUTE WEBSITE ---

// 1. Dashboard Utama
app.get('/', async (req, res) => {
    const stats = {
        total: await MemberData.countDocuments(),
        warn: await MemberData.countDocuments({ warnCount: { $gt: 0 } }),
        top: await MemberData.findOne().sort('-xp')
    };
    res.render('dashboard', { stats, page: 'home' });
});

// 2. Halaman Upload (Updated: Bisa baca Announcement Channel)
app.get('/upload', (req, res) => {
    const guild = client.guilds.cache.get(process.env.GUILD_ID);
    
    // AMBIL Channel Type 0 (Text) DAN Type 5 (Announcement)
    const channels = guild ? guild.channels.cache
        .filter(c => c.type === 0 || c.type === 5) 
        .map(c => ({ id: c.id, name: c.name })) 
        : [];
        
    res.render('upload', { channels, page: 'upload' });
});

// 3. Proses Posting Info (Updated: Fitur Tag Everyone/Here)
app.post('/post-info', upload.single('gambar'), async (req, res) => {
    const { targetChannel, judul, pesan, tipe, mentionType } = req.body;
    const channel = client.channels.cache.get(targetChannel);
    
    if (channel) {
        let warna = 'Blue';
        if (tipe === 'Warning') warna = 'Red';
        if (tipe === 'Event') warna = 'Green';
        if (tipe === 'Showcase') warna = 'Gold';
        
        const embed = new EmbedBuilder()
            .setTitle(judul)
            .setDescription(pesan)
            .setColor(warna)
            .setFooter({ text: `MeWoai • ${tipe}` })
            .setTimestamp();
            
        const files = req.file ? [`./public/uploads/${req.file.filename}`] : [];
        
        // Cek apakah user memilih tag
        const contentMessage = mentionType || ''; // Kalau kosong ya string kosong (silent)

        await channel.send({ 
            content: contentMessage, // Kirim notif (ping) disini
            embeds: [embed], 
            files: files 
        });
    }
    res.redirect('/');
});

// 4. Halaman Absen
app.get('/absen', (req, res) => res.render('absen', { page: 'absen' }));

// 5. Proses Absen (Updated: Logic Cabut Role Member)
app.post('/proses-absen', async (req, res) => {
    const guild = client.guilds.cache.get(process.env.GUILD_ID);
    const channel = guild.channels.cache.find(c => c.name === '📚│MeWoAI Hall'); // NAMA CHANNEL FIX
    
    if (!channel) return res.send("❌ Channel '📚│MeWoAI Hall' tidak ditemukan!");

    const membersDB = await MemberData.find();
    let laporan = [];

    for (const m of membersDB) {
        const statusIzin = m.statusIzin;
        const statusHadir = channel.members.has(m.userId);
        
        let hasil = "";
        let cssClass = ""; // Pake Class Bootstrap biar gak error merah

        if (statusHadir) {
            hasil = "HADIR ✅";
            cssClass = "text-success fw-bold"; 
            m.statusIzin = null; 
        } else if (statusIzin) {
            hasil = `IZIN 📩 (${statusIzin})`;
            cssClass = "text-warning fw-bold"; 
            m.statusIzin = null;
        } else {
            // LOGIC ALPA & WARNING
            m.totalAlpa += 1;
            m.xp = Math.max(0, m.xp - 10);
            
            if (m.totalAlpa % 5 === 0) {
                m.warnCount += 1;
                hasil = `ALPA ❌ -> WARNING LEVEL ${m.warnCount}`;
                cssClass = "text-danger fw-bold border border-danger p-2 rounded";
                
                // EKSEKUSI HUKUMAN
                const memberDc = await guild.members.fetch(m.userId).catch(()=>null);
                if (memberDc) {
                    // A. Cabut Role Member (Sesuai Request)
                    await memberDc.roles.remove(process.env.ROLE_MEMBER).catch(()=>{});
                    
                    // B. Cabut Role Warning Lama (Biar gak numpuk)
                    await memberDc.roles.remove([process.env.ROLE_WARN1, process.env.ROLE_WARN2, process.env.ROLE_WARN3]).catch(()=>{});
                    
                    // C. Beri Role Warning Baru & Set Timer
                    let duration = 0;
                    if (m.warnCount === 1) {
                        await memberDc.roles.add(process.env.ROLE_WARN1);
                        duration = 2 * 24 * 60 * 60 * 1000; // 2 Hari
                    } else if (m.warnCount === 2) {
                        await memberDc.roles.add(process.env.ROLE_WARN2);
                        duration = 5 * 24 * 60 * 60 * 1000; // 5 Hari
                    } else if (m.warnCount >= 3) {
                        await memberDc.roles.add(process.env.ROLE_WARN3);
                        duration = 5 * 24 * 60 * 60 * 1000; // 5 Hari
                    }

                    // D. Simpan Timer Expired ke Database
                    m.warnExpiry = new Date(Date.now() + duration);
                }
            } else {
                hasil = `ALPA ❌ (Total: ${m.totalAlpa})`;
                cssClass = "text-danger";
            }
        }
        laporan.push({ nama: m.username, status: hasil, cssClass }); 
        await m.save();
    }
    
    res.render('hasil_absen', { laporan, page: 'absen' });
});

// 6. Security & Promote
app.get('/security', async (req, res) => {
    const candidates = await MemberData.find().sort('-xp').limit(10);
    res.render('security', { candidates, page: 'security' });
});

app.post('/promote', async (req, res) => {
    const guild = client.guilds.cache.get(process.env.GUILD_ID);
    const member = await guild.members.fetch(req.body.userId).catch(()=>null);
    if (member) {
        await member.roles.add(process.env.ROLE_EXPERT);
        await MemberData.updateOne({ userId: req.body.userId }, { xp: 0 }); // Reset XP
        res.redirect('/security');
    } else {
        res.send("Member tidak ditemukan.");
    }
});

// Start Server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 MEWOAI DASHBOARD RUNNING ON PORT ${PORT}`));