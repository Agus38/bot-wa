// ================= CORE =================
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
  notifyNonAdmin: true,
  autoread: false,
  autotyping: false,
  admins: [] // admins[0] = owner
}

if (fs.existsSync(CONFIG_FILE)) {
  config = { ...config, ...JSON.parse(fs.readFileSync(CONFIG_FILE)) }
}
const saveConfig = () =>
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2))

// ================= MEMORY =================
const memory = {}
const intent = {}

function remember(jid, role, text) {
  if (!memory[jid]) memory[jid] = []
  memory[jid].push({ role, content: text })
  if (memory[jid].length > 6) memory[jid].shift()
}

// ================= UTIL =================
function aiNotSure(text) {
  if (!text) return true
  const t = text.toLowerCase()
  return (
    t.length < 20 ||
    t.includes("tidak tahu") ||
    t.includes("kurang yakin") ||
    t.includes("belum tahu") ||
    t.includes("maaf")
  )
}

// REALTIME / DYNAMIC QUERY → WAJIB SEARCH
function isRealtimeQuery(text) {
  const t = text.toLowerCase()
  return (
    t.includes("dolar") ||
    t.includes("usd") ||
    t.includes("kurs") ||
    t.includes("rupiah") ||
    t.includes("harga") ||
    t.includes("hari ini") ||
    t.includes("sekarang") ||
    t.includes("bitcoin") ||
    t.includes("btc") ||
    t.includes("emas") ||
    t.includes("bbm")
  )
}

