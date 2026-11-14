import { defineConfig } from 'vite'
import { execFileSync } from 'node:child_process'
import react from '@vitejs/plugin-react'

let build = 'development'
try { build = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim() } catch {}
export default defineConfig({
  define: { 'import.meta.env.VITE_CWEB_BUILD': JSON.stringify(build) },
  plugins: [react()],
  server: { host: '127.0.0.1' },
  build: { outDir: 'dist', emptyOutDir: true },
})
