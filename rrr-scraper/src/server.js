/**
 * server.js — Simple Express API around the rrr.lt scraper.
 *
 * Endpoints:
 *   POST /api/scrape          { seller?, name?, concurrency?, browser?, proxy? }
 *   GET  /api/jobs            list all jobs
 *   GET  /api/jobs/:id        job status + logs tail
 *   GET  /api/data/:name      return scraped JSON (or JSONL as JSON array)
 *   DELETE /api/jobs/:id      kill a running job
 */

import express from 'express'
import { spawn } from 'child_process'
import { existsSync, readFileSync, createReadStream } from 'fs'
import { createInterface } from 'readline'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { randomUUID } from 'crypto'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const OUTPUT_ROOT = join(ROOT, 'output')

const app = express()
app.use(express.json())

// ── Job registry ──────────────────────────────────────────────────────────────

const jobs = new Map()  // id → { id, status, params, logs, pid, startedAt, finishedAt, exitCode }

function createJob(params) {
  const id = randomUUID()
  const job = {
    id,
    status: 'pending',
    params,
    logs: [],
    pid: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    exitCode: null,
  }
  jobs.set(id, job)
  return job
}

// ── Scraper launcher ──────────────────────────────────────────────────────────

function launchScraper(job) {
  const { params } = job
  const args = []

  if (params.seller)      args.push('--seller', params.seller)
  if (params.name)        args.push('--name', params.name)
  if (params.concurrency) args.push('--concurrency', String(params.concurrency))
  if (params.browser)     args.push('--browser')
  if (params.proxy)       args.push('--proxy')
  if (params.enrichOnly)  args.push('--enrich-only')

  const child = spawn('node', [join(__dirname, 'fetch_parts.js'), ...args], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  job.status = 'running'
  job.pid = child.pid

  const appendLog = (line) => {
    job.logs.push(line)
    if (job.logs.length > 2000) job.logs.shift()  // cap memory
  }

  child.stdout.on('data', d => d.toString().split('\n').filter(Boolean).forEach(appendLog))
  child.stderr.on('data', d => d.toString().split('\n').filter(Boolean).forEach(appendLog))

  child.on('close', code => {
    job.status = code === 0 ? 'done' : code === 2 ? 'partial' : 'failed'
    job.exitCode = code
    job.finishedAt = new Date().toISOString()
  })

  return child
}

// ── Routes ────────────────────────────────────────────────────────────────────

// POST /api/scrape — start a scrape job
app.post('/api/scrape', (req, res) => {
  const { seller = '', concurrency = 20, browser = false, proxy = false, enrichOnly = false } = req.body
  let { name = '' } = req.body

  if (!seller && !name) {
    return res.status(400).json({ error: 'Provide at least "seller" URL or "name" output folder' })
  }

  // Auto-derive name from seller URL slug (e.g. https://rrr.lt/bmwpartsloo → "bmwpartsloo")
  if (!name && seller) {
    try {
      name = new URL(seller).pathname.replace(/^\/+|\/+$/g, '') || 'output'
    } catch {
      name = 'output'
    }
  }

  const job = createJob({ seller, name, concurrency, browser, proxy, enrichOnly })
  launchScraper(job)

  res.status(202).json({ jobId: job.id, name, status: job.status, message: 'Scrape started' })
})

// GET /api/jobs — list all jobs
app.get('/api/jobs', (_req, res) => {
  const list = [...jobs.values()].map(({ id, status, params, startedAt, finishedAt, exitCode }) => ({
    id, status, params, startedAt, finishedAt, exitCode,
  }))
  res.json(list)
})

// GET /api/jobs/:id — job status + last 100 log lines
app.get('/api/jobs/:id', (req, res) => {
  const job = jobs.get(req.params.id)
  if (!job) return res.status(404).json({ error: 'Job not found' })
  const { id, status, params, startedAt, finishedAt, exitCode, logs } = job
  res.json({ id, status, params, startedAt, finishedAt, exitCode, logs: logs.slice(-100) })
})

// DELETE /api/jobs — clear all finished jobs (done/failed/cancelled/partial)
app.delete('/api/jobs', (_req, res) => {
  let killed = 0, cleared = 0
  for (const [id, job] of jobs) {
    if (job.status === 'running') {
      try { process.kill(job.pid, 'SIGTERM') } catch {}
      job.status = 'cancelled'
      job.finishedAt = new Date().toISOString()
      killed++
    }
    jobs.delete(id)
    cleared++
  }
  res.json({ message: `Cleared ${cleared} job(s), killed ${killed} running` })
})

// DELETE /api/jobs/:id — kill or clear a single job
app.delete('/api/jobs/:id', (req, res) => {
  const job = jobs.get(req.params.id)
  if (!job) return res.status(404).json({ error: 'Job not found' })
  if (job.status === 'running') {
    try { process.kill(job.pid, 'SIGTERM') } catch {}
    job.status = 'cancelled'
    job.finishedAt = new Date().toISOString()
  }
  jobs.delete(req.params.id)
  res.json({ message: `Job ${req.params.id} removed` })
})

// GET /api/data/:name — return scraped data as JSON array
// :name matches the --name param used when scraping, or "output" for default
app.get('/api/data/:name(*)', async (req, res) => {
  const name = req.params.name || 'output'
  const jsonPath  = join(ROOT, name, 'parts_data.json')
  const jsonlPath = join(ROOT, name, 'parts_data.jsonl')

  if (existsSync(jsonPath)) {
    res.setHeader('Content-Type', 'application/json')
    return createReadStream(jsonPath).pipe(res)
  }

  if (existsSync(jsonlPath)) {
    // Stream-convert JSONL → JSON array on the fly
    const parts = []
    const rl = createInterface({ input: createReadStream(jsonlPath, { encoding: 'utf-8' }), crlfDelay: Infinity })
    for await (const line of rl) {
      if (!line.trim()) continue
      try { parts.push(JSON.parse(line)) } catch {}
    }
    return res.json(parts)
  }

  res.status(404).json({ error: `No data found for name="${name}". Run a scrape first.` })
})

// GET /api/data — shortcut for default output folder
app.get('/api/data', (_req, res) => res.redirect('/api/data/output'))

// Health check
app.get('/health', (_req, res) => res.json({ ok: true, jobs: jobs.size }))

// Root help
app.get('/', (_req, res) => res.json({
  endpoints: {
    'POST /api/scrape':       'Start scrape. Body: { seller?, name?, concurrency?, browser?, proxy?, enrichOnly? }',
    'GET  /api/jobs':         'List all jobs',
    'GET  /api/jobs/:id':     'Job status + logs',
    'DELETE /api/jobs/:id':   'Kill running job',
    'GET  /api/data/:name':   'Fetch scraped data (use --name value, default: "output")',
    'GET  /health':           'Health check',
  },
}))

// ── Start ─────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000
app.listen(PORT, () => {
  console.log(`rrr-scraper API running on http://localhost:${PORT}`)
})
