#!/usr/bin/env bash
# FamilyAssistant 一键启动（Linux / macOS）。Windows 请使用 scripts\start.bat
# 可用 PYTHON 环境变量指定解释器，如 PYTHON=python3.12 ./scripts/start.sh
set -euo pipefail
cd "$(dirname "$0")/.."

PY="${PYTHON:-python3}"
command -v "$PY" >/dev/null 2>&1 || { echo "未找到 python3，请先安装 Python 3.10+"; exit 1; }

if [ ! -d .venv ]; then
  echo "[1/3] 创建虚拟环境 .venv ..."
  "$PY" -m venv .venv
fi
# shellcheck disable=SC1091
source .venv/bin/activate
echo "[2/3] 安装依赖（仅 fastapi / uvicorn / python-multipart）..."
pip install -q --disable-pip-version-check -r backend/requirements.txt
echo "[3/3] 启动 FamilyAssistant：http://127.0.0.1:8300"
exec python backend/main.py
