// ================= AUTO CHECK DEPENDENCY =================
import fs from "fs"
import { execSync } from "child_process"

const requiredDeps = [
  "@whiskeysockets/baileys",
  "pino",
  "chalk",
  "node-fetch",
  "dotenv"
]

function ensureDeps() {
  if (!fs.existsSync("node_modules")) {
    execSync("npm install", { stdio: "inherit" })
    return
  }
  for (const dep of requiredDeps) {
    const name = dep.split("/").pop()
    if (!fs.existsSync(`node_modules/${name}`)) {
      execSync(`npm install ${dep}`, { stdio: "inherit" })
    }
  }
}
ensureDeps()

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
const GROQ_KEY = process.env.GROQ_API_KEY
const CONFIG_FILE = "./bot-config.json"

let config = {
  botActive: true,
  aiActive: true,
  aiMode: "public", // public | admin
  memoryActive: true,
  memoryLimit: 6,
  aiDelay: 600,
  admins: ["6285607063906@s.whatsapp.net"] // GANTI ADMIN
}

if (fs.existsSync(CONFIG_FILE)) {
  config = { ...config, ...JSON.parse(fs.readFileSync(CONFIG_FILE)) }
}
const saveConfig = () =>
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2))

// ================= MEMORY =================
const memory = {}
const pushMemory = (jid, role, content) => {
  if (!memory[jid]) memory[jid] = []
  memory[jid].push({ role, content })
  if (memory[jid].length > config.memoryLimit) {
    memory[jid] = memory[jid].slice(-config.memoryLimit)
  }
}
const clearMemory = (jid) => delete memory[jid]

// ================= LOGGER =================
const time = () => chalk.gray(`[${new Date().toLocaleTimeString()}]`)
const log = {
  in: (f, m) => console.log(`${time()} ${chalk.blue("⬇")} ${chalk.yellow(f)}: ${m}`),
  out: (t, m) => console.log(`${time()} ${chalk.green("⬆")} ${chalk.yellow(t)}: ${m}`),
  ok: (m) => console.log(`${time()} ${chalk.green("✔")} ${m}`),
  warn: (m) => console.log(`${time()} ${chalk.yellow("⚠")} ${m}`),
  err: (m) => console.log(`${time()} ${chalk.red("✖")} ${m}`)
}

// ================= TOOLS =================
// Tanggal & waktu (lokal)
function toolDateTime() {
  const d = new Date()
  const hari = d.toLocaleDateString("id-ID", { weekday: "long" })
  const tanggal = d.toLocaleDateString("id-ID")
  const jam = d.toLocaleTimeString("id-ID")
  return `📅 ${hari}, ${tanggal}\n⏰ Jam sekarang: ${jam}`
}