// ================= TOOLS =================
function toolTime() {
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

async function toolWeather(city) {
  try {
    const geo = await fetch(
      `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(
        city + ", Indonesia"
      )}&count=1`
    ).then(r => r.json())

    if (!geo.results?.length) return `❌ Kota "${city}" tidak ditemukan`

    const { latitude, longitude, name } = geo.results[0]
    const w = await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current_weather=true`
    ).then(r => r.json())

    const c = w.current_weather
    return `🌦️ Cuaca di ${name}
• Suhu: ${c.temperature}°C
• Angin: ${c.windspeed} km/jam`
  } catch {
    return "❌ Gagal mengambil data cuaca"
  }
}

// SEARCH INTERNET (DuckDuckGo – gratis)
async function toolSearch(query) {
  try {
    const res = await fetch(
      `https://api.duckduckgo.com/?q=${encodeURIComponent(
        query
      )}&format=json&no_html=1&skip_disambig=1`
    )
    const j = await res.json()

    if (j.AbstractText) return j.AbstractText
    if (j.RelatedTopics?.length) return j.RelatedTopics[0].Text

    return "Tidak ditemukan informasi relevan."
  } catch {
    return "Gagal mencari informasi dari internet."
  }
}

// ================= AI =================
async function askAI(jid, prompt) {
  const messages = [
    {
      role: "system",
      content:
        "Kamu adalah asisbot, teman ngobrol santai 🙂. " +
        "Jawaban singkat, tidak formal, emoticon seperlunya."
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
  return j.choices?.[0]?.message?.content || ""
}

// ================= BOT =================
const rl = readline.createInterface({ input: process.stdin, output: process.stdout })

async function startBot() {
  const startTime = Date.now()
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
    if (isGroup && !config.respondGroup) return

    const senderJid = isGroup ? m.key.participant : from
    const sender = senderJid.split("@")[0]
    const isAdmin = config.admins.includes(sender)

    const raw =
      m.message.conversation ||
      m.message.extendedTextMessage?.text ||
      ""

    const text = raw.trim()
    const lower = text.toLowerCase()

    if (config.autoread) await sock.readMessages([m.key])
    if (config.autotyping) await sock.sendPresenceUpdate("composing", from)

    // ===== CLAIM OWNER =====
    if (lower === ".claim") {
      if (config.admins.length === 0) {
        config.admins.push(sender)
        saveConfig()
        await sock.sendMessage(from, { text: "✅ Kamu sekarang OWNER." })
      } else {
        await sock.sendMessage(from, { text: "⛔ Owner sudah ditetapkan." })
      }
      return
    }

    // ===== PING =====
    if (lower === ".ping") {
      const ping = Date.now() - startTime
      await sock.sendMessage(from, { text: `🏓 Pong! ${ping} ms` })
      return
    }

    // ===== COMMAND ROUTER =====
    if (text.startsWith(".")) {
      if (!isAdmin) {
        if (config.notifyNonAdmin) {
          await sock.sendMessage(from, { text: "⛔ Kamu bukan admin." })
        }
        return
      }

      if (lower === ".admin") {
        await sock.sendMessage(from, {
          text: `🛠️ ADMIN MENU
.admin on / off
.admin group on / off
.admin add 628xxx
.admin del 628xxx
.admin autoread on / off
.admin autotyping on / off
.admin list owner
.admin status`
        })
        return
      }

      if (lower === ".admin autoread on") {
        config.autoread = true; saveConfig()
        await sock.sendMessage(from, { text: "📖 Auto-read diaktifkan." })
        return
      }

      if (lower === ".admin autoread off") {
        config.autoread = false; saveConfig()
        await sock.sendMessage(from, { text: "📖 Auto-read dimatikan." })
        return
      }

      if (lower === ".admin autotyping on") {
        config.autotyping = true; saveConfig()
        await sock.sendMessage(from, { text: "⌨️ Auto-typing diaktifkan." })
        return
      }

      if (lower === ".admin autotyping off") {
        config.autotyping = false; saveConfig()
        await sock.sendMessage(from, { text: "⌨️ Auto-typing dimatikan." })
        return
      }

      if (lower === ".admin list owner") {
        await sock.sendMessage(from, { text: `👑 OWNER:\n${config.admins[0]}` })
        return
      }

      if (lower === ".admin status") {
        await sock.sendMessage(from, {
          text: `📊 STATUS
Bot: ${config.botActive ? "ON" : "OFF"}
Grup: ${config.respondGroup ? "ON" : "OFF"}
AutoRead: ${config.autoread}
AutoTyping: ${config.autotyping}
Admin: ${config.admins.join(", ")}`
        })
        return
      }

      saveConfig()
      return
    }

    if (!config.botActive) return

    // ===== WEATHER (SMART + ASK CITY) =====
    if (/cuaca|suhu/i.test(lower)) {
      const cityMatch =
        lower.match(/di\s+([a-z\s]+)/i) ||
        lower.match(/cuaca\s+([a-z\s]+)/i)

      const city = cityMatch ? cityMatch[1].trim() : null

      if (city && city.length >= 3) {
        intent[from] = null
        await sock.sendMessage(from, { text: await toolWeather(city) })
        return
      }

      intent[from] = "ask_weather_city"
      await sock.sendMessage(from, { text: "📍 Di kota mana?" })
      return
    }

    if (intent[from] === "ask_weather_city") {
      if (/^[a-z\s]+$/i.test(text)) {
        await sock.sendMessage(from, { text: await toolWeather(text.trim()) })
        intent[from] = null
        return
      }
    }

    // ===== TIME =====
    if (/jam|waktu|tanggal/i.test(lower)) {
      await sock.sendMessage(from, { text: toolTime() })
      return
    }

    // ===== AI + AUTO SEARCH =====
    remember(from, "user", text)

    let ans = ""
    if (isRealtimeQuery(text)) {
      ans = `🔍 Aku cek info terbaru ya...\n\n${await toolSearch(text)}`
    } else {
      ans = await askAI(from, text)
      if (aiNotSure(ans)) {
        ans = `🔍 Aku cari dulu ya...\n\n${await toolSearch(text)}`
      }
    }

    remember(from, "assistant", ans)
    await sock.sendMessage(from, { text: ans })
  })
}

startBot()
