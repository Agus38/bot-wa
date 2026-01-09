// ================= AUTO CHECK DEPENDENCY =================
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
const GROQ_KEY = process.env.GROQ_API_KEY
const BOT_NAME = "asisbot"

let config = {
  botActive: true,
  memoryLimit: 8
}

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
  return `🕒 Sekarang ${d.toLocaleDateString("id-ID", {
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
    if (!geo.results?.length) return "Kota-nya belum ketemu 😅"

    const { latitude, longitude, name } = geo.results[0]
    const w = await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current_weather=true`
    ).then(r => r.json())

    const c = w.current_weather
    return `🌦️ Cuaca sekarang di ${name}\n• Suhu: ${c.temperature}°C\n• Angin: ${c.windspeed} km/jam`
  } catch {
    return "Gagal ambil data cuaca 😅"
  }
}

// ================= AI (GROQ) =================
async function askAI(jid, prompt) {
  const messages = [
    {
      role: "system",
      content:
        `Kamu adalah ${BOT_NAME}, teman ngobrol yang santai 🙂. ` +
        `Jawaban tidak formal, pakai emoticon seperlunya. ` +
        `Jangan pernah berikan informasi sensitif atau data pribadi.`
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

// ================= NLP RULES =================
function isTimeQuestion(t) {
  return /(jam|pukul|waktu|sekarang jam|hari ini tanggal)/i.test(t)
}

function isWeatherQuestion(t) {
  return /(cuaca|suhu|panas|dingin|hujan)/i.test(t)
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
    if (u.connection === "open") log.ok(`${BOT_NAME} siap dipakai`)
  })

  sock.ev.on("messages.upsert", async ({ messages }) => {
    const m = messages[0]
    if (!m?.message || m.key.fromMe || m.key.remoteJid === "status@broadcast") return

    const from = m.key.remoteJid
    const text =
      m.message.conversation ||
      m.message.extendedTextMessage?.text ||
      ""

    log.in(from, text)

    const lower = text.toLowerCase()

    // ===== HARD RULES =====
    if (/(siapa penciptamu|pengembangmu|developer)/i.test(lower)) {
      const out = "Aku dibuat oleh **Agus Hermanto**, didukung Meta 🙂"
      await sock.sendMessage(from, { text: out })
      log.out(from, "creator")
      return
    }

    if (/(kapan.*diciptakan|kapan kamu dibuat)/i.test(lower)) {
      const out = "Aku lahir di **Januari 2026** 😄"
      await sock.sendMessage(from, { text: out })
      log.out(from, "created_at")
      return
    }

    // ===== TOOLS =====
    if (isTimeQuestion(lower)) {
      const out = toolTime()
      await sock.sendMessage(from, { text: out })
      log.out(from, "TIME")
      return
    }

    if (isWeatherQuestion(lower)) {
      const city = text.match(/di (.+)/i)?.[1] || "Jakarta"
      const out = await toolWeather(city)
      await sock.sendMessage(from, { text: out })
      log.out(from, "WEATHER")
      return
    }

    // ===== AI CHAT (WITH MEMORY) =====
    pushMem(from, "user", text)
    const ans = await askAI(from, text)
    pushMem(from, "assistant", ans)

    await sock.sendMessage(from, { text: ans })
    log.out(from, "AI")
  })
}

startBot()
