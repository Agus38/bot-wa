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
  admins: [] // admin[0] = owner
}

if (fs.existsSync(CONFIG_FILE)) {
  config = { ...config, ...JSON.parse(fs.readFileSync(CONFIG_FILE)) }
}
const saveConfig = () =>
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2))

// ================= MEMORY =================
const memory = {}
const intent = {}

const remember = (jid, role, text) => {
  if (!memory[jid]) memory[jid] = []
  memory[jid].push({ role, content: text })
  if (memory[jid].length > 6) memory[jid].shift()
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
  })}\n⏰ Jam ${d.toLocaleTimeString("id-ID", { timeZone: "Asia/Jakarta" })}`
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
    return "❌ Gagal ambil cuaca"
  }
}

// ===== GOOGLE SEARCH (DuckDuckGo) =====
async function toolSearch(query) {
  try {
    const res = await fetch(
      `https://api.duckduckgo.com/?q=${encodeURIComponent(
        query
      )}&format=json&no_html=1&skip_disambig=1`
    )
    const j = await res.json()

    if (j.AbstractText) {
      return `🔍 ${query}\n\n${j.AbstractText}`
    }

    if (j.RelatedTopics?.length) {
      return `🔍 ${query}\n\n${j.RelatedTopics[0].Text}`
    }

    return `🔍 ${query}\nTidak ditemukan ringkasan.`
  } catch {
    return "❌ Gagal melakukan pencarian."
  }
}

// ================= AI =================
async function askAI(jid, prompt) {
  const messages = [
    {
      role: "system",
      content:
        "Kamu adalah asisbot, teman ngobrol santai 🙂. " +
        "Jawaban singkat, tidak formal, emoticon seperlunya. " +
        "Jangan pernah membahas pencipta, perusahaan, atau data sensitif."
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
    const isOwner = config.admins[0] === sender

    const raw =
      m.message.conversation ||
      m.message.extendedTextMessage?.text ||
      ""

    const text = raw.trim()
    const lower = text.toLowerCase()

    if (config.autoread) {
      await sock.readMessages([m.key])
    }

    if (config.autotyping) {
      await sock.sendPresenceUpdate("composing", from)
    }

    // ================= CLAIM OWNER =================
    if (lower === ".claim") {
      if (config.admins.length === 0) {
        config.admins.push(sender)
        saveConfig()
        await sock.sendMessage(from, { text: "✅ Kamu sekarang OWNER." })
      } else {
        await sock.sendMessage(from, { text: "⛔ Owner sudah ada." })
      }
      return
    }

    // ================= PING =================
    if (lower === ".ping") {
      const ping = Date.now() - startTime
      await sock.sendMessage(from, { text: `🏓 Pong! ${ping} ms` })
      return
    }

    // ================= COMMAND ROUTER =================
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

      if (lower === ".admin autoread on") config.autoread = true
      if (lower === ".admin autoread off") config.autoread = false
      if (lower === ".admin autotyping on") config.autotyping = true
      if (lower === ".admin autotyping off") config.autotyping = false

      if (lower === ".admin list owner") {
        await sock.sendMessage(from, {
          text: `👑 OWNER:\n${config.admins[0]}`
        })
        return
      }

      if (lower.startsWith(".admin add ")) {
        const num = lower.split(" ")[2]?.replace(/\D/g, "")
        if (!num || config.admins.includes(num)) return
        config.admins.push(num)
      }

      if (lower.startsWith(".admin del ")) {
        const num = lower.split(" ")[2]?.replace(/\D/g, "")
        if (num === config.admins[0]) {
          await sock.sendMessage(from, { text: "⛔ Owner tidak bisa dihapus." })
          return
        }
        config.admins = config.admins.filter(a => a !== num)
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
        saveConfig()
        return
      }

      saveConfig()
      await sock.sendMessage(from, { text: "✅ Admin command OK." })
      return
    }

    if (!config.botActive) return

    // ================= SEARCH =================
    if (lower.startsWith("cari ")) {
      const q = text.slice(5)
      await sock.sendMessage(from, { text: await toolSearch(q) })
      return
    }

    // ================= TOOLS =================
    if (/jam|waktu|tanggal|sekarang/i.test(lower)) {
      await sock.sendMessage(from, { text: toolTime() })
      return
    }

    if (/cuaca|suhu/i.test(lower)) {
      intent[from] = "weather"
      await sock.sendMessage(from, { text: await toolWeather("Jakarta") })
      return
    }

    if (intent[from] === "weather" && /^[a-z\s]+$/i.test(text)) {
      await sock.sendMessage(from, { text: await toolWeather(text) })
      intent[from] = null
      return
    }

    // ================= AI =================
    remember(from, "user", text)
    const ans = await askAI(from, text)
    remember(from, "assistant", ans)
    await sock.sendMessage(from, { text: ans })
  })
}

startBot()
