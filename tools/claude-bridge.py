#!/usr/bin/env python3
"""Hand one paragraph to `claude -p`, and hand the answer back.

The Lint bar builds a rewrite prompt for the five checks that ask for the
sentence again. Without this it goes on the clipboard and you carry it to a
model yourself. With this running, the box that takes the answer can ask for
it instead.

    python3 tools/claude-bridge.py

It prints one line: the address to paste into the box, with a key in it. Leave
it running while you edit, stop it with ctrl-C.

What it is, exactly: a loopback HTTP server with one route that runs the
`claude` CLI you already have logged in, with the prompt on its standard
input. No API key, nothing stored, nothing logged.

Why it is as small as it is
---------------------------

It is a thing that runs a program on your machine when something on the
network asks it to, so the interesting part is who may ask.

  * It binds 127.0.0.1 and nothing else. There is no address on your network
    it can be reached at.
  * Every request must carry the key printed at startup, which is 32 random
    characters made fresh on each run. Without it the answer is 403 and
    nothing is run.
  * No CORS headers are sent, ever. A page in your browser cannot read a
    reply from here, so a page cannot use it even if it guesses the key. The
    userscript reaches it through `GM_xmlhttpRequest`, which is the
    extension's own request and not the page's.
  * The prompt goes to `claude` on STDIN and the argument list is fixed. No
    shell, no interpolation: there is nothing in the text that can become a
    command.
  * One request at a time, a size cap on the prompt, and a timeout.

What it does NOT do is check what the answer says. That is the Lint bar's job
and it does it on your screen: the markers are counted, the comparison is
drawn, and nothing reaches the article until you press the button.
"""

import argparse
import json
import os
import secrets
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOST = '127.0.0.1'
PORT = 8765
MAX_PROMPT = 64 * 1024      # a paragraph and its instructions; nothing is near this
TIMEOUT = 180               # a rewrite, not a research task

KEY = secrets.token_urlsafe(24)
ONE_AT_A_TIME = threading.Lock()


def ask_claude(prompt, command):
    """Run the CLI with the prompt on stdin. Returns (text, error)."""
    try:
        done = subprocess.run(
            command,
            input=prompt,
            capture_output=True,
            text=True,
            timeout=TIMEOUT,
            shell=False,
        )
    except FileNotFoundError:
        return None, f'{command[0]} is not on the PATH of the shell this was started from'
    except subprocess.TimeoutExpired:
        return None, f'{command[0]} did not answer within {TIMEOUT} seconds'
    except Exception as e:                                  # noqa: BLE001
        return None, f'{command[0]} could not be run: {e}'

    if done.returncode != 0:
        said = (done.stderr or done.stdout or '').strip().splitlines()
        return None, said[-1] if said else f'{command[0]} exited {done.returncode}'

    text = (done.stdout or '').strip()
    return (text, None) if text else (None, f'{command[0]} answered with nothing')


class Bridge(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    command_line = ['claude', '-p']

    def answer(self, code, payload):
        body = json.dumps(payload).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        # Deliberately no Access-Control-Allow-Origin: a page must not be able
        # to read what comes back from here.
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):                                      # noqa: N802
        if self.path.split('?')[0] != '/rewrite':
            return self.answer(404, {'error': 'no such route'})
        if self.headers.get('X-Bridge-Key') != KEY:
            return self.answer(403, {'error': 'wrong key — restart the bridge and paste the new address'})

        try:
            length = int(self.headers.get('Content-Length') or 0)
        except ValueError:
            return self.answer(400, {'error': 'no length'})
        if length <= 0 or length > MAX_PROMPT:
            return self.answer(413, {'error': 'the prompt is not a sensible size'})

        try:
            sent = json.loads(self.rfile.read(length).decode('utf-8'))
            prompt = sent['prompt']
        except Exception:                                   # noqa: BLE001
            return self.answer(400, {'error': 'that is not a prompt'})
        if not isinstance(prompt, str) or not prompt.strip():
            return self.answer(400, {'error': 'that is not a prompt'})

        if not ONE_AT_A_TIME.acquire(blocking=False):
            return self.answer(429, {'error': 'still working on the last one'})
        try:
            print(f'  asking {self.command_line[0]} … ', end='', flush=True)
            text, trouble = ask_claude(prompt, self.command_line)
        finally:
            ONE_AT_A_TIME.release()

        print('nothing: ' + trouble if trouble else f'{len(text)} characters', flush=True)
        if trouble:
            return self.answer(502, {'error': trouble})
        return self.answer(200, {'text': text})

    def log_message(self, *args):
        """Quiet. The prompt is somebody's article and does not belong in a log."""


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument('--port', type=int, default=PORT)
    ap.add_argument('--command', default='claude -p',
                    help='the CLI to run, prompt on stdin (default: "claude -p")')
    args = ap.parse_args()

    Bridge.command_line = args.command.split()
    if not Bridge.command_line:
        sys.exit('--command needs a command')

    server = ThreadingHTTPServer((HOST, args.port), Bridge)
    say = lambda line='': print(line, flush=True)
    say('Paste this into the "ask" box on the Lint bar, once:\n')
    say(f'    http://{HOST}:{args.port}/rewrite#{KEY}\n')
    say(f'Running {" ".join(Bridge.command_line)} on {HOST}:{args.port}. ctrl-C to stop.')
    say('The key is new every time this starts, so a restart needs a fresh paste.')
    say()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\nstopped.')
    finally:
        server.server_close()


if __name__ == '__main__':
    os.environ.setdefault('CLAUDE_CODE_NONINTERACTIVE', '1')
    main()
