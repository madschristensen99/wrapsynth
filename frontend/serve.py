#!/usr/bin/env python3
"""Local dev server for the WrapSynth frontend.

Serves the frontend directory like `python3 -m http.server`, plus maps
extensionless `/app` to `app.html` (mirrors Apache MultiViews on production).
"""
import http.server
import os

PORT = int(os.environ.get('PORT', '8000'))
DIRECTORY = os.path.dirname(os.path.abspath(__file__))


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIRECTORY, **kwargs)

    def translate_path(self, path):
        # Map /app -> /app.html (Apache MultiViews equivalent)
        if path == '/app':
            path = '/app.html'
        return super().translate_path(path)


if __name__ == '__main__':
    http.server.ThreadingHTTPServer(('0.0.0.0', PORT), Handler).serve_forever()
