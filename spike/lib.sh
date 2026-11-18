#!/usr/bin/env bash
# SC-1211 · helper compartido por los scripts del spike redroid (02 y 06).
# Prepara el checkout pineado de github.com/ayasa520/redroid-script y su venv dentro
# de $SCRATCH, y deja el cwd dentro del repo listo para ejecutar venv/bin/python redroid.py.
# Desechable: vive solo bajo spike/, no lo consume nada fuera del spike.

prepare_redroid_script() {
  local pin="$1"
  mkdir -p "$SCRATCH"
  if [ ! -d "$SCRATCH/redroid-script" ]; then
    git clone https://github.com/ayasa520/redroid-script.git "$SCRATCH/redroid-script"
  fi
  git -C "$SCRATCH/redroid-script" fetch -q origin
  git -C "$SCRATCH/redroid-script" checkout -q "$pin"
  cd "$SCRATCH/redroid-script"
  python3 -m venv venv
  venv/bin/pip install -q -r requirements.txt
}
