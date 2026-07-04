# 机型标签监测面板

服务器：`zz-server` (47.84.94.234)，端口 `8848`
访问：`http://47.84.94.234:8848`
部署路径：`/root/model-tag-monitor/`

## 目录结构

```
src/         后端源码
public/      前端静态文件
data/        持久化 JSON（标签库、规则、缓存的表数据、操作日志）
logs/        pm2 日志
```

## 数据源

飞书 sheets：
- Wiki node: `LaXdwebItiEBZwkr6NvcEEM0nlg`
- Obj token: `TzkVs1LVshLaZjtH1nzcG4opnxb`
- App ID: `cli_aab4e49b7bb95bd3`
- Secret 通过 lark-channel-bridge secrets get 拿

## 常用命令

```bash
# 拉最新代码到服务器
rsync -av --exclude node_modules --exclude data --exclude logs \
  /Users/lilixiaoran/工作/转转/model-tag-monitor/ \
  zz-server:/root/model-tag-monitor/

# 服务管理
ssh zz-server 'pm2 restart model-tag-monitor'
ssh zz-server 'pm2 logs model-tag-monitor'
ssh zz-server 'pm2 status'
```
