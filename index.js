// ================= AUTO DEP CHECK =================
import fs from "fs"
import { execSync } from "child_process"

const deps = ["@whiskeysockets/baileys", "pino", "chalk", "node-fetch", "dotenv"]
if (!fs.existsSync("node_modules")) execSync("npm install", { stdio: "inherit" })
for (const d of deps) {
  const n = d.split("/").pop()
  if (!fs.existsSync(`node_modules/${n}`)) execSync(`npm install ${d}`, { stdio: "inherit" })
}

// ================= IMPORT =================
import "dotenv/config"
import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore
} from "@whiskeysockets/baileys"
import Pino from "pino"
import readline from "readline"
import chalk from "chalk"
import fetch from "node-fetch"

// ================= CONFIG =================
const BOT_NAME = "asisbot"
const GROQ_KEY = process.env.GROQ_API_KEY
const CONFIG_FILE = "./bot-config.json"

let config = {
  botActive: true,
  respondGroup: false,
  memoryLimit: 8,
  admins: ["6285607063906@s.whatsapp.net"]
}

if (fs.existsSync(CONFIG_FILE)) {
  config = { ...config, ...JSON.parse(fs.readFileSync(CONFIG_FILE)) }
}
const saveConfig = () =>
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2))

// ================= MEMORY =================
const memory = {}
const pushMem = (jid, role, content) => {
  if (!memory[jid]) memory[jid] = []
  memory[jid].push({ role, content })
  if (memory[jid].length > config.memoryLimit) {
    memory[jid] = memory[jid].slice(-config.memoryLimit)
  }
}

// ================= LOGGER =================
const t = () => chalk.gray(`[${new Date().toLocaleTimeString("id-ID")}]`)
const log = {
  in: (f, m) => console.log(`${t()} ${chalk.blue("⬇")} ${chalk.yellow(f)}: ${m}`),
  out: (f, m) => console.log(`${t()} ${chalk.green("⬆")} ${chalk.yellow(f)}: ${m}`),
  ok: (m) => console.log(`${t()} ${chalk.green("✔")} ${m}`)
}

// ================= TOOLS =================
function toolTime() {
  const d = new Date()
  return `🕒 ${d.toLocaleDateString("id-ID", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric"
  })}\n⏰ Jam ${d.toLocaleTimeString("id-ID")}`
}

