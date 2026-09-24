#!/bin/sh
set -eu

gui="$(cd "$(dirname "$0")/.." && pwd)"
repo="$(dirname "$gui")"
version="$(sed -n 's/^	"version": "\(.*\)",$/\1/p' "$repo/package.json")"
app="$gui/target/tokenmaxx.app"
work="$gui/target/bundle"

(cd "$repo" && bun run build:bin)
cargo build --release --manifest-path "$gui/Cargo.toml"

rm -rf "$app" "$work"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources/bin" "$work/tokenmaxx.iconset"

cp "$gui/target/release/tokenmaxx-gui" "$app/Contents/MacOS/tokenmaxx-gui"
cp "$gui/target/bin/tokenmaxx" "$app/Contents/Resources/bin/tokenmaxx"
sed "s/__VERSION__/$version/g" "$gui/Info.plist" > "$app/Contents/Info.plist"

qlmanage -t -s 1024 -o "$work" "$gui/assets/icon.svg" > /dev/null
for size in 16 32 128 256 512; do
	sips -z "$size" "$size" "$work/icon.svg.png" --out "$work/tokenmaxx.iconset/icon_${size}x${size}.png" > /dev/null
	double=$((size * 2))
	sips -z "$double" "$double" "$work/icon.svg.png" --out "$work/tokenmaxx.iconset/icon_${size}x${size}@2x.png" > /dev/null
done
iconutil -c icns "$work/tokenmaxx.iconset" -o "$app/Contents/Resources/tokenmaxx.icns"

codesign --force --sign - "$app/Contents/Resources/bin/tokenmaxx"
codesign --force --sign - "$app"

echo "$app"
