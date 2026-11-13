import { defineConfig } from 'vite'
import { createStudio } from './server/studio.mjs'

/**
 * `npm run dev` is the page with live reload and the same /api as the real service: the map's API,
 * setup, and the engine when its port is free. The phone's door and the timetable are left to the
 * real service, so working on the page never starts a helper script.
 */
const api = () => ({
  name: 'botyard-api',
  async configureServer(server) {
    const studio = await createStudio({ phone: false, timetable: false, lenient: true })
    server.middlewares.use(studio.middleware)
    server.httpServer?.once('close', () => studio.close())
  },
})

export default defineConfig({
  plugins: [api()],
  // PORT lets a second copy run alongside the first without a flag on the command line.
  server: { port: Number(process.env.PORT) || 5274, strictPort: false },
  build: { target: 'esnext' },
})
