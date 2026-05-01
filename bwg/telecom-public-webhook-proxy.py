#!/usr/bin/env python3
import http.client
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

LISTEN_HOST = os.environ.get('TELECOM_PUBLIC_WEBHOOK_HOST', '0.0.0.0')
LISTEN_PORT = int(os.environ.get('TELECOM_PUBLIC_WEBHOOK_PORT', '18789'))
UPSTREAM_HOST = os.environ.get('TELECOM_UPSTREAM_HOST', '127.0.0.1')
UPSTREAM_PORT = int(os.environ.get('TELECOM_UPSTREAM_PORT', '18787'))
MAX_BODY = int(os.environ.get('TELECOM_PUBLIC_WEBHOOK_MAX_BODY', '1048576'))

ROUTES = {
    '/telecom-sms': '/cgi-bin/telecom-sms',
    '/telecom-messages': '/cgi-bin/telecom-messages',
    '/telecom-sms-health': '/cgi-bin/telecom-sms-health',
}

class Handler(BaseHTTPRequestHandler):
    server_version = 'TelecomWebhookProxy/1.0'

    def log_message(self, fmt, *args):
        # Avoid logging query strings because they may contain token.
        safe_path = urlsplit(self.path).path
        print('%s - - [%s] %s' % (self.client_address[0], self.log_date_time_string(), fmt % args), flush=True)
        if safe_path != self.path:
            print('%s - - [%s] path=%s' % (self.client_address[0], self.log_date_time_string(), safe_path), flush=True)

    def do_GET(self):
        self._proxy()

    def do_POST(self):
        self._proxy()

    def _proxy(self):
        parsed = urlsplit(self.path)
        upstream_path = ROUTES.get(parsed.path)
        if not upstream_path:
            self.send_response(404)
            self.send_header('content-type', 'application/json; charset=utf-8')
            self.end_headers()
            self.wfile.write(b'{"ok":false,"error":"not found"}\n')
            return

        length = int(self.headers.get('content-length') or 0)
        if length > MAX_BODY:
            self.send_response(413)
            self.send_header('content-type', 'application/json; charset=utf-8')
            self.end_headers()
            self.wfile.write(b'{"ok":false,"error":"payload too large"}\n')
            return

        body = self.rfile.read(length) if length else None
        target = upstream_path + (('?' + parsed.query) if parsed.query else '')
        headers = {
            'content-type': self.headers.get('content-type', 'application/octet-stream'),
            'x-forwarded-for': self.client_address[0],
            'x-forwarded-proto': 'http',
        }
        if self.headers.get('authorization'):
            headers['authorization'] = self.headers['authorization']

        conn = http.client.HTTPConnection(UPSTREAM_HOST, UPSTREAM_PORT, timeout=20)
        try:
            conn.request(self.command, target, body=body, headers=headers)
            resp = conn.getresponse()
            data = resp.read()
            self.send_response(resp.status)
            self.send_header('content-type', resp.getheader('content-type') or 'application/json; charset=utf-8')
            self.send_header('cache-control', 'no-store')
            self.end_headers()
            self.wfile.write(data)
        except Exception as exc:
            self.send_response(502)
            self.send_header('content-type', 'application/json; charset=utf-8')
            self.end_headers()
            msg = str(exc).replace('"', '\\"')
            self.wfile.write((f'{{"ok":false,"error":"upstream failed: {msg}"}}\n').encode())
        finally:
            conn.close()

if __name__ == '__main__':
    httpd = ThreadingHTTPServer((LISTEN_HOST, LISTEN_PORT), Handler)
    print(f'listening on {LISTEN_HOST}:{LISTEN_PORT}, upstream={UPSTREAM_HOST}:{UPSTREAM_PORT}', flush=True)
    httpd.serve_forever()
