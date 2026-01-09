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
  admins: [] // admin diisi via .claim
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
    return "❌ Gagal ambil cuaca"
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
    const senderNumber = senderJid.split("@")[0]
    const isAdmin = config.admins.includes(senderNumber)

    const raw =
      m.message.conversation ||
      m.message.extendedTextMessage?.text ||
      ""

    const text = raw.trim()
    const lower = text.toLowerCase()

    // ================= CLAIM OWNER =================
    if (lower === ".claim") {
      if (config.admins.length === 0) {
        config.admins.push(senderNumber)
        saveConfig()
        console.log(`[OWNER CLAIMED] ${senderNumber}`)
        await sock.sendMessage(from, {
          text: "✅ Kamu sekarang ADMIN pertama (OWNER)."
        })
      } else {
        await sock.sendMessage(from, {
          text: "⛔ Owner sudah ditetapkan."
        })
      }
      return
    }

    // ================= COMMAND ROUTER =================
    if (text.startsWith(".")) {
      if (!isAdmin) {
        console.log(`[ADMIN DENIED] ${senderNumber}: ${text}`)
        if (config.notifyNonAdmin) {
          await sock.sendMessage(from, { text: "⛔ Kamu bukan admin." })
        }
        return
      }

      if (lower === ".admin") {
        await sock.sendMessage(from, {
          text: `🛠️ ADMIN MENU
.admin on
.admin off
.admin group on
.admin group off
.admin status
.admin add 628xxx
.admin del 628xxx`
        })
        return
      }

      if (lower === ".admin on") config.botActive = true
      if (lower === ".admin off") config.botActive = false
      if (lower === ".admin group on") config.respondGroup = true
      if (lower === ".admin group off") config.respondGroup = false

      if (lower.startsWith(".admin add ")) {
        const num = lower.split(" ")[2]?.replace(/\D/g, "")
        if (!num) {
          await sock.sendMessage(from, { text: "❌ Format salah. Contoh: .admin add 628xxx" })
          return
        }
        if (config.admins.includes(num)) {
          await sock.sendMessage(from, { text: "ℹ️ Nomor ini sudah admin." })
          return
        }
        config.admins.push(num)
        saveConfig()
        await sock.sendMessage(from, { text: `✅ ${num} ditambahkan sebagai admin.` })
        return
      }

      if (lower.startsWith(".admin del ")) {
        const num = lower.split(" ")[2]?.replace(/\D/g, "")
        if (!config.admins.includes(num)) {
          await sock.sendMessage(from, { text: "❌ Nomor ini bukan admin." })
          return
        }
        if (config.admins.length === 1) {
          await sock.sendMessage(from, { text: "⛔ Tidak bisa hapus admin terakhir." })
          return
        }
        config.admins = config.admins.filter(a => a !== num)
        saveConfig()
        await sock.sendMessage(from, { text: `🗑️ ${num} dihapus dari admin.` })
        return
      }

      if (lower === ".admin status") {
        await sock.sendMessage(from, {
          text: `📊 STATUS
Bot: ${config.botActive ? "ON" : "OFF"}
Respon Grup: ${config.respondGroup ? "ON" : "OFF"}
Admin: ${config.admins.join(", ")}`
        })
        saveConfig()
        return
      }

      saveConfig()
      await sock.sendMessage(from, { text: "✅ Perintah admin dijalankan" })
      return
    }

    if (!config.botActive) return

    // ================= HARD RULE =================
    if (/pencipt|pengembang|developer/i.test(lower)) {
      await sock.sendMessage(from, {
        text: "Aku dibuat oleh **Agus Hermanto**, didukung Meta 🙂"
      })
      return
    }

    if (/kapan.*diciptakan/i.test(lower)) {
      await sock.sendMessage(from, {
        text: "Aku dibuat pada **Januari 2026** 😄"
      })
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
