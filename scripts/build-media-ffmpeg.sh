#!/usr/bin/env bash
# Build the standalone media decoder from the exact upstream FFmpeg source.
# The resulting CLI programs run as separate processes; no FFmpeg library is
# linked into the plugin or the Rust sidecar.
set -euo pipefail

version=9.0.2
source_sha256=8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e
source_name="ffmpeg-${version}.tar.xz"
source_url="https://ffmpeg.org/releases/${source_name}"
output_dir="${1:-dist/media-ffmpeg}"
# RUNNER_TEMP is a Windows drive path under MSYS2, which GNU tar interprets as
# a remote archive. Use the shell's POSIX temporary directory on every host.
case "$(uname -s)" in
  MINGW*|MSYS*) executable_suffix=.exe; temporary_root=/tmp ;;
  Darwin*)
    executable_suffix=
    temporary_root="${TMPDIR:-/tmp}"
    # Match Speech Kit's published macOS minimum instead of inheriting the
    # GitHub runner's newer deployment target.
    export MACOSX_DEPLOYMENT_TARGET=14.2
    ;;
  *) executable_suffix=; temporary_root="${TMPDIR:-/tmp}" ;;
esac
build_dir="$temporary_root/speech-kit-ffmpeg-${version}-$$"

mkdir -p "$build_dir" "$output_dir"
trap 'rm -rf "$build_dir"' EXIT
curl --fail --location --silent --show-error "$source_url" -o "$build_dir/$source_name"
printf '%s  %s\n' "$source_sha256" "$build_dir/$source_name" | shasum -a 256 -c -
tar -xJf "$build_dir/$source_name" -C "$build_dir"

source_dir="$build_dir/ffmpeg-$version"
install_prefix="/speech-kit-media-ffmpeg-$version"
stage_dir="$build_dir/stage"
prefix="$stage_dir$install_prefix"
configure_flags=(
  "--prefix=$install_prefix"
  --disable-gpl
  --disable-nonfree
  --disable-network
  --disable-doc
  --disable-debug
  --disable-ffplay
  --disable-autodetect
  --enable-ffmpeg
  --enable-ffprobe
)
if [[ "$executable_suffix" == .exe ]]; then
  # MinGW defaults to a dynamically linked winpthread runtime. Keep the two
  # executables self-contained so a clean Windows install can actually run them.
  configure_flags+=(--extra-ldflags=-static)
fi

(
  cd "$source_dir"
  ./configure "${configure_flags[@]}"
  make -j "$(getconf _NPROCESSORS_ONLN 2>/dev/null || sysctl -n hw.ncpu)"
  make install "DESTDIR=$stage_dir"
)

cp "$prefix/bin/ffmpeg${executable_suffix}" "$prefix/bin/ffprobe${executable_suffix}" "$output_dir/"
if [[ "$(uname -s)" == Darwin ]]; then
  for executable in ffmpeg ffprobe; do
    if ! xcrun vtool -show-build "$output_dir/$executable" | grep -Eq 'minos 14\.2([[:space:]]|$)'; then
      echo "$executable does not target macOS 14.2." >&2
      exit 1
    fi
  done
fi
if [[ "$executable_suffix" == .exe ]]; then
  for executable in ffmpeg.exe ffprobe.exe; do
    if objdump -p "$output_dir/$executable" | grep -Eiq 'DLL Name: (libwinpthread|libgcc|libstdc\+\+)'; then
      echo "$executable requires an unbundled MinGW runtime DLL." >&2
      exit 1
    fi
  done
fi
cp "$source_dir/COPYING.LGPLv2.1" "$source_dir/COPYING.LGPLv3" "$output_dir/"
cp "$build_dir/$source_name" "$output_dir/"
"$output_dir/ffmpeg${executable_suffix}" -buildconf > "$output_dir/BUILD_CONFIGURATION.txt"
"$output_dir/ffmpeg${executable_suffix}" -L > "$output_dir/LICENSE_INFORMATION.txt"
if grep -E -- '--enable-(gpl|nonfree)' "$output_dir/BUILD_CONFIGURATION.txt"; then
  echo 'FFmpeg build unexpectedly enabled GPL or nonfree components.' >&2
  exit 1
fi
"$output_dir/ffmpeg${executable_suffix}" -nostdin -hide_banner -loglevel error \
  -f lavfi -i sine=frequency=440:duration=1 \
  -f lavfi -i color=c=black:s=32x32:r=1:d=1 \
  -c:v mpeg4 -c:a aac -y "$build_dir/smoke.mp4"
"$output_dir/ffprobe${executable_suffix}" -v error -select_streams a:0 \
  -show_entries stream=codec_name -of default=noprint_wrappers=1 \
  "$build_dir/smoke.mp4" | grep -qx codec_name=aac
"$output_dir/ffmpeg${executable_suffix}" -nostdin -hide_banner -loglevel error \
  -i "$build_dir/smoke.mp4" -map 0:a:0 -ac 1 -ar 16000 -c:a pcm_s16le \
  -f s16le -y "$build_dir/smoke.pcm"
test "$(wc -c < "$build_dir/smoke.pcm")" -ge 30000
(
  cd "$output_dir"
  shasum -a 256 "ffmpeg${executable_suffix}" "ffprobe${executable_suffix}" "$source_name" COPYING.LGPLv2.1 COPYING.LGPLv3 \
    BUILD_CONFIGURATION.txt LICENSE_INFORMATION.txt > SHA256SUMS.txt
)
printf 'Built FFmpeg %s helper at %s\n' "$version" "$output_dir"
