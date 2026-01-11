// prestart.cjs
const { execSync } = require("child_process")

const deps = [
  "@whiskeysockets/baileys",
  "node-fetch",
  "pino",
  "dotenv",
  "mathjs"
]

console.log("🔍 Mengecek dependency...\n")

for (const dep of deps) {
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
