"""Bounded HTTPS transport; credentials stay in the child environment."""
import json
import os
import socket
import sys
import urllib.error
import urllib.parse
import urllib.request


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def send():
    target = os.environ.get('TOKENHUB_ENDPOINT', '')
    parsed = urllib.parse.urlsplit(target)
    if parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
        return {'error': 'network'}
    body = sys.stdin.buffer.read(24 * 1024 + 1)
    if len(body) > 24 * 1024:
        return {'error': 'response_format'}
    key = os.environ.get('TOKENHUB_API_KEY', '')
    if not key:
        return {'error': 'authentication'}
    request = urllib.request.Request(target, data=body, method='POST', headers={
        'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key,
    })
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    try:
        with opener.open(request, timeout=40) as response:
            raw = response.read(128 * 1024 + 1)
            if len(raw) > 128 * 1024:
                return {'error': 'payload_too_large'}
            return {'status': response.status, 'body': raw.decode('utf-8')}
    except urllib.error.HTTPError as error:
        error.close()
        return {'error': 'authentication' if error.code in (401, 403) else 'rate_limit' if error.code == 429 else 'upstream_http'}
    except (TimeoutError, socket.timeout):
        return {'error': 'timeout'}
    except Exception:
        return {'error': 'network'}


if __name__ == '__main__':
    try:
        result = send()
    except Exception:
        result = {'error': 'network'}
    sys.stdout.buffer.write(json.dumps(result, ensure_ascii=False).encode('utf-8'))
