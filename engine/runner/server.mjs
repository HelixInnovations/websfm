// One job's HTTP server on 127.0.0.1: the frozen engine build and that job's photos,
// from one origin, so the page is cross-origin isolated (COOP/COEP, which WASM threads
// need) and fetches its inputs without CORS.
//
//   const srv = await startJobServer({ buildDir, inputDir })
//   srv.url           'http://127.0.0.1:<port>'
//   await srv.close()
//
// Routes:
//   /job/input/<file name>   a photo from inputDir, streamed from disk (never a path:
//                            a name with a slash or a dot-dot is refused)
//   anything else            a file of buildDir, with COOP/COEP
//
// Photos stream from disk rather than through Playwright's route interception: the
// bench found one CDP message per file fails on multi-GB flights.
import { createServer } from 'node:http'
import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { extname, join, resolve, sep } from 'node:path'

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.dng': 'image/x-adobe-dng',
  '.onnx': 'application/octet-stream',
  '.z': 'application/octet-stream',
}

const ISOLATION = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
}

/** A file name the job may serve: no directory part, no traversal, no NUL. */
export function safeInputName(name) {
  return typeof name === 'string' && name.length > 0 && !/[/\\\0]/.test(name) && name !== '.' && name !== '..'
}

/** `rel` inside `root`, or null if it would leave it. */
export function insideRoot(root, rel) {
  const base = resolve(root)
  const full = resolve(base, '.' + sep + rel)
  return full === base || full.startsWith(base + sep) ? full : null
}

export async function startJobServer({ buildDir, inputDir, host = '127.0.0.1', port = 0 }) {
  const server = createServer(async (req, res) => {
    let path
    try {
      path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname)
    } catch {
      res.writeHead(400).end()
      return
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' }).end()
      return
    }
    if (path.startsWith('/job/input/')) {
      const name = path.slice('/job/input/'.length)
      const file = safeInputName(name) ? join(inputDir, name) : null
      const info = file ? await stat(file).catch(() => null) : null
      if (!info?.isFile()) {
        res.writeHead(404, ISOLATION).end()
        return
      }
      res.writeHead(200, {
        ...ISOLATION,
        'Content-Type': MIME[extname(name).toLowerCase()] ?? 'application/octet-stream',
        'Content-Length': info.size,
      })
      if (req.method === 'HEAD') return res.end()
      createReadStream(file)
        .on('error', () => res.destroy())
        .pipe(res)
      return
    }
    const file = insideRoot(buildDir, path === '/' ? '/engine/page/engine.html' : path)
    try {
      if (!file) throw new Error('outside the build')
      const body = await readFile(file)
      res.writeHead(200, {
        ...ISOLATION,
        'Content-Type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
      })
      res.end(req.method === 'HEAD' ? undefined : body)
    } catch {
      res.writeHead(404, ISOLATION).end()
    }
  })
  await new Promise((ok, fail) => {
    server.once('error', fail)
    server.listen(port, host, ok)
  })
  const { port: actual } = server.address()
  return {
    url: `http://${host}:${actual}`,
    close: () => new Promise((ok) => server.close(() => ok())),
  }
}
