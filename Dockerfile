# FamilyAssistant 容器镜像（云服务器部署形态；单机可直接运行 scripts/start.sh）
FROM python:3.12-slim
WORKDIR /app

# 先装依赖，利用 Docker 层缓存
COPY backend/requirements.txt backend/requirements.txt
RUN pip install --no-cache-dir -r backend/requirements.txt

COPY . .
# 云部署默认对外监听；数据全部落在挂载卷 /app/data
ENV FA_HOST=0.0.0.0 FA_PORT=8300
EXPOSE 8300
CMD ["python", "backend/main.py"]
