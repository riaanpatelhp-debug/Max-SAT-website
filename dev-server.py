#!/usr/bin/env python3
"""Local dev server that sends no-cache headers so edited assets always reload.
Production caching is handled by _headers / .htaccess — NOT this file."""
import http.server
import socketserver

PORT = 8780


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()


if __name__ == "__main__":
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(("", PORT), NoCacheHandler) as httpd:
        print(f"Dev server (no-cache) on http://localhost:{PORT}")
        httpd.serve_forever()
