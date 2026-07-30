// RESTORE MODE: mini server HTTP che tiene attivo il deployment (Railway healthcheck OK)
// senza aprire il database, così `railway volume files` puo' sostituire data.db in sicurezza.
const p = process.env.PORT || 8080;
require('http').createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end('{"status":"ok","mode":"restore"}');
}).listen(p, () => console.log('[RESTORE] http server on ' + p));
