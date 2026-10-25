#!/bin/zsh
# Final cut: speeds up the stretches where agents work, joins the scenes with short crossfades,
# lays the score under it. Usage: scripts/demo/edit.sh <clip-dir> <out.mp4>
set -e
D="$1"
OUT="$2"
T="$D/cut"
rm -rf "$T" && mkdir -p "$T"
enc=(-c:v libx264 -preset veryfast -crf 17 -pix_fmt yuv420p -r 30 -an)

# speed(in, out, from, to, factor): play [from, to] at `factor`, the rest at normal speed
speed() {
  local src=$1 dst=$2 a=$3 b=$4 k=$5
  ffmpeg -y -loglevel error -i "$src" -filter_complex \
    "[0:v]trim=0:$a,setpts=PTS-STARTPTS[p0];[0:v]trim=$a:$b,setpts=(PTS-STARTPTS)/$k[p1];[0:v]trim=$b,setpts=PTS-STARTPTS[p2];[p0][p1][p2]concat=n=3:v=1:a=0[v]" \
    -map "[v]" $enc "$dst"
}

for n in 01-open 02-city 03-search 04-heat 05-edit 08-traffic 09-close; do
  ffmpeg -y -loglevel error -i "$D/clip-$n.mp4" $enc "$T/$n.mp4"
done
dur() { ffprobe -v error -show_entries format=duration -of csv=p=0 "$1"; }
A=$(dur "$D/clip-06-agent.mp4")
speed "$D/clip-06-agent.mp4" "$T/06-agent.mp4" 13 $(awk "BEGIN{print $A-5}") 1.6
Z=$(dur "$D/clip-07-zones.mp4")
speed "$D/clip-07-zones.mp4" "$T/07-zones.mp4" 14 $(awk "BEGIN{print $Z-3}") 2

clips=(01-open 02-city 03-search 04-heat 05-edit 06-agent 07-zones 08-traffic 09-close)
inputs=() filter="" prev="[0:v]" offset=0 X=0.5
for i in {1..${#clips}}; do inputs+=(-i "$T/${clips[$i]}.mp4"); done
for i in {2..${#clips}}; do
  offset=$(awk "BEGIN{print $offset + $(dur "$T/${clips[$((i-1))]}.mp4") - $X}")
  lab=$([ $i -eq ${#clips} ] && echo "[v]" || echo "[x$i]")
  filter+="${prev}[$((i-1)):v]xfade=transition=fade:duration=$X:offset=$offset$lab;"
  prev=$lab
done
ffmpeg -y -loglevel error "${inputs[@]}" -filter_complex "${filter%;}" -map "[v]" -c:v libx264 -preset veryfast -crf 17 -pix_fmt yuv420p "$T/video.mp4"

TOTAL=$(dur "$T/video.mp4")
node "$(dirname $0)/score.mjs" "$TOTAL" "$T/score.m4a"
ffmpeg -y -loglevel error -i "$T/video.mp4" -i "$T/score.m4a" -map 0:v -map 1:a -c:v copy -c:a aac -b:a 192k -shortest -movflags +faststart "$OUT"
cp "$T/video.mp4" "${OUT%.mp4}-silent.mp4"
echo "$OUT $TOTAL"