// Cuaca (tanpa API key) – Open-Meteo
async function toolWeather(city) {
  try {
    // geocoding
    const geo = await fetch(
      `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=id`
    ).then(r => r.json())
    if (!geo.results?.length) return "❌ Kota tidak ditemukan."

    const { latitude, longitude, name, country } = geo.results[0]
    const w = await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current_weather=true`
    ).then(r => r.json())

    const cw = w.current_weather
    return `🌦️ Cuaca ${name}, ${country}\n• Suhu: ${cw.temperature}°C\n• Angin: ${cw.windspeed} km/jam`
  } catch {
    return "❌ Gagal mengambil data cuaca."
  }
}

// ================= AI (GROQ) =================
async function askAI(jid, prompt) {
  try {
    const messages = []

    // System persona (ramah + aman)
    messages.push({
      role: "system",
      content:
        "Kamu adalah asisten ramah seperti teman 🙂. Jawaban singkat, jelas, pakai emoticon ringan. Jangan pernah memberikan informasi sensitif, data pribadi, atau hal berbahaya."
    })

    if (config.memoryActive && memory[jid]) {
      messages.push(...memory[jid])
    }

    messages.push({ role: "user", content: prompt })

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

    const json = await res.json()
    if (!res.ok) {
      console.log("GROQ ERROR:", json)
      return "❌ AI lagi bermasalah. Coba lagi ya 🙂"
    }

    return json.choices?.[0]?.message?.content || "AI tidak merespons."
  } catch (e) {
    console.log("GROQ CRASH:", e.message)
    return "❌ AI crash."
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
      keys: makeCacheableSignalKeyStore(state.keys, Pino({ level: "silent" }))
    },
    browser: ["Ubuntu", "Chrome", "120.0.0.0"]
  })

  // Pairing
  if (!state.creds.registered) {
    rl.question("Nomor WA (62xxxx): ", async (n) => {
      const code = await sock.requestPairingCode(n.replace(/[^0-9]/g, ""))
      console.log("🔐 PAIRING CODE:", code)
      rl.close()
    })
  }

  sock.ev.on("creds.update", saveCreds)
  sock.ev.on("connection.update", ({ connection }) => {
    if (connection === "open") log.ok("BOT TERHUBUNG & SIAP")
  })

  // Messages
  sock.ev.on("messages.upsert", async ({ messages }) => {
    const msg = messages[0]
    if (!msg?.message) return
    if (msg.key.fromMe) return
    if (msg.key.remoteJid === "status@broadcast") return

    const from = msg.key.remoteJid
    const isAdmin = config.admins.includes(from)

    const rawText =
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text ||
      ""

    const text = rawText.trim().toLowerCase()
    log.in(from, rawText)

    // Status
    if (text === ".status") {
      await sock.sendMessage(from, {
        text: `🤖 STATUS
Bot: ${config.botActive ? "ON 🟢" : "OFF 🔴"}
AI: ${config.aiActive ? "ON 🟢" : "OFF 🔴"}
Memory: ${config.memoryActive ? "ON 🟢" : "OFF 🔴"}
AI Mode: ${config.aiMode}`
      })
      return
    }

    if (!config.botActive) return

    // Admin controls
    if (isAdmin) {
      if (text === ".ai on") config.aiActive = true
      if (text === ".ai off") config.aiActive = false
      if (text === ".ai admin") config.aiMode = "admin"
      if (text === ".ai public") config.aiMode = "public"
      if (text === ".memory on") config.memoryActive = true
      if (text === ".memory off") config.memoryActive = false
      if (text === ".memory clear") clearMemory(from)
      saveConfig()
    }

    // Tools commands
    if (text === "tanggal" || text === "hari" || text === "jam") {
      const out = toolDateTime()
      await sock.sendMessage(from, { text: out })
      log.out(from, "datetime")
      return
    }

    if (text.startsWith("cuaca ")) {
      const city = rawText.slice(7).trim()
      const out = await toolWeather(city)
      await sock.sendMessage(from, { text: out })
      log.out(from, "weather")
      return
    }

    // AI
    if (text.startsWith("ai ")) {
      if (!config.aiActive) return
      if (config.aiMode === "admin" && !isAdmin) return

      const prompt = rawText.slice(3).trim()
      if (config.memoryActive) pushMemory(from, "user", prompt)

      if (config.aiDelay) await new Promise(r => setTimeout(r, config.aiDelay))
      await sock.sendMessage(from, { text: "🤔 mikir bentar ya..." })

      const answer = await askAI(from, prompt)
      if (config.memoryActive) pushMemory(from, "assistant", answer)

      await sock.sendMessage(from, { text: answer })
      log.out(from, "AI response")
      return
    }

    // Basic
    if (text === "ping") {
      await sock.sendMessage(from, { text: "pong 🟢" })
      log.out(from, "pong")
      return
    }

    if (text === "menu") {
      await sock.sendMessage(from, {
        text: `🤖 MENU
• ping
• menu
• .status
• tanggal | hari | jam
• cuaca <kota>
• ai <pertanyaan>`
      })
      log.out(from, "menu")
    }
  })
}

startBot()
