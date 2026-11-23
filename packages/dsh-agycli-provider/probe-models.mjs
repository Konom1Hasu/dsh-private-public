import { spawn } from 'node:child_process'
const bin = 'C:\\Users\\KonomiHasu\\.dsh\\profiles\\web\\agy-runtime\\bin\\agy.exe'
const env = { ...process.env, AGY_CLI_DISABLE_AUTO_UPDATE: 'true', HTTP_PROXY: 'http://127.0.0.1:8868', HTTPS_PROXY: 'http://127.0.0.1:8868', NO_PROXY: '127.0.0.1,localhost,::1' }
let buf = ''
let errBuf = ''
const child = spawn(bin, ['models'], { env, windowsHide: true })
child.stdout?.on('data', (d) => { buf += d })
child.stderr?.on('data', (d) => { errBuf += d })
child.on('error', (e) => { console.log('SPAWN ERROR:', e.code, e.message) })
child.on('close', (code, sig) => {
  console.log('close code=', code, 'sig=', sig)
  console.log('stdout bytes=', buf.length, 'stderr bytes=', errBuf.length)
  const rows = []
  for (const line of buf.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z0-9._-]+)\s*\t\s*(\S.*)$/)
    if (m) rows.push(m[1])
  }
  console.log('parsed rows=', rows.length, rows.slice(0, 2))
})
