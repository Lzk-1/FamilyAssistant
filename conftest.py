"""pytest 路径配置：将 backend/ 加入 sys.path，
使 backend 内部使用 `python backend/main.py` 风格的顶层导入（from app... / from main...）在测试中同样可用。
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent / "backend"))
