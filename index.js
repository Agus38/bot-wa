// ================= BASIC SETUP =================
import fs from "fs"
import fetch from "node-fetch"
import "dotenv/config"
import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore
} from "@whiskeysockets/baileys"
import Pino from "pino"
import readline from "readline"

// ================= CONFIG =================
const BOT_NAME = "asisbot"
const GROQ_KEY = process.env.GROQ_API_KEY
const CONFIG_FILE = "./bot-config.json"

let config = {
  botActive: true,
  respondGroup: false,
  admins: ["6285607063906@s.whatsapp.net"]
}

if (fs.existsSync(CONFIG_FILE)) {
  config = { ...config, ...JSON.parse(fs.readFileSync(CONFIG_FILE)) }
}
const saveConfig = () =>
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2))

// ================= MEMORY =================
const memory = {}
const context = {} // untuk intent (cuaca, dll)

function remember(jid, role, text) {
  if (!memory[jid]) memory[jid] = []
  memory[jid].push({ role, content: text })
  if (memory[jid].length > 6) memory[jid].shift()
}

// ================= TOOLS =================
function getTime() {
  const d = new Date()
  return `🕒 ${d.toLocaleDateString("id-ID", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "Asia/Jakarta"
  })}\n⏰ Jam ${d.toLocaleTimeString("id-ID", {
    timeZone: "Asia/Jakarta"
  })}`
}

async function getWeather(city) {
  try {
    const q = `${city}, Indonesia`
    const geo = await fetch(
      `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(
        q
      )}&count=1&language=id`
    ).then(r => r.json())

    if (!geo.results?.length) return `❌ Kota "${city}" tidak ditemukan.`

    const { latitude, longitude, name } = geo.results[0]
    const w = await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current_weather=true`
    ).then(r => r.json())

    const c = w.current_weather
    return `🌦️ Cuaca saat ini di ${name}
• Suhu: ${c.temperature}°C
• Angin: ${c.windspeed} km/jam`
  } catch {
    return "❌ Gagal mengambil data cuaca."
  }
}

// ================= AI =================
async function askAI(jid, prompt) {
  const messages = [
    {
      role: "system",
      content:
        "Kamu adalah asisbot, teman dekat yang santai 🙂. " +
        "Jawab singkat, tidak formal, emoticon seperlunya. " +
        "Jangan pernah membahas data sensitif."
    },
    ...(memory[jid] || []),
    { role: "user", content: prompt }
  ]

  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${GROQ_KEY}`
    },
    body: JSON.stringify({
      model: "llama-3.1-8b-instant",
      messages,
      temperature: 0.6
    })
  })

  const j = await res.json()
  return j.choices?.[0]?.message?.content || "Aku belum tau jawabannya 😅"
}

// ================= BOT =================
const rl = readline.createInterface({ input: process.stdin, output: process.stdout })

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

  if (!state.creds.registered) {
    rl.question("Nomor WA (62xxxx): ", async n => {
      const code = await sock.requestPairingCode(n.replace(/\D/g, ""))
      console.log("PAIRING:", code)
      rl.close()
    })
  }

  sock.ev.on("creds.update", saveCreds)

  sock.ev.on("messages.upsert", async ({ messages }) => {
    const m = messages[0]
    if (!m?.message || m.key.fromMe) return

    const from = m.key.remoteJid
    const isGroup = from.endsWith("@g.us")
    const sender = isGroup ? m.key.participant : from
    const isAdmin = config.admins.includes(sender)

    if (isGroup && !config.respondGroup) return

    const text =
      m.message.conversation ||
      m.message.extendedTextMessage?.text ||
      ""

    const lower = text.toLowerCase()

    // ===== ADMIN MENU (TEXT) =====
    if (isAdmin && lower === ".admin") {
      await sock.sendMessage(from, {
        text: `🛠️ ADMIN MENU
.admin on
.admin off
.admin group on
.admin group off
.admin status`
      })
      return
    }

    if (isAdmin && lower === ".admin on") config.botActive = true
    if (isAdmin && lower === ".admin off") config.botActive = false
    if (isAdmin && lower === ".admin group on") config.respondGroup = true
    if (isAdmin && lower === ".admin group off") config.respondGroup = false

    if (isAdmin && lower === ".admin status") {
      await sock.sendMessage(from, {
        text: `📊 STATUS
Bot: ${config.botActive ? "ON" : "OFF"}
Respon Grup: ${config.respondGroup ? "ON" : "OFF"}
Admin: ${config.admins.length}`
      })
      saveConfig()
      return
    }

    if (!config.botActive) return

    // ===== TIME =====
    if (/jam|waktu|tanggal|sekarang/i.test(lower)) {
      await sock.sendMessage(from, { text: getTime() })
      return
    }

    // ===== WEATHER =====
    if (/cuaca|suhu/i.test(lower)) {
      context[from] = "weather"
      await sock.sendMessage(from, { text: await getWeather("Jakarta") })
      return
    }

    // lanjutan konteks cuaca
    if (context[from] === "weather" && /^[a-z\s]+$/i.test(text)) {
      await sock.sendMessage(from, { text: await getWeather(text) })
      context[from] = null
      return
    }

    // ===== AI =====
    remember(from, "user", text)
    const ans = await askAI(from, text)
    remember(from, "assistant", ans)
    await sock.sendMessage(from, { text: ans })
  })
}

startBot()
