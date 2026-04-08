"""
Kernel tracker: fetch mailing-list summaries from the published GitHub Pages site.

Usage::

    from kernel_tracker_fetch import fetch_latest_mailing_list_summary

    text = fetch_latest_mailing_list_summary()

CLI::

    python -m kernel_tracker_fetch
    # or: python tools/fetch_mailing_list_summary.py
"""

from kernel_tracker_fetch.mailing_list import fetch_latest_mailing_list_summary, main

__all__ = ["fetch_latest_mailing_list_summary", "main"]
