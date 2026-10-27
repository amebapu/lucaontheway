"""Native caption retrieval; only a constructed public video URL is sent."""
import json
import os
import re
import socket
import sys
import urllib.error
import urllib.parse
import urllib.request


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def send():
    raw = sys.stdin.buffer.read(1025)
    if len(raw) > 1024:
        return {'error': 'input_limit'}
    try:
        video_id = json.loads(raw).get('video_id')
    except Exception:
        return {'error': 'input_limit'}
    if not isinstance(video_id, str) or not re.fullmatch(r'[A-Za-z0-9_-]{11}', video_id):
        return {'error': 'input_limit'}
    key = os.environ.get('SUPADATA_API_KEY', '')
    if not key:
        return {'error': 'authentication'}
    query = urllib.parse.urlencode({
        'url': 'https://www.youtube.com/watch?v=' + video_id,
        'text': 'false', 'lang': 'en', 'chunkSize': '500', 'mode': 'native',
    })
    request = urllib.request.Request('https://api.supadata.ai/v1/transcript?' + query, headers={
        'Accept': 'application/json', 'x-api-key': key,
    })
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    try:
        with opener.open(request, timeout=20) as response:
            if response.status == 202:
                return {'error': 'pending'}
            if response.status == 206:
                return {'error': 'unavailable'}
            if response.status != 200:
                return {'error': 'upstream_http'}
            body = response.read(512 * 1024 + 1)
            if len(body) > 512 * 1024:
                return {'error': 'payload_too_large'}
            try:
                value = json.loads(body)
            except Exception:
                return {'error': 'response_format'}
            if not isinstance(value, dict):
                return {'error': 'response_format'}
            if value.get('jobId'):
                return {'error': 'pending'}
            if value.get('error'):
                return {'error': 'upstream_http'}
            return {'data': {'content': value.get('content'), 'lang': value.get('lang')}}
    except urllib.error.HTTPError as error:
        code = error.code
        error.close()
        return {'error': 'authentication' if code in (401, 403) else 'rate_limit' if code in (402, 429) else 'unavailable' if code == 404 else 'upstream_http'}
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
