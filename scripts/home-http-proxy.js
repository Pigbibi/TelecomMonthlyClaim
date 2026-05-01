#!/usr/bin/env node
const http = require('node:http');
const net = require('node:net');
const { URL } = require('node:url');

const HOST = process.env.HOME_PROXY_HOST || '127.0.0.1';
const PORT = Number(process.env.HOME_PROXY_PORT || 13128);
const TIMEOUT_MS = Number(process.env.HOME_PROXY_TIMEOUT_MS || 60000);

function pipeError(socket, status = 502, message = 'Bad Gateway') {
  if (!socket.destroyed) socket.end(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\n\r\n`);
}

const server = http.createServer((req, res) => {
  let target;
  try {
    target = new URL(req.url);
  } catch {
    res.writeHead(400); res.end('absolute-form URL required'); return;
  }
  const isHttps = target.protocol === 'https:';
  const mod = isHttps ? require('node:https') : require('node:http');
  const headers = { ...req.headers, host: target.host };
  delete headers['proxy-connection'];
  const upstream = mod.request({
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port || (isHttps ? 443 : 80),
    method: req.method,
    path: `${target.pathname}${target.search}`,
    headers,
    timeout: TIMEOUT_MS,
  }, upstreamRes => {
    res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
    upstreamRes.pipe(res);
  });
  upstream.on('error', err => { res.writeHead(502); res.end(err.message); });
  req.pipe(upstream);
});

server.on('connect', (req, clientSocket, head) => {
  const [host, portText] = String(req.url || '').split(':');
  const port = Number(portText || 443);
  if (!host || !Number.isFinite(port)) {
    pipeError(clientSocket, 400, 'Bad CONNECT target'); return;
  }
  const upstream = net.connect(port, host);
  upstream.setTimeout(TIMEOUT_MS);
  clientSocket.setTimeout(TIMEOUT_MS);
  upstream.on('connect', () => {
    clientSocket.write('HTTP/1.1 200 Connection Established\r\nProxy-Agent: telecom-home-proxy\r\n\r\n');
    if (head?.length) upstream.write(head);
    upstream.pipe(clientSocket);
    clientSocket.pipe(upstream);
  });
  upstream.on('timeout', () => upstream.destroy(new Error('upstream timeout')));
  clientSocket.on('timeout', () => clientSocket.destroy());
  upstream.on('error', () => pipeError(clientSocket));
  clientSocket.on('error', () => upstream.destroy());
});

server.listen(PORT, HOST, () => console.log(`home http proxy listening on ${HOST}:${PORT}`));
