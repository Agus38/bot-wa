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
const CONFIG_FILE = "./bot-config.json"

let config = JSON.parse(fs.readFileSync(CONFIG_FILE))
const saveConfig = () =>
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2))

// ================= TOOLS =================
const get_current_time = () => {
  const d = new Date()
  return `🕒 ${d.toLocaleDateString("id-ID", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "Asia/Jakarta"
  })}\n⏰ ${d.toLocaleTimeString("id-ID", { timeZone: "Asia/Jakarta" })}`
}

const web_search = async query => {
  const q = `${query} site:id`
  const res = await fetch(
    `https://api.duckduckgo.com/?q=${encodeURIComponent(
      q
    )}&format=json&kl=id-id&no_html=1`
  )
  const j = await res.json()
  return j.AbstractText || "😅 Aku belum nemu info yang pas."
}

const get_weather = async city => {
  const geo = await fetch(
    `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(
      city + ", Indonesia"
    )}&count=1`
  ).then(r => r.json())

  if (!geo.results?.length) return "😅 Kotanya nggak ketemu."

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

    const sender = (m.key.participant || from).split("@")[0]
    const isAdmin = config.admins.includes(sender)

    const text =
      m.message.conversation ||
      m.message.extendedTextMessage?.text ||
      ""
    const lower = text.toLowerCase().trim()

    // ===== CLAIM OWNER =====
    if (lower === ".claim") {
      if (config.admins.length === 0) {
        config.admins.push(sender)
        saveConfig()
        await sock.sendMessage(from, { text: "🎉 Kamu sekarang owner." })
      }
      return
    }

    // ===== MENU =====
    if (lower === ".menu" && isAdmin) {
      await sock.sendMessage(from, {
        text: `🛠️ MENU
.reply on/off
.autoread on/off
.autotyping on/off
.group on/off
.owner
.status`
      })
      return
    }

    if (!config.replyActive) return

    // ===== ADMIN SHORT COMMAND =====
    if (isAdmin) {
      if (lower === ".group on") config.respondGroup = true
      if (lower === ".group off") config.respondGroup = false
      if (lower === ".reply on") config.replyActive = true
      if (lower === ".reply off") config.replyActive = false
      if (lower === ".autoread on") config.autoread = true
      if (lower === ".autoread off") config.autoread = false
      if (lower === ".autotyping on") config.autotyping = true
      if (lower === ".autotyping off") config.autotyping = false

      if (lower.startsWith(".")) {
        saveConfig()
        await sock.sendMessage(from, { text: "✅ Oke, sudah diatur." })
        return
      }
    }

    // ===== TOOLS =====
    if (/jam|tanggal|waktu/i.test(lower)) {
      await sock.sendMessage(from, { text: get_current_time() })
      return
    }

    if (/cuaca/i.test(lower)) {
      const city = lower.replace(/.*di\s+/i, "")
      await sock.sendMessage(from, { text: await get_weather(city) })
      return
    }

    if (/hitung|=|\+|\-|\*|\//.test(lower)) {
      await sock.sendMessage(from, {
        text: `🧮 ${evaluate(text.replace(/hitung/gi, ""))}`
      })
      return
    }

    if (lower.startsWith("cari ")) {
      await sock.sendMessage(from, { text: await web_search(text.slice(5)) })
      return
    }

    await sock.sendMessage(from, { text: "🙂 Oke, jelasin dikit lagi ya." })
  })
}

startBot()
