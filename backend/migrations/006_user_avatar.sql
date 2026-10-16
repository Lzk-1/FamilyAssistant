-- M4.1 用户头像（v0.9.2）
-- 与选车/选房照片一致的存储策略：文件本体落盘 data/uploads/avatars/{user_id}/{uuid}.ext，
-- 数据库仅保存相对路径（元数据），可随 data/ 整目录备份迁移。
-- 无自定义头像时 avatar_path 为空串，前端渲染「显示名首字」确定性配色默认头像。

ALTER TABLE users ADD COLUMN avatar_path TEXT NOT NULL DEFAULT '';
