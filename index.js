import fs from "fs"
import fetch from "node-fetch"
import "dotenv/config"
import { evaluate } from "mathjs"
import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  DisconnectReason
} from "@whiskeysockets/baileys"
import Pino from "pino"
import readline from "readline"

// ================= BASIC INFO =================
const BOT_NAME = "asisbot"
const BOT_VERSION = "1.2.0"
const RELEASE_DATE = "Januari 2026"
const CREATOR_NAME = "Agus Hermanto"
const CREATOR_CONTACT = "https://6285607063906"
const NOTIFY_JID = "6285607063906@s.whatsapp.net"

// ================= LOAD CONFIG =================
const CONFIG_FILE = "./bot-config.json"
const ADMIN_FILE = "./admin.json"

let config = JSON.parse(fs.readFileSync(CONFIG_FILE))
let adminData = JSON.parse(fs.readFileSync(ADMIN_FILE))

const saveConfig = () =>
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2))

const isAdmin = number => adminData.admins.includes(number)

// ================= MEMORY =================
const memory = {}
function remember(jid, role, content) {
  if (!memory[jid]) memory[jid] = []
  memory[jid].push({ role, content })
  if (memory[jid].length > 6) memory[jid].shift()
}

// ================= AI =================
async function askAI(jid, prompt) {
  remember(jid, "user", prompt)

  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.GROQ_API_KEY}`
    },
    body: JSON.stringify({
      model: "llama-3.1-8b-instant",
      messages: [
        {
          role: "system",
          content:
            "Kamu adalah asisbot, teman ngobrol santai. " +
            "Bahasa Indonesia ringan, nggak formal, emoticon secukupnya 🙂."
        },
        ...(memory[jid] || [])
      ],
      temperature: 0.7
    })
  })

  const j = await res.json()
  const reply = j.choices?.[0]?.message?.content
  if (reply) remember(jid, "assistant", reply)
  return reply
}

// ================= UTIL =================
function cleanCity(text) {
  return text
    .replace(/(saat ini|sekarang|hari ini|dong|ya)/gi, "")
    .replace(/[^a-z\s]/gi, "")
    .trim()
}

function get_current_time() {
  const d = new Date()
  return `🕒 ${d.toLocaleDateString("id-ID", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "Asia/Jakarta"
  })}\n⏰ ${d.toLocaleTimeString("id-ID", { timeZone: "Asia/Jakarta" })}`
}

// ================= TOOLS =================
async function get_weather(city) {
  const geo = await fetch(
    `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(
      city + ", Indonesia"
    )}&count=1&language=id`
  ).then(r => r.json())

  if (!geo.results?.length)
    return `😅 Aku nggak nemu kota *${city}*.`

  const { latitude, longitude, name } = geo.results[0]
  const w = await fetch(
    `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current_weather=true`
  ).then(r => r.json())

  const c = w.current_weather
  return `🌦️ Cuaca di *${name}*
