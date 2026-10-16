#!/usr/bin/env python3
"""Local dev server for the WrapSynth frontend.

Serves the frontend directory like `python3 -m http.server`, plus maps
extensionless clean URLs to their .html files (mirrors the .htaccess
rewrites on production):
  /account   -> account.html
  /app       -> app.html
  /lp-vault  -> lp-vault.html
"""
import http.server
import os

PORT = int(os.environ.get('PORT', '8000'))
DIRECTORY = os.path.dirname(os.path.abspath(__file__))

CLEAN_URLS = {
    '/account': '/account.html',
    '/app': '/app.html',
    '/lp-vault': '/lp-vault.html',
}


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIRECTORY, **kwargs)

    def translate_path(self, path):
        # Map clean URLs -> .html files (Apache MultiViews/rewrite equivalent)
        path = CLEAN_URLS.get(path, path)
        return super().translate_path(path)

    def end_headers(self):
        # Match the deployed host: revalidate so edits show up immediately
        if self.path.endswith(('.js', '.mjs', '.json', '.css', '.html')):
            self.send_header('Cache-Control', 'no-cache, must-revalidate')
        super().end_headers()


if __name__ == '__main__':
    http.server.ThreadingHTTPServer(('0.0.0.0', PORT), Handler).serve_forever()
