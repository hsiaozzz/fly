from __future__ import annotations

import os
import tempfile
from typing import Any
from urllib.parse import urlparse

from flask import (Flask, after_this_request, flash, redirect, render_template,
                   request, send_file, url_for)
from yt_dlp import YoutubeDL

app = Flask(__name__)
app.secret_key = os.environ.get("FLASK_SECRET", "yt-dlp-secret")


class DownloadError(Exception):
    pass


def is_valid_url(url: str) -> bool:
    parsed = urlparse(url)
    return parsed.scheme in {"http", "https"} and bool(parsed.netloc)


def fetch_video_info(url: str) -> dict[str, Any]:
    if not is_valid_url(url):
        raise DownloadError("请输入有效的视频链接（http/https）。")

    options = {
        "quiet": True,
        "skip_download": True,
        "noplaylist": True,
    }
    with YoutubeDL(options) as ydl:
        return ydl.extract_info(url, download=False)


def build_format_options(info: dict[str, Any]) -> list[dict[str, str]]:
    formats = []
    for fmt in info.get("formats", []):
        if fmt.get("vcodec") == "none" and fmt.get("acodec") == "none":
            continue
        if fmt.get("protocol") == "m3u8_native":
            continue
        size = fmt.get("filesize") or fmt.get("filesize_approx")
        size_label = f"{size / 1024 / 1024:.1f} MB" if size else "未知"
        resolution = fmt.get("resolution") or fmt.get("height")
        resolution_label = resolution if isinstance(resolution, str) else (
            f"{resolution}p" if resolution else "自适应"
        )
        formats.append(
            {
                "id": fmt.get("format_id", ""),
                "label": f"{fmt.get('ext', '')} · {resolution_label} · {fmt.get('format_note', '')} · {size_label}",
            }
        )
    return formats


def download_video(url: str, format_id: str | None) -> tuple[str, str]:
    options = {
        "format": format_id or "best",
        "noplaylist": True,
        "outtmpl": os.path.join(tempfile.gettempdir(), "yt-dlp-%(id)s-%(title)s.%(ext)s"),
        "quiet": True,
    }
    with YoutubeDL(options) as ydl:
        info = ydl.extract_info(url, download=True)

    downloads = info.get("requested_downloads") or []
    if not downloads:
        raise DownloadError("没有找到可以下载的文件。")

    filepath = downloads[0].get("filepath")
    if not filepath or not os.path.exists(filepath):
        raise DownloadError("下载失败，请稍后再试。")

    filename = os.path.basename(filepath)
    return filepath, filename


@app.route("/", methods=["GET"])
def index() -> str:
    return render_template("index.html", info=None, formats=None, url="")


@app.route("/preview", methods=["POST"])
def preview() -> str:
    url = request.form.get("url", "").strip()
    try:
        info = fetch_video_info(url)
        formats = build_format_options(info)
        if not formats:
            flash("未找到可用的清晰度，请尝试其他链接。", "warning")
        return render_template("index.html", info=info, formats=formats, url=url)
    except DownloadError as exc:
        flash(str(exc), "danger")
    except Exception:
        flash("解析失败，请检查链接是否正确。", "danger")
    return render_template("index.html", info=None, formats=None, url=url)


@app.route("/download", methods=["POST"])
def download() -> Any:
    url = request.form.get("url", "").strip()
    format_id = request.form.get("format_id", "") or None
    try:
        filepath, filename = download_video(url, format_id)
    except DownloadError as exc:
        flash(str(exc), "danger")
        return redirect(url_for("index"))
    except Exception:
        flash("下载失败，请稍后再试。", "danger")
        return redirect(url_for("index"))

    @after_this_request
    def cleanup(response):
        try:
            os.remove(filepath)
        except OSError:
            pass
        return response

    return send_file(filepath, as_attachment=True, download_name=filename)


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8000, debug=True)
