"""
CLI wrapper: ensures repo root is on sys.path so `kernel_tracker_fetch` imports work
when invoked as ``python tools/fetch_mailing_list_summary.py``.
"""

from __future__ import annotations

import sys
from pathlib import Path

_repo_root = Path(__file__).resolve().parent.parent
if str(_repo_root) not in sys.path:
    sys.path.insert(0, str(_repo_root))

from kernel_tracker_fetch.mailing_list import main

if __name__ == "__main__":
    raise SystemExit(main())
