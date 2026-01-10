// ================= CORE =================
import fs from "fs"
import fetch from "node-fetch"
import "dotenv/config"
import { evaluate } from "mathjs"
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
  replyActive: true,
  respondGroup: false,
  admins: []
}

if (fs.existsSync(CONFIG_FILE)) {
  config = { ...config, ...JSON.parse(fs.readFileSync(CONFIG_FILE)) }
}
const saveConfig = () =>
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2))

// ================= TOOL HELPERS =================
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

async function web_search(query, num_results = 5) {
  const q = `${query} site:id`
  const res = await fetch(
    `https://api.duckduckgo.com/?q=${encodeURIComponent(
      q
    )}&format=json&kl=id-id&no_html=1`
  )
  const j = await res.json()
  if (j.AbstractText) return j.AbstractText
  if (j.RelatedTopics?.length)
    return j.RelatedTopics.slice(0, num_results).map(v => `• ${v.Text}`).join("\n")
  return "😅 Aku nggak nemu hasil yang relevan."
}

async function get_weather(location, date = null) {
  try {
    const geo = await fetch(
      `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(
        location + ", Indonesia"
      )}&count=1&language=id`
    ).then(r => r.json())

    if (!geo.results?.length)
      return `😅 Aku nggak nemu kota *${location}*.`

    const { latitude, longitude, name } = geo.results[0]
    const w = await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current_weather=true`
    ).then(r => r.json())

    const c = w.current_weather
    return `🌦️ Cuaca di *${name}*
• Suhu: ${c.temperature}°C
• Angin: ${c.windspeed} km/jam`
  } catch {
    return "😅 Gagal ambil info cuaca."
  }
}

function calculate_math(expression) {
  try {
    return `🧮 Hasilnya: ${evaluate(expression)}`
  } catch {
    return "😅 Rumusnya kayaknya salah."
  }
}

async function analyze_image(image) {
  // placeholder aman (vision API optional)
  return "🖼️ Aku sudah terima gambarnya. Untuk analisis visual lanjut, aktifkan Vision API."
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
    if (from.endsWith("@g.us") && !config.respondGroup) return

    const text =
      m.message.conversation ||
      m.message.extendedTextMessage?.text ||
      ""

    const lower = text.toLowerCase()

    if (!config.botActive || !config.replyActive) return

    // ===== AUTO TOOL SELECTION =====

    if (/jam|tanggal|waktu/i.test(lower)) {
      await sock.sendMessage(from, { text: get_current_time() })
      return
    }

    if (/cuaca|perkiraan/i.test(lower)) {
      const city = lower.replace(/.*di\s+/i, "").trim()
      await sock.sendMessage(from, { text: await get_weather(city) })
      return
    }

    if (/hitung|berapa hasil|=|\+|\-|\*|\//.test(lower)) {
      await sock.sendMessage(from, {
        text: calculate_math(text.replace(/hitung/gi, "").trim())
      })
      return
    }

    if (lower.startsWith("cari ")) {
      await sock.sendMessage(from, {
        text: await web_search(text.slice(5))
      })
      return
    }

    if (m.message.imageMessage) {
      await sock.sendMessage(from, {
        text: await analyze_image("uploaded_file")
      })
      return
    }

    // ===== FALLBACK AI (CHITCHAT) =====
    await sock.sendMessage(from, {
      text: "🙂 Aku ngerti. Tapi buat info spesifik, coba tanyakan lebih jelas ya."
    })
  })
}

startBot()
