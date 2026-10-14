@echo off
rem FamilyAssistant 一键启动（Windows）
cd /d "%~dp0.."

where python >nul 2>nul || (
  echo 未找到 python，请先安装 Python 3.10+ & exit /b 1
)

if not exist .venv (
  echo [1/3] 创建虚拟环境 .venv ...
  python -m venv .venv
)
call .venv\Scripts\activate.bat
echo [2/3] 安装依赖（仅 fastapi / uvicorn / python-multipart）...
pip install -q --disable-pip-version-check -r backend\requirements.txt
echo [3/3] 启动 FamilyAssistant：http://127.0.0.1:8300
python backend\main.py
