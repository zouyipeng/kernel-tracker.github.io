import json
import sys
import time
from typing import Any, Dict
import ssl
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


BASE_SITE = "https://zouyipeng.github.io"
BASE_PATH = "/kernel-tracker.github.io"

_TLS_CONTEXT = ssl.create_default_context()
if hasattr(ssl, "TLSVersion"):
    # Be explicit to avoid old TLS negotiation edge cases.
    _TLS_CONTEXT.minimum_version = ssl.TLSVersion.TLSv1_2


def _http_get_json(url: str, timeout_s: int = 10, retries: int = 5) -> Any:
    last_err: Exception | None = None
    for attempt in range(1, retries + 1):
        try:
            req = Request(
                url,
                headers={
                    "User-Agent": "kernel-tracker-summary-fetcher/1.1",
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
            # GitHub Pages/CDN can occasionally throw transient 5xx.
            if attempt < retries and e.code in (500, 502, 503, 504):
                time.sleep(0.6 * (2 ** (attempt - 1)))
                last_err = e
                continue
            raise
        except (URLError, ssl.SSLError) as e:
            # Network/TLS flakiness: retry with exponential backoff.
            if attempt < retries:
                time.sleep(0.6 * (2 ** (attempt - 1)))
                last_err = e
                continue
            raise
        except json.JSONDecodeError as e:
            # If we got HTML/error page masquerading as JSON, a short retry helps.
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

    # Keep only the top "今日社区动态" section; drop subsystem breakdowns starting at "## <Subsystem>"
    cut = summary.find("\n\n## ")
    if cut != -1:
        summary = summary[:cut].rstrip()

    detail_url = _join_url(f"/{date_str}/mailing-list")
    return f"社区动态（{date_str}）\n\n{summary}\n\n详情请查看：{detail_url}"


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


if __name__ == "__main__":
    raise SystemExit(main())
