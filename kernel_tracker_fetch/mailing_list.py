"""Fetch latest mailing-list daily summary (今日社区动态) from GitHub Pages JSON."""

from __future__ import annotations

import json
import socket
import ssl
import sys
import time
from typing import Any, Dict
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

BASE_SITE = "https://zouyipeng.github.io"
BASE_PATH = "/kernel-tracker.github.io"

_TLS_CONTEXT = ssl.create_default_context()
if hasattr(ssl, "TLSVersion"):
    _TLS_CONTEXT.minimum_version = ssl.TLSVersion.TLSv1_2
# 禁用SSL验证，解决部分环境下的访问错误
_TLS_CONTEXT.check_hostname = False
_TLS_CONTEXT.verify_mode = ssl.CERT_NONE

_DEFAULT_TIMEOUT_S = 60
_MAX_RETRIES = 8


def _is_read_or_connect_timeout(exc: BaseException) -> bool:
    """Detect timeout errors from urllib/ssl (incl. 'The read operation timed out')."""
    if isinstance(exc, (TimeoutError, socket.timeout)):
        return True
    if isinstance(exc, OSError):
        errno = getattr(exc, "errno", None)
        if errno in (socket.ETIMEDOUT, 110, 10060):
            return True
    if isinstance(exc, URLError) and exc.reason is not None:
        return _is_read_or_connect_timeout(exc.reason)
    if isinstance(exc, ssl.SSLError):
        msg = str(exc).lower()
        if "timed out" in msg or "read operation timed out" in msg:
            return True
    msg = str(exc).lower()
    if "timed out" in msg or "read operation timed out" in msg:
        return True
    return False


def _http_get_json(url: str, timeout_s: int = _DEFAULT_TIMEOUT_S, retries: int = _MAX_RETRIES) -> Any:
    last_err: Exception | None = None
    for attempt in range(1, retries + 1):
        try:
            req = Request(
                url,
                headers={
                    "User-Agent": "kernel-tracker-summary-fetcher/1.2",
                    "Accept": "application/json,text/plain,*/*",
                    "Cache-Control": "no-cache",
                    "Pragma": "no-cache",
                },
                method="GET",
            )
            with urlopen(req, timeout=timeout_s, context=_TLS_CONTEXT) as resp:
                raw = resp.read().decode("utf-8")
            return json.loads(raw)
        except HTTPError as e:
            if attempt < retries and e.code in (500, 502, 503, 504):
                time.sleep(0.6 * (2 ** (attempt - 1)))
                last_err = e
                continue
            raise
        except (URLError, ssl.SSLError, TimeoutError, OSError) as e:
            if attempt < retries and (
                _is_read_or_connect_timeout(e)
                or isinstance(e, (URLError, ssl.SSLError))
            ):
                time.sleep(0.6 * (2 ** (attempt - 1)))
                last_err = e
                continue
            raise
        except json.JSONDecodeError as e:
            if attempt < retries:
                time.sleep(0.6 * (2 ** (attempt - 1)))
                last_err = e
                continue
            raise
    if last_err:
        raise last_err
    raise RuntimeError("Unexpected retry loop exit")


def _join_url(path: str) -> str:
    if not path.startswith("/"):
        path = "/" + path
    return f"{BASE_SITE}{BASE_PATH}{path}"


def fetch_latest_mailing_list_summary() -> str:
    """
    Download the latest mailing-list day from source-dates.json, trim to 今日社区动态
    (drop per-subsystem "## ..." sections), return text with detail URL at the end.
    """
    index_url = _join_url("/source-dates.json")
    index: Dict[str, Any] = _http_get_json(index_url)

    ml = index.get("mailing-list") or {}
    dates = ml.get("dates") or []
    if not isinstance(dates, list) or not dates:
        raise RuntimeError(f'No available dates for "mailing-list" in {index_url}')

    date_str = str(dates[0])
    if not date_str or len(date_str) != 10:
        raise RuntimeError(f'Invalid latest date "{date_str}" from {index_url}')
    data_url = _join_url(f"/mailing-list-{date_str}.json")
    data: Dict[str, Any] = _http_get_json(data_url)

    summary = (data.get("summary") or "").strip()
    if not summary:
        raise RuntimeError(f'Empty "summary" in {data_url}')

    cut = summary.find("\n\n## ")
    if cut != -1:
        summary = summary[:cut].rstrip()

    # 只移除括号内包含 #subsystem- 的锚点部分，保留行的其余内容
    import re
    # 匹配 [text](#subsystem-text) 格式的锚点，替换为 text
    summary = re.sub(r'\[(.*?)\]\(#subsystem-[^)]*\)', r'\1', summary)

    detail_url = _join_url(f"/{date_str}/mailing-list")
    return f"{summary}\n详情请查看：{detail_url}"


def main() -> int:
    try:
        out = fetch_latest_mailing_list_summary()
        print(out)
        return 0
    except HTTPError as e:
        print(f"[HTTPError] {e.code} {e.reason}: {e.url}", file=sys.stderr)
        return 2
    except ssl.SSLError as e:
        print(f"[SSLError] {e}", file=sys.stderr)
        return 5
    except URLError as e:
        print(f"[URLError] {e.reason}", file=sys.stderr)
        return 3
    except json.JSONDecodeError as e:
        print(f"[JSONDecodeError] {e}", file=sys.stderr)
        return 4
    except Exception as e:
        print(f"[Error] {e}", file=sys.stderr)
        return 1
