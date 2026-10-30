#!/usr/bin/env python3
"""Scale source media for the web page and create an upload ZIP."""

import argparse
import hashlib
from pathlib import Path
import re
import shutil
import struct
import subprocess
import tempfile
from zipfile import ZIP_DEFLATED, ZipFile


ROOT = Path(__file__).resolve().parent
FILES = (
    "index.html", "styles.css", "config.js", "app.js",
    "scaled_jumpscare_static.png", "scaled_jumpscare.mp4", "README.md", "prepare-media.py",
    "docs/jumpscare-preview.gif",
)


def version(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()[:16]


def video_dimension(value):
    try:
        number = int(value)
    except ValueError:
        raise argparse.ArgumentTypeError("must be a positive even integer") from None
    if number <= 0 or number % 2:
        raise argparse.ArgumentTypeError("must be a positive even integer for H.264/yuv420p")
    return number


def main():
    parser = argparse.ArgumentParser(
        description="Scale the source video and image, then create jumpscare-web.zip."
    )
    parser.add_argument(
        "--input", type=Path, default=ROOT / "source_jumpscare.mov", metavar="VIDEO",
        help="source video (default: source_jumpscare.mov beside this script)",
    )
    parser.add_argument(
        "--image", type=Path, default=ROOT / "source_jumpscare_static.png", metavar="IMAGE",
        help="source image (default: source_jumpscare_static.png beside this script)",
    )
    parser.add_argument(
        "--width", type=video_dimension,
        help="output width in pixels; supply with --height to resize (default: keep input resolution)",
    )
    parser.add_argument(
        "--height", type=video_dimension,
        help="output height in pixels; supply with --width to resize (default: keep input resolution)",
    )
    args = parser.parse_args()
    if (args.width is None) != (args.height is None):
        parser.error("supply both --width and --height to resize, or omit both to keep the input resolution")
    source = args.input.expanduser().resolve()
    source_image = args.image.expanduser().resolve()
    if not source.is_file():
        parser.error(f"input video does not exist: {source}")
    if not source_image.is_file():
        parser.error(f"input image does not exist: {source_image}")
    if shutil.which("ffmpeg") is None:
        raise SystemExit("ffmpeg is required. Install FFmpeg, then run this command again.")

    with tempfile.TemporaryDirectory(prefix="jumpscare-media-") as temporary:
        converted = Path(temporary) / "scaled_jumpscare.mp4"
        scaled_image = Path(temporary) / "scaled_jumpscare_static.png"
        subprocess.run([
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
            "-i", str(source),
            "-map", "0:v:0", "-map", "0:a:0",
            "-vf", (
                f"scale={args.width}:{args.height}:flags=lanczos,setsar=1"
                if args.width is not None else "setsar=1"
            ),
            "-c:v", "libx264", "-preset", "medium", "-crf", "18",
            "-profile:v", "main", "-level:v", "5.0", "-pix_fmt", "yuv420p",
            "-bf", "0", "-g", "24", "-keyint_min", "24", "-sc_threshold", "0",
            "-c:a", "aac", "-b:a", "192k",
            "-movflags", "+faststart", "-map_metadata", "-1", str(converted),
        ], check=True)

        subprocess.run([
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
            "-i", str(source_image), "-i", str(converted),
            "-filter_complex", (
                "[0:v][1:v]scale2ref=w=iw:h=ih:flags=lanczos[scaled][reference];"
                "[scaled]setsar=1[image];[reference]nullsink"
            ),
            "-map", "[image]",
            "-frames:v", "1", "-update", "1", str(scaled_image),
        ], check=True)
        # PNG stores width and height in its IHDR header, starting at byte 16.
        with scaled_image.open("rb") as image:
            image.seek(16)
            width, height = struct.unpack(">II", image.read(8))

        config_path = ROOT / "config.js"
        config, replacements = re.subn(
            r'videoSrc:\s*"[^"]*"',
            f'videoSrc: "scaled_jumpscare.mp4?v={version(converted)}"',
            config_path.read_text(),
        )
        if replacements != 1:
            raise SystemExit("Expected one videoSrc setting in config.js; no files were replaced.")
        index_path = ROOT / "index.html"
        index = index_path.read_text()
        index, dimensions = re.subn(
            r'(<(?:img|canvas|video)\b[^>]*\bid="(?:sign-image|signature|scare)"[^>]*\bwidth=")\d+("\s+height=")\d+("[ >])',
            lambda match: f'{match[1]}{width}{match[2]}{height}{match[3]}',
            index,
        )
        index, layout = re.subn(
            r'(<div id="form" class="form" style=")[^"]*(")',
            lambda match: f'{match[1]}--media-width: {width}; --media-height: {height}{match[2]}',
            index,
        )
        if dimensions != 3 or layout != 1:
            raise SystemExit("Expected media dimensions and form layout in index.html; no files were replaced.")

        shutil.copyfile(converted, ROOT / converted.name)
        shutil.copyfile(scaled_image, ROOT / scaled_image.name)
        config_path.write_text(config)

        for name in ("styles.css", "config.js", "app.js", "scaled_jumpscare_static.png"):
            index = re.sub(
                rf'((?:src|href)="){re.escape(name)}(?:\?[^"]*)?"',
                lambda match: f'{match[1]}{name}?v={version(ROOT / name)}"',
                index,
            )
        build = hashlib.sha256("".join(
            version(ROOT / name) for name in FILES if name != "index.html"
        ).encode()).hexdigest()[:8]
        index = re.sub(
            r'(<small id="build-version"[^>]*>)[^<]*(</small>)',
            lambda match: f'{match[1]}Build {build}{match[2]}',
            index,
        )
        index_path.write_text(index)

        package = Path(temporary) / "jumpscare-web.zip"
        with ZipFile(package, "w", compression=ZIP_DEFLATED) as archive:
            for name in FILES:
                archive.write(ROOT / name, name)
        with ZipFile(package) as archive:
            if archive.testzip() is not None:
                raise SystemExit("Package verification failed.")
        shutil.copyfile(package, ROOT / "jumpscare-web.zip")

    print(f"Created scaled video and image at {width} × {height}; packaged jumpscare-web.zip.")
    print("Upload the ZIP contents together, then reload the page on the iPad.")


if __name__ == "__main__":
    main()
