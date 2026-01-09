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
  replyActive: true,        // 🔔 reply on/off
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
    t.length < 25 ||
    t.includes("tidak tahu") ||
    t.includes("kurang yakin") ||
    t.includes("belum tahu") ||
    t.includes("maaf")
  )
}

function isInvalidCity(word) {
  const invalid = ["sekarang", "saat ini", "hari ini", "ini", "tadi"]
  return invalid.includes(word.trim())
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
  })}\n⏰ ${d.toLocaleTimeString("id-ID", {
    timeZone: "Asia/Jakarta"
  })}`
}

// ===== CUACA =====
async function toolWeather(city) {
  try {
    const geo = await fetch(
      `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(
        city + ", Indonesia"
      )}&count=1&language=id`
    ).then(r => r.json())

    if (!geo.results?.length) {
      return `😅 Aku nggak nemu kota *${city}*.`
    }

    const { latitude, longitude, name } = geo.results[0]
    const w = await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current_weather=true`
    ).then(r => r.json())

    const c = w.current_weather
    return `🌦️ Cuaca di *${name}*:
• Suhu: ${c.temperature}°C
• Angin: ${c.windspeed} km/jam`
  } catch {
    return "😅 Gagal ambil info cuaca."
  }
}

// ===== KURS USD → IDR (REALTIME, VALID) =====
async function toolUsdToIdr() {
  try {
    const res = await fetch("https://open.er-api.com/v6/latest/USD")
    const j = await res.json()

    if (j.result !== "success") throw new Error()

    const rate = j.rates.IDR
    return `💵 1 USD ≈ Rp ${rate.toLocaleString("id-ID")}`
  } catch {
    return "😅 Lagi nggak bisa ambil data kurs dolar."
  }
}

// ===== SEARCH INTERNET (NON-NUMERIC) =====
async function toolSearch(query) {
  try {
    const q = `${query} site:id`
    const res = await fetch(
      `https://api.duckduckgo.com/?q=${encodeURIComponent(
        q
      )}&format=json&kl=id-id&no_html=1&skip_disambig=1`
    )
    const j = await res.json()

    if (j.AbstractText) return j.AbstractText
    if (j.RelatedTopics?.length) return j.RelatedTopics[0].Text

    return "Hmm… aku belum nemu info yang pas 😅"
  } catch {
    return "😅 Lagi ada kendala waktu cari info."
  }
}

// ================= AI =================
async function askAI(jid, prompt) {
  const messages = [
    {
      role: "system",
      content:
        "Kamu adalah asisbot, teman ngobrol santai. " +
        "Selalu pakai Bahasa Indonesia yang ringan, nggak formal. " +
        "Jawaban singkat dan natural 🙂."
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
      temperature: 0.7
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
        await sock.sendMessage(from, { text: "🎉 Oke! Kamu sekarang owner." })
      } else {
        await sock.sendMessage(from, { text: "Owner-nya sudah ada 😅" })
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
          await sock.sendMessage(from, { text: "😅 Kamu bukan admin." })
        }
        return
      }

      if (lower === ".admin") {
        await sock.sendMessage(from, {
          text: `🛠️ Admin Menu
.admin reply on/off
.admin autoread on/off
.admin autotyping on/off
.admin add 628xxx
.admin del 628xxx
.admin list owner
.admin status`
        })
        return
      }

      if (lower === ".admin reply on") {
        config.replyActive = true; saveConfig()
        await sock.sendMessage(from, { text: "🔔 Reply diaktifkan." })
        return
      }

      if (lower === ".admin reply off") {
        config.replyActive = false; saveConfig()
        await sock.sendMessage(from, { text: "🔕 Reply dimatikan." })
        return
      }

      if (lower === ".admin status") {
        await sock.sendMessage(from, {
          text: `📊 Status:
Reply: ${config.replyActive}
AutoRead: ${config.autoread}
AutoTyping: ${config.autotyping}
Admin: ${config.admins.join(", ")}`
        })
        return
      }

      saveConfig()
      return
    }

    if (!config.botActive || !config.replyActive) return

    // ===== USD → IDR =====
    if (/dolar|usd/i.test(lower) && /rupiah|idr/i.test(lower)) {
      await sock.sendMessage(from, { text: await toolUsdToIdr() })
      return
    }

    // ===== WEATHER =====
    if (/cuaca|suhu/i.test(lower)) {
      const match = lower.match(/cuaca\s+(?:di\s+)?([a-z\s]+)/i)
      let city = match ? match[1].trim() : null

      if (city && isInvalidCity(city)) city = null

      if (city) {
        intent[from] = null
        await sock.sendMessage(from, { text: await toolWeather(city) })
        return
      }

      intent[from] = "ask_weather_city"
      await sock.sendMessage(from, { text: "📍 Di kota mana?" })
      return
    }

    if (intent[from] === "ask_weather_city") {
      await sock.sendMessage(from, { text: await toolWeather(text) })
      intent[from] = null
      return
    }

    // ===== TIME =====
    if (/jam|waktu|tanggal/i.test(lower)) {
      await sock.sendMessage(from, { text: toolTime() })
      return
    }

    // ===== AI + SEARCH FALLBACK =====
    remember(from, "user", text)

    let ans = await askAI(from, text)
    if (aiNotSure(ans)) {
      ans = `🔍 Aku cari dulu ya...\n\n${await toolSearch(text)}`
    }

    remember(from, "assistant", ans)
    await sock.sendMessage(from, { text: ans })
  })
}

startBot()