• Suhu: ${c.temperature}°C
• Angin: ${c.windspeed} km/jam`
}

// ================= BOT =================
const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
let startTime = Date.now()

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState("./session")
  const { version } = await fetchLatestBaileysVersion()

  const sock = makeWASocket({
    version,
    logger: Pino({ level: "silent" }),
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, Pino())
    },
    browser: ["Ubuntu", "Chrome", "120"]
  })

  // ===== PAIRING ONLY FIRST TIME =====
  if (!state.creds.registered) {
    rl.question("Masukkan nomor WhatsApp (62xxxx): ", async num => {
      const code = await sock.requestPairingCode(num.replace(/\D/g, ""))
      console.log("🔐 Pairing Code:", code)
      rl.close()
    })
  }

  sock.ev.on("creds.update", saveCreds)

  // ===== CONNECTION HANDLER (NO RE-PAIRING BUG FIX) =====
  sock.ev.on("connection.update", async update => {
    const { connection, lastDisconnect } = update

    if (connection === "open") {
      startTime = Date.now()
      console.log("✅ Bot terhubung ke WhatsApp")

      await sock.sendMessage(NOTIFY_JID, {
        text: "✅ asisbot ONLINE & siap digunakan."
      })
    }

    if (connection === "close") {
      const reason = lastDisconnect?.error?.output?.statusCode
      console.log("⚠ Koneksi terputus:", reason)

      await sock.sendMessage(NOTIFY_JID, {
        text: `⚠ asisbot DISCONNECT\nReason: ${reason}`
      })

      if (reason === DisconnectReason.loggedOut) {
        console.log("🔁 Logged out, reset session & pairing ulang")
        fs.rmSync("./session", { recursive: true, force: true })
      }

      startBot()
    }
  })

  // ================= MESSAGE HANDLER =================
  sock.ev.on("messages.upsert", async ({ messages }) => {
    const m = messages[0]
    if (!m?.message || m.key.fromMe) return

    const from = m.key.remoteJid
    const isGroup = from.endsWith("@g.us")
    if (isGroup && !config.respondGroup) return

    const sender = (m.key.participant || from).split("@")[0]
    const admin = isAdmin(sender)

    const text =
      m.message.conversation ||
      m.message.extendedTextMessage?.text ||
      ""
    const lower = text.toLowerCase().trim()

    // ===== MENU ADMIN (PRIORITY) =====
    if (lower === ".menu" && admin) {
      await sock.sendMessage(from, {
        text: `🛠️ MENU ADMIN
.reply on/off
.group on/off
.autoread on/off
.autotyping on/off
.status
.owner`
      })
      return
    }

    // ===== ADMIN COMMAND =====
    if (admin && lower.startsWith(".")) {
      if (lower === ".group on") config.respondGroup = true
      if (lower === ".group off") config.respondGroup = false
      if (lower === ".reply on") config.replyActive = true
      if (lower === ".reply off") config.replyActive = false
      if (lower === ".autoread on") config.autoread = true
      if (lower === ".autoread off") config.autoread = false
      if (lower === ".autotyping on") config.autotyping = true
      if (lower === ".autotyping off") config.autotyping = false

      saveConfig()
      await sock.sendMessage(from, { text: "✅ Oke, sudah diatur." })
      return
    }

    if (!config.botActive || !config.replyActive) return

    // ===== STATUS =====
    if (lower === ".status") {
      const ping = Date.now() - startTime
      await sock.sendMessage(from, {
        text: `🤖 STATUS BOT
Nama: ${BOT_NAME}
Versi: ${BOT_VERSION}
Ping: ${ping} ms
Status: Online`
      })
      return
    }

    // ===== FIXED ANSWERS =====
    if (/siapa pencipta/i.test(lower)) {
      await sock.sendMessage(from, {
        text: `👤 Pencipta: ${CREATOR_NAME}\nKontak: ${CREATOR_CONTACT}`
      })
      return
    }

    if (/kapan.*(rilis|diluncurkan|dibuat)/i.test(lower)) {
      await sock.sendMessage(from, {
        text: `📅 Aku mulai dirilis *${RELEASE_DATE}* 🙂`
      })
      return
    }

    // ===== TIME =====
    if (/jam|tanggal|waktu/i.test(lower)) {
      await sock.sendMessage(from, { text: get_current_time() })
      return
    }

    // ===== WEATHER =====
    if (/cuaca|suhu/i.test(lower)) {
      const match = lower.match(/di\s+([a-z\s]+)/i)
      const rawCity = match ? match[1] : lower.replace(/cuaca|suhu/gi, "")
      const city = cleanCity(rawCity)

      if (city.length < 3) {
        await sock.sendMessage(from, { text: "📍 Di kota mana?" })
      } else {
        await sock.sendMessage(from, { text: await get_weather(city) })
      }
      return
    }

    // ===== AI CHAT =====
    const aiReply = await askAI(from, text)
    await sock.sendMessage(from, {
      text: aiReply || "😅 Lagi error dikit, coba ulangi ya."
    })
  })
}

startBot()
