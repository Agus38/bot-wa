// ================= AUTO DEPENDENCY CHECK =================
import { execSync } from "child_process"
import fs from "fs"

const requiredDeps = [
  "@whiskeysockets/baileys",
  "node-fetch",
  "pino",
  "dotenv",
  "mathjs"
]

console.log("🔍 Mengecek dependency...\n")

for (const dep of requiredDeps) {
  try {
    require.resolve(dep)
    console.log(`✅ ${dep}`)
  } catch {
    console.log(`⬇️  ${dep} belum ada, menginstall...`)
    execSync(`npm install ${dep}`, { stdio: "inherit" })
    console.log(`✅ ${dep} terpasang`)
  }
}

console.log("\n🚀 Semua dependency siap!\n")

// ================= CORE =================
import fetch from "node-fetch"
import { evaluate } from "mathjs"
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
const CONFIG_FILE = "./bot-config.json"

let config = {
  botActive: true,
  replyActive: true,
  respondGroup: false,
  autoread: false,
  autotyping: false,
  admins: []
}

if (fs.existsSync(CONFIG_FILE)) {
  config = { ...config, ...JSON.parse(fs.readFileSync(CONFIG_FILE)) }
}

const saveConfig = () =>
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2))

// ================= UTIL =================
function isInvalidCity(word) {
  return ["sekarang", "saat ini", "hari ini", "ini", "tadi"].includes(
    word.trim()
  )
}

// ================= TOOLS =================
function get_current_time() {
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

async function web_search(query) {
  try {
    const q = `${query} site:id`
    const res = await fetch(
      `https://api.duckduckgo.com/?q=${encodeURIComponent(
        q
      )}&format=json&kl=id-id&no_html=1`
    )
    const j = await res.json()
    if (j.AbstractText) return j.AbstractText
    if (j.RelatedTopics?.length) return j.RelatedTopics[0].Text
    return "😅 Aku belum nemu info yang pas."
  } catch {
    return "😅 Lagi ada kendala pas nyari info."
  }
}

async function get_weather(city) {
  try {
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
  } catch {
    return "😅 Gagal ambil info cuaca."
  }
}

function calculate_math(expr) {
  try {
    return `🧮 Hasilnya: ${evaluate(expr)}`
  } catch {
    return "😅 Hitungannya kayaknya salah."
  }
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
      console.log("🔐 Pairing Code:", code)
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

    const senderJid = m.key.participant || from
    const sender = senderJid.split("@")[0]
    const isAdmin = config.admins.includes(sender)

    const text =
      m.message.conversation ||
      m.message.extendedTextMessage?.text ||
      ""
    const lower = text.toLowerCase().trim()

    if (config.autoread) await sock.readMessages([m.key])
    if (config.autotyping) await sock.sendPresenceUpdate("composing", from)

    // ===== MENU ADMIN =====
    if (lower === ".menu" && isAdmin) {
      await sock.sendMessage(from, {
        text: `🛠️ MENU ADMIN
.reply on/off
.autoread on/off
.autotyping on/off
.group on/off
.owner
.status`
      })
      return
    }

    if (!config.botActive || !config.replyActive) return

    // ===== TOOLS =====
    if (/jam|tanggal|waktu/i.test(lower)) {
      await sock.sendMessage(from, { text: get_current_time() })
      return
    }

    if (/cuaca|perkiraan/i.test(lower)) {
      const match = lower.match(/di\s+([a-z\s]+)/i)
      let city = match ? match[1].trim() : null
      if (city && isInvalidCity(city)) city = null

      if (city) {
        await sock.sendMessage(from, { text: await get_weather(city) })
      } else {
        await sock.sendMessage(from, { text: "📍 Di kota mana?" })
      }
      return
    }

    if (/hitung|=|\+|\-|\*|\//.test(lower)) {
      await sock.sendMessage(from, {
        text: calculate_math(text.replace(/hitung/gi, "").trim())
      })
      return
    }

    if (lower.startsWith("cari ")) {
      await sock.sendMessage(from, { text: await web_search(text.slice(5)) })
      return
    }

    await sock.sendMessage(from, {
      text: "🙂 Oke, tapi coba jelasin dikit lagi ya."
    })
  })
}

startBot()