async function toolWeather(city = "Jakarta") {
  try {
    const geo = await fetch(
      `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=id`
    ).then(r => r.json())
    if (!geo.results?.length) return "Kota tidak ditemukan 😅"

    const { latitude, longitude, name } = geo.results[0]
    const w = await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current_weather=true`
    ).then(r => r.json())

    const c = w.current_weather
    return `🌦️ Cuaca di ${name}\n• Suhu: ${c.temperature}°C\n• Angin: ${c.windspeed} km/jam`
  } catch {
    return "Gagal ambil data cuaca 😅"
  }
}

// ================= AI =================
async function askAI(jid, prompt) {
  const messages = [
    {
      role: "system",
      content:
        `Kamu adalah ${BOT_NAME}, teman ngobrol santai 🙂. ` +
        `Jawaban singkat, tidak formal, pakai emoticon seperlunya. ` +
        `Jangan pernah membahas data sensitif atau pribadi.`
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
  return j.choices?.[0]?.message?.content || "Aku belum kepikiran jawabannya 😅"
}

// ================= ADMIN BUTTON =================
function adminButtons() {
  return {
    text: "🛠️ Admin Menu",
    footer: BOT_NAME,
    buttons: [
      { buttonId: "ADMIN_ON", buttonText: { displayText: "🟢 Bot ON" }, type: 1 },
      { buttonId: "ADMIN_OFF", buttonText: { displayText: "🔴 Bot OFF" }, type: 1 },
      { buttonId: "GROUP_ON", buttonText: { displayText: "👥 Grup ON" }, type: 1 },
      { buttonId: "GROUP_OFF", buttonText: { displayText: "🚫 Grup OFF" }, type: 1 },
      { buttonId: "ADMIN_STATUS", buttonText: { displayText: "📊 Status" }, type: 1 }
    ]
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
    auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, Pino()) },
    browser: ["Ubuntu", "Chrome", "120.0.0.0"]
  })

  if (!state.creds.registered) {
    rl.question("Nomor WA (62xxxx): ", async n => {
      const code = await sock.requestPairingCode(n.replace(/\D/g, ""))
      console.log("PAIRING:", code)
      rl.close()
    })
  }

  sock.ev.on("creds.update", saveCreds)
  sock.ev.on("connection.update", u => {
    if (u.connection === "open") log.ok(`${BOT_NAME} siap digunakan`)
  })

  sock.ev.on("messages.upsert", async ({ messages }) => {
    const m = messages[0]
    if (!m?.message || m.key.fromMe || m.key.remoteJid === "status@broadcast") return

    const from = m.key.remoteJid
    const isGroup = from.endsWith("@g.us")
    const sender = isGroup ? m.key.participant : from
    const isAdmin = config.admins.includes(sender)

    const rawText =
      m.message.conversation ||
      m.message.extendedTextMessage?.text ||
      m.message.buttonsResponseMessage?.selectedButtonId ||
      ""

    const lower = rawText.trim().toLowerCase()
    log.in(from, rawText)

    // ===== GROUP FILTER =====
    if (isGroup && !config.respondGroup) return

    // ===== ADMIN MENU (PALING AWAL) =====
    if (isAdmin && lower === ".admin") {
      await sock.sendMessage(from, adminButtons())
      log.out(from, "ADMIN MENU")
      return
    }

    // ===== ADMIN BUTTON ACTION =====
    if (isAdmin && ["ADMIN_ON", "ADMIN_OFF", "GROUP_ON", "GROUP_OFF", "ADMIN_STATUS"].includes(rawText)) {

      if (rawText === "ADMIN_ON") config.botActive = true
      if (rawText === "ADMIN_OFF") config.botActive = false
      if (rawText === "GROUP_ON") config.respondGroup = true
      if (rawText === "GROUP_OFF") config.respondGroup = false

      if (rawText === "ADMIN_STATUS") {
        await sock.sendMessage(from, {
          text: `📊 STATUS
Bot: ${config.botActive ? "ON 🟢" : "OFF 🔴"}
Respon Grup: ${config.respondGroup ? "ON 🟢" : "OFF 🔴"}
Admin: ${config.admins.length}`
        })
        saveConfig()
        return
      }

      saveConfig()
      await sock.sendMessage(from, { text: "✅ Beres 👍" })
      return
    }

    if (!config.botActive) return

    // ===== HARD RULE =====
    if (/penciptamu|pengembangmu|developer/i.test(lower)) {
      await sock.sendMessage(from, { text: "Aku dibuat oleh Agus Hermanto, didukung Meta 🙂" })
      return
    }

    if (/kapan.*diciptakan/i.test(lower)) {
      await sock.sendMessage(from, { text: "Aku lahir di Januari 2026 😄" })
      return
    }

    // ===== TOOLS =====
    if (/jam|pukul|waktu|sekarang/i.test(lower)) {
      await sock.sendMessage(from, { text: toolTime() })
      return
    }

    if (/cuaca|suhu|panas|dingin|hujan/i.test(lower)) {
      const city = rawText.match(/di (.+)/i)?.[1] || "Jakarta"
      const out = await toolWeather(city)
      await sock.sendMessage(from, { text: out })
      return
    }

    // ===== AI CHAT =====
    pushMem(from, "user", rawText)
    const ans = await askAI(from, rawText)
    pushMem(from, "assistant", ans)
    await sock.sendMessage(from, { text: ans })
  })
}

startBot()
